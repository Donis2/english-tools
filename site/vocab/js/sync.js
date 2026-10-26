// sync.js - GitHub Gist 进度同步
//
// 工作原理：
//   把本地 IndexedDB 中的 cards 表（熟练度记录）打包成 JSON，
//   存到用户的一个私有 Gist 里。多设备通过同一个 Gist ID 共享。
//
// 同步策略：
//   - 拉取（pull）：GET Gist → 合并到本地（LWW，按 lastReview 取新）
//   - 推送（push）：读本地 cards → PATCH Gist
//   - 评分后：防抖 1.5 秒自动推送
//   - 启动时：静默 pull → 合并 → 静默 push
//
// 冲突合并（LWW）：
//   对每个 word，比较 lastReview 日期，取更新的；日期相同取 proficiency 更高的；
//   firstLearned 取两边更早的（保留首次学习日期）。
//
// reviews 日志不同步（仅本地用于统计），换设备会重置，可接受。

const GIST_API = 'https://api.github.com/gists';
const SYNC_FILE_NAME = 'progress.json';
const SYNC_DEBOUNCE_MS = 1500;

const Sync = {
  state: Vue.reactive({
    configured: false,    // 是否已绑定（token + gistId 都有）
    syncing: false,       // 是否正在同步
    lastSync: null,       // 上次同步时间字符串
    error: null,          // 最近一次错误信息
    gistId: ''            // 当前 Gist ID
  }),

  _debounceTimer: null,

  // ====== 初始化（脚本加载时调用一次）======
  init() {
    const token = this._getToken();
    const gistId = this._getGistId();
    if (token && gistId) {
      this.state.configured = true;
      this.state.gistId = gistId;
    }
    try {
      const saved = localStorage.getItem('sync_last');
      if (saved) this.state.lastSync = saved;
    } catch (e) {}
  },

  // ====== 凭证存取（localStorage）======
  _getToken()   { try { return localStorage.getItem('sync_token') || ''; } catch (e) { return ''; } },
  _getGistId()  { try { return localStorage.getItem('sync_gist_id') || ''; } catch (e) { return ''; } },
  _setToken(v)  { try { if (v) localStorage.setItem('sync_token', v); else localStorage.removeItem('sync_token'); } catch (e) {} },
  _setGistId(v) { try { if (v) localStorage.setItem('sync_gist_id', v); else localStorage.removeItem('sync_gist_id'); } catch (e) {} },
  _setLastSync(v) {
    this.state.lastSync = v;
    try { localStorage.setItem('sync_last', v); } catch (e) {}
  },

  // ====== GitHub API ======

  // 统一的 fetch 封装：处理网络错误、超时、GitHub 错误响应
  async _fetch(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || 30000);
    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      if (resp.status === 401) throw new Error('Token 无效或已过期');
      if (resp.status === 403) {
        if (resp.headers.get('X-RateLimit-Remaining') === '0') {
          throw new Error('GitHub API 速率限制，请稍后再试');
        }
        throw new Error('没有权限访问（Token 可能没有 gist 权限）');
      }
      if (resp.status === 404) throw new Error('Gist 不存在或无权访问');
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error('GitHub API 错误: ' + resp.status + ' ' + errText.slice(0, 200));
      }
      return resp;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时（30 秒）');
      if (e.name === 'TypeError') throw new Error('网络连接失败，请检查网络');
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  },

  // 用已保存的 token 调用 Gist API
  async _api(method, path, body) {
    const token = this._getToken();
    if (!token) throw new Error('未配置 Token');
    const resp = await this._fetch(GIST_API + path, {
      method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    return resp.json();
  },

  // 验证 token 有效性（调 GET /user）
  async verifyToken(token) {
    const resp = await this._fetch('https://api.github.com/user', {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json'
      }
    });
    const data = await resp.json();
    return data.login;  // 返回用户名
  },

  // 用指定 token 创建新 Gist，返回 gist id
  async createGist(token, progressData) {
    const resp = await this._fetch(GIST_API, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        description: '考研词频背诵 - 进度同步',
        public: false,  // 私有 Gist
        files: {
          [SYNC_FILE_NAME]: { content: JSON.stringify(progressData, null, 2) }
        }
      })
    });
    const data = await resp.json();
    return data.id;
  },

  // 拉取 Gist 中的 progress.json，返回解析后的对象
  async fetchGist() {
    const gistId = this._getGistId();
    if (!gistId) throw new Error('未配置 Gist ID');
    const data = await this._api('GET', '/' + gistId);
    const file = data.files && data.files[SYNC_FILE_NAME];
    if (!file) throw new Error('Gist 中没有 progress.json 文件');
    return JSON.parse(file.content);
  },

  // 更新 Gist 中的 progress.json
  async updateGist(progressData) {
    const gistId = this._getGistId();
    if (!gistId) throw new Error('未配置 Gist ID');
    await this._api('PATCH', '/' + gistId, {
      files: {
        [SYNC_FILE_NAME]: { content: JSON.stringify(progressData, null, 2) }
      }
    });
  },

  // ====== 合并逻辑（LWW）======
  // 输入本地 cards 数组和远端 cards 数组，返回合并后的数组
  mergeCards(localCards, remoteCards) {
    const localMap = new Map();
    const remoteMap = new Map();
    for (const c of localCards) localMap.set(c.word, c);
    for (const c of remoteCards) remoteMap.set(c.word, c);

    const merged = [];
    const allWords = new Set([...localMap.keys(), ...remoteMap.keys()]);

    for (const word of allWords) {
      const l = localMap.get(word);
      const r = remoteMap.get(word);
      if (!l) { merged.push(r); continue; }
      if (!r) { merged.push(l); continue; }
      // 两边都有：按 lastReview 比较（字符串日期可直接比较）
      const lDate = l.lastReview || '';
      const rDate = r.lastReview || '';
      let winner;
      if (lDate > rDate) winner = l;
      else if (rDate > lDate) winner = r;
      else {
        // 日期相同，取 proficiency 更高的（乐观策略）
        winner = (l.proficiency || 0) >= (r.proficiency || 0) ? l : r;
      }
      // firstLearned 取两边更早的（保留首次学习日期）
      const firsts = [l.firstLearned, r.firstLearned].filter(Boolean).sort();
      if (firsts.length > 0) winner = { ...winner, firstLearned: firsts[0] };
      merged.push(winner);
    }
    return merged;
  },

  // ====== 临时词（tempWords）同步 ======
  // 临时词表整体采用 LWW：比较 updatedAt，取较新一方的完整列表。
  // 这样加入/移除/清空都能正确传播，且不会丢失原熟练度。

  // 构造临时词表的同步负载
  async _getTempPayload() {
    const words = await db.tempWords.toArray();
    const updatedAt = (window.DB && typeof window.DB.getTempUpdated === 'function')
      ? window.DB.getTempUpdated() : 0;
    return { words, updatedAt };
  },

  // 合并远端临时词表（仅当远端更新时才覆盖本地）
  async _mergeTemp(remoteData) {
    if (!remoteData.temp || !Array.isArray(remoteData.temp.words)) return;
    const remoteUpdated = remoteData.temp.updatedAt || 0;
    const localUpdated = (window.DB && typeof window.DB.getTempUpdated === 'function')
      ? window.DB.getTempUpdated() : 0;
    if (remoteUpdated > localUpdated) {
      await db.tempWords.clear();
      if (remoteData.temp.words.length > 0) {
        await db.tempWords.bulkPut(remoteData.temp.words);
      }
      if (window.DB && typeof window.DB.setTempUpdated === 'function') {
        window.DB.setTempUpdated(remoteUpdated);
      }
      console.log('[sync] 合并远端临时词表:', remoteData.temp.words.length, '条');
    }
  },

  // ====== 实战单词（practiceWords）同步 ======
  // 策略与临时词一致：整表 LWW，比较 practice_updated，取较新一方的完整列表。
  // 这样"在电脑上刷题收的词"能到手机上，"移除/清空"也能正确传播。

  async _getPracticePayload() {
    const words = await db.practiceWords.toArray();
    return {
      words,
      updatedAt: (window.DB && typeof window.DB.getPracticeUpdated === 'function')
        ? window.DB.getPracticeUpdated() : 0,
      clearedAt: (window.DB && typeof window.DB.getPracticeClearedAt === 'function')
        ? window.DB.getPracticeClearedAt() : 0,
      removed: (window.DB && typeof window.DB.getPracticeRemoved === 'function')
        ? window.DB.getPracticeRemoved() : {}
    };
  },

  async _mergePractice(remoteData) {
    const p = remoteData && remoteData.practice;
    if (!p || !Array.isArray(p.words)) return;
    if (!window.DB || typeof window.DB.applyPracticeRemote !== 'function') return;
    const r = await window.DB.applyPracticeRemote(p);
    if (r.added || r.updated || r.removed) {
      console.log('[sync] 合并实战单词: 新增', r.added, '更新', r.updated, '删除', r.removed);
      if (window.Store && typeof window.Store.refreshStats === 'function') {
        window.Store.refreshStats();
      }
    }
  },

  // ====== 同步流程 ======

  // 拉取云端 → 合并到本地（增量写回，只更新有变化的 card）
  // silent=true 时不设置 state.error（用于启动时静默同步）
  // 返回 { ok, merged, changed } —— changed 为实际需要写入的 card 数
  async pullAndMerge(silent = false) {
    if (!this.state.configured) return { ok: false, error: '未配置同步' };
    this.state.syncing = true;
    if (!silent) this.state.error = null;
    try {
      const remoteData = await this.fetchGist();
      const remoteCards = Array.isArray(remoteData.cards) ? remoteData.cards : [];
      const localCards = await db.cards.toArray();
      const localMap = new Map(localCards.map(c => [c.word, c]));
      const remoteWords = new Set(remoteCards.map(c => c.word));

      // 计算需要写入的 card（与本地不同才写）
      const toPut = [];
      let mergedCount = localCards.length;
      let localOnly = 0;
      for (const r of remoteCards) {
        const l = localMap.get(r.word);
        if (!l) {
          // 本地没有，新增
          toPut.push(r);
          mergedCount++;
        } else {
          // 两边都有：按 LWW 取胜者
          const winner = this._pickWinner(l, r);
          // 只有当远端取胜或字段有变化时才写
          if (winner !== l || winner.firstLearned !== l.firstLearned) {
            toPut.push(winner);
          }
        }
      }
      // 本地有但远端没有的 card（需要 push 到云端）
      for (const c of localCards) {
        if (!remoteWords.has(c.word)) localOnly++;
      }

      if (toPut.length > 0) {
        await db.cards.bulkPut(toPut);
      }

      // 合并学习队列（study_progress）：取 queueIndex 更大的（进度更靠后）
      // 仅当云端的 studyDate 是今天时才合并，否则跳过（昨天的队列没意义）
      let studyMerged = false;
      const remoteSP = remoteData.studyProgress;
      if (remoteSP && remoteSP.studyDate === DB.todayStr() && remoteSP.queue && remoteSP.queue.length > 0) {
        let localSP = null;
        try {
          const sp = localStorage.getItem('study_progress');
          if (sp) localSP = JSON.parse(sp);
        } catch (e) {}
        // 本地无，或本地 queueIndex 比云端小 → 用云端的
        if (!localSP ||
            localSP.studyDate !== remoteSP.studyDate ||
            (localSP.queueIndex || 0) < (remoteSP.queueIndex || 0)) {
          try {
            localStorage.setItem('study_progress', JSON.stringify(remoteSP));
            studyMerged = true;
          } catch (e) {
            console.warn('[sync] 保存 study_progress 失败:', e);
          }
        }
      }

      // 合并临时词表（LWW，取 updatedAt 较新者）
      await this._mergeTemp(remoteData);

      // 合并实战单词（同样的 LWW 策略）
      await this._mergePractice(remoteData);

      this._setLastSync(this._nowStr());
      return {
        ok: true,
        merged: mergedCount,
        changed: toPut.length,
        remoteCount: remoteCards.length,
        localOnly,
        studyMerged
      };
    } catch (e) {
      if (!silent) this.state.error = e.message;
      console.error('[sync] pull 失败:', e);
      return { ok: false, error: e.message };
    } finally {
      this.state.syncing = false;
    }
  },

  // LWW 仲裁：返回应保留的 card 对象
  // 规则：lastReview 更新者胜；相同日期取 proficiency 更高者；
  // firstLearned 取两边更早的（保留首次学习日期）
  _pickWinner(l, r) {
    const lDate = l.lastReview || '';
    const rDate = r.lastReview || '';
    let winner;
    if (lDate > rDate) winner = l;
    else if (rDate > lDate) winner = r;
    else winner = (l.proficiency || 0) >= (r.proficiency || 0) ? l : r;
    // firstLearned 取更早的
    const firsts = [l.firstLearned, r.firstLearned].filter(Boolean).sort();
    if (firsts.length > 0 && firsts[0] !== winner.firstLearned) {
      winner = { ...winner, firstLearned: firsts[0] };
    }
    return winner;
  },

  // 推送本地 cards 到云端
  // silent=true 时不设置 state.error
  async pushLocal(silent = false) {
    if (!this.state.configured) return { ok: false };
    // 如果正在拉取中，跳过本次推送（拉取完成后会自动 push）
    if (this.state.syncing) {
      console.log('[sync] 跳过推送（其他同步进行中）');
      return { ok: false, skipped: true };
    }
    this.state.syncing = true;
    if (!silent) this.state.error = null;
    try {
      const cards = await db.cards.toArray();
      // 同步当前学习队列（让新设备能从同一位置继续，而非从头开始）
      let studyProgress = null;
      try {
        const sp = localStorage.getItem('study_progress');
        if (sp) studyProgress = JSON.parse(sp);
      } catch (e) {}
      const data = {
        version: 2,
        syncDate: new Date().toISOString(),
        cards,
        studyProgress,
        temp: await this._getTempPayload(),
        practice: await this._getPracticePayload()
      };
      await this.updateGist(data);
      this._setLastSync(this._nowStr());
      return { ok: true, count: cards.length };
    } catch (e) {
      if (!silent) this.state.error = e.message;
      console.error('[sync] push 失败:', e);
      return { ok: false, error: e.message };
    } finally {
      this.state.syncing = false;
    }
  },

  // 手动完整同步：pull → merge → push → 刷新统计（只刷一次）
  async syncNow() {
    if (!this.state.configured) return { ok: false, error: '未配置同步' };
    const pullResult = await this.pullAndMerge();
    let pushResult;
    if (pullResult.ok) {
      // pullAndMerge 已释放 syncing 锁，可安全 push
      pushResult = await this.pushLocal();
    } else {
      pushResult = pullResult;
    }
    if (window.Store) await window.Store.refreshStats();
    return pullResult.ok ? pushResult : pullResult;
  },

  // 防抖同步（评分后调用，1.5 秒内多次评分只同步一次）
  // 流程：pull（拉取远端最新）→ merge → push（推送本地+远端合并结果）
  // 注意：评分后本地已写入，所以必须先 pull 把远端的也拉下来合并，
  //       再 push 合并结果，否则另一端的评分会被本地覆盖。
  async debouncedSync() {
    if (!this.state.configured) return;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(async () => {
      this._debounceTimer = null;
      // 先 pull：把远端的进度合并到本地（本地刚写的不会丢，LWW 取新）
      const pullResult = await this.pullAndMerge(true);
      // 再 push：把合并结果推到云端
      const pushResult = await this.pushLocal(true);
      // 如果因为同步中跳过了，1 秒后重试一次
      if (pushResult.skipped) {
        setTimeout(() => this.pushLocal(true), 1000);
      }
      // 同步完成后刷新统计（pull 可能改了 cards 表）
      if ((pullResult.ok || pushResult.ok) && window.Store) {
        await window.Store.refreshStats();
      }
    }, SYNC_DEBOUNCE_MS);
  },

  // 启动时同步：pull → 仅在有变化时 push → 刷新统计
  // 失败时通过回调通知 UI（不静默吞错），但仍然不阻塞页面渲染
  // onResult(result) 回调可选，result = { ok, error, changed, localOnly, pulled }
  async pullOnStart(onResult) {
    if (!this.state.configured) {
      if (onResult) onResult({ ok: true, skipped: true });
      return;
    }
    const pullResult = await this.pullAndMerge(true);
    if (!pullResult.ok) {
      console.warn('[sync] 启动拉取失败:', pullResult.error);
      this.state.error = pullResult.error;  // 显示在设置页
      if (onResult) onResult(pullResult);
      return;
    }
    console.log('[sync] 启动拉取完成，合并 ' + pullResult.changed + ' 张卡片，本地新增 ' + pullResult.localOnly + ' 张');
    // 只有本地有远端没有的 card 时才需要 push
    let pushOk = true;
    if (pullResult.localOnly > 0) {
      const pushResult = await this.pushLocal(true);
      pushOk = pushResult.ok;
      if (pushResult.ok) console.log('[sync] 启动推送完成');
    }
    if (window.Store) await window.Store.refreshStats();
    if (onResult) onResult({
      ok: pushOk,
      pulled: pullResult.changed,
      localOnly: pullResult.localOnly
    });
  },

  // ====== 自动同步事件监听 ======

  // 注册浏览器事件，实现"切回前台拉取 + 关闭前推送"
  // 应在 App 初始化时调用一次
  _listenersRegistered: false,
  registerAutoSync() {
    if (this._listenersRegistered) return;
    this._listenersRegistered = true;

    // 1. 页面切回前台时：拉取远端最新进度（另一设备可能改了）
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.state.configured && !this.state.syncing) {
        console.log('[sync] 页面切回前台，触发拉取');
        // 静默拉取，不推送（避免无变化时浪费请求）
        this.pullAndMerge(true).then(r => {
          if (r.ok && r.changed > 0 && window.Store) {
            window.Store.refreshStats();
          }
        });
      }
    });

    // 2. 页面关闭/隐藏前：立即推送（用 sendBeacon 或同步请求兜底）
    //    评分后 1.5 秒防抖可能没触发就关了，这里兜底
    window.addEventListener('pagehide', () => {
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
      if (this.state.configured && !this.state.syncing) {
        console.log('[sync] 页面关闭，尝试推送');
        // 用 Beacon API 异步推送，不阻塞关闭
        this._pushViaBeacon();
      }
    });

    // 3. 网络恢复时：如果之前同步失败，重试一次
    window.addEventListener('online', () => {
      if (this.state.configured && this.state.error) {
        console.log('[sync] 网络恢复，重试同步');
        this.syncNow();
      }
    });
  },

  // 用 sendBeacon 推送（页面关闭时的兜底，不阻塞）
  // 注意：sendBeacon 只能发 POST，不能发 PATCH，所以这里用 fetch + keepalive
  async _pushViaBeacon() {
    try {
      const token = this._getToken();
      const gistId = this._getGistId();
      if (!token || !gistId) return;
      const cards = await db.cards.toArray();
      let studyProgress = null;
      try {
        const sp = localStorage.getItem('study_progress');
        if (sp) studyProgress = JSON.parse(sp);
      } catch (e) {}
      const data = {
        version: 2,
        syncDate: new Date().toISOString(),
        cards,
        studyProgress,
        temp: await this._getTempPayload(),
        practice: await this._getPracticePayload()
      };
      // keepalive: true 让请求在页面关闭后仍能完成
      await fetch(GIST_API + '/' + gistId, {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          files: { [SYNC_FILE_NAME]: { content: JSON.stringify(data, null, 2) } }
        }),
        keepalive: true
      });
      this._setLastSync(this._nowStr());
    } catch (e) {
      console.warn('[sync] 关闭推送失败:', e);
    }
  },

  // ====== 绑定 / 解绑 ======

  // 首次绑定：验证 token → 创建 Gist（含当前进度）→ 保存凭证
  async bindNew(token) {
    if (!token || !token.trim()) throw new Error('请输入 Token');
    token = token.trim();
    this.state.syncing = true;
    this.state.error = null;
    try {
      const username = await this.verifyToken(token);
      const cards = await db.cards.toArray();
      const data = {
        version: 1,
        syncDate: new Date().toISOString(),
        cards,
        temp: await this._getTempPayload(),
        practice: await this._getPracticePayload()
      };
      const gistId = await this.createGist(token, data);
      this._setToken(token);
      this._setGistId(gistId);
      this.state.configured = true;
      this.state.gistId = gistId;
      this._setLastSync(this._nowStr());
      return { ok: true, username, gistId, count: cards.length };
    } catch (e) {
      this.state.error = e.message;
      throw e;
    } finally {
      this.state.syncing = false;
    }
  },

  // 新设备接入：验证 token → 保存凭证 → pull+merge → 静默 push
  async bindExisting(token, gistId) {
    if (!token || !token.trim()) throw new Error('请输入 Token');
    if (!gistId || !gistId.trim()) throw new Error('请输入 Gist ID');
    token = token.trim();
    gistId = gistId.trim();
    this.state.syncing = true;
    this.state.error = null;
    try {
      // 先验证 token
      await this.verifyToken(token);
      // 保存凭证（pullAndMerge 需要用到）
      this._setToken(token);
      this._setGistId(gistId);
      // 必须先标记 configured=true，否则 pullAndMerge 会因 configured 检查直接返回失败
      this.state.configured = true;
      this.state.gistId = gistId;
      // 拉取并合并
      const result = await this.pullAndMerge();
      if (!result.ok) {
        // 拉取失败，回滚凭证
        this._setToken('');
        this._setGistId('');
        throw new Error(result.error);
      }
      // 静默推送合并结果
      await this.pushLocal(true);
      if (window.Store) await window.Store.refreshStats();
      return { ok: true, merged: result.merged };
    } catch (e) {
      this.state.error = e.message;
      this._setToken('');
      this._setGistId('');
      this.state.configured = false;
      throw e;
    } finally {
      this.state.syncing = false;
    }
  },

  // 解绑：清除本地凭证（云端 Gist 保留，可重新接入）
  unbind() {
    this._setToken('');
    this._setGistId('');
    try { localStorage.removeItem('sync_last'); } catch (e) {}
    this.state.configured = false;
    this.state.gistId = '';
    this.state.lastSync = null;
    this.state.error = null;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  },

  // ====== 工具 ======
  _nowStr() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return DB.todayStr() + ' ' + hh + ':' + mm;
  }
};

// 脚本加载时初始化（读取 localStorage 中的凭证）
Sync.init();
window.Sync = Sync;
