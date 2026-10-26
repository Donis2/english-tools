// app.js - Vue 应用主入口

const { createApp, onMounted, ref, watch, computed } = Vue;

const app = createApp({
  setup() {
    const store = window.Store;
    const state = store.state;
    const syncState = window.Sync.state;

    // 监听同步错误：错误变化时弹 toast（让用户知道同步失败）
    watch(
      () => syncState.error,
      (newErr, oldErr) => {
        if (newErr && newErr !== oldErr) {
          showToast('同步失败: ' + newErr, 'error', 5000);
        }
      }
    );

    // 同步表单输入（两块表单共用一个 Token 输入，避免填错框）
    const syncToken = ref('');
    const syncGistId = ref('');

    // 轻量级 toast 提示（非阻塞，自动消失）
    const toast = ref({ show: false, text: '', type: 'info' });
    let toastTimer = null;
    function showToast(text, type = 'info', duration = 3000) {
      if (toastTimer) clearTimeout(toastTimer);
      toast.value = { show: true, text, type };
      toastTimer = setTimeout(() => {
        toast.value.show = false;
        toastTimer = null;
      }, duration);
    }
    // 让各组件也能用（WordList 评分后提示"实战单词保留"）
    window.showToast = showToast;

    // ====== 实战单词通道状态 ======
    // 合并版：两个页面同域，共用同一个 IndexedDB，不需要中转
    const sameSite = !window.PracticeSync;
    const practiceSync = window.PracticeSync
      ? window.PracticeSync.state
      : { channel: 'local', gistReady: false, lastPull: '', error: '' };
    const bridgeText = computed(() => {
      if (sameSite) return '同站直连（截图页与本页共用数据库）';
      if (practiceSync.channel === 'local') return '本地直连（同一台电脑）';
      if (practiceSync.channel === 'gist') return '云端 Gist（跨设备）';
      return '未连接';
    });

    // 生成一段同步码，粘贴到截图词频标注页面即可连上
    async function copyPracticeCode() {
      const code = window.PracticeSync ? window.PracticeSync.generateCode() : '';
      if (!code) {
        showToast('请先在下方绑定云端同步（需要 Gist）', 'error', 4000);
        return;
      }
      try {
        await navigator.clipboard.writeText(code);
        showToast('同步码已复制，粘贴到截图页面即可', 'success', 3500);
      } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
          showToast('同步码已复制', 'success', 3000);
        } catch (e2) {
          showToast('复制失败，请手动复制：' + code, 'error', 8000);
        }
        document.body.removeChild(ta);
      }
    }

    async function syncPracticeNow() {
      if (!window.PracticeSync) return;
      const r = await window.PracticeSync.pullAll({ force: true });
      showToast(`实战单词已刷新：新增 ${r.added}，更新 ${r.updated}`, 'info', 3000);
      if (window.PracticeSync.state.gistReady) window.PracticeSync.pushGist();
    }

    // 新建 Gist（这台设备第一次用，本机进度为源头）
    async function bindNew() {
      const token = syncToken.value.trim();
      if (!token) {
        showToast('请先输入 GitHub Token', 'error');
        return;
      }
      // 填了 Gist ID 还点「新建」是最常见的误操作：会凭空多出一个空 Gist，
      // 原进度一条都拉不下来。这里直接拦住。
      if (syncGistId.value.trim()) {
        showToast('已填 Gist ID，请点「拉取并接入」，不要新建', 'error', 6000);
        return;
      }
      const localCount = (state.stats && state.stats.total) || 0;
      if (!localCount) {
        const ok = confirm(
          '这台设备还没有任何背诵记录，新建的 Gist 会是空的。\n\n' +
          '如果你是想把其他设备已有的进度同步过来：\n' +
          '请把 Gist ID 填到上面的输入框，然后点「拉取并接入」。\n\n' +
          '确定要新建一个空 Gist 吗？'
        );
        if (!ok) return;
      }
      try {
        const result = await window.Sync.bindNew(token);
        showToast('已新建 Gist：' + result.username + ' / 上传 ' + result.count + ' 张卡片', 'success', 4000);
        syncToken.value = '';
      } catch (e) {
        showToast('绑定失败: ' + e.message, 'error', 5000);
      }
    }

    // 接入已有 Gist（其他设备建的，或重装后恢复）
    async function bindExisting() {
      if (!syncToken.value.trim() || !syncGistId.value.trim()) {
        showToast('请输入 Token 和 Gist ID', 'error');
        return;
      }
      try {
        const result = await window.Sync.bindExisting(syncToken.value, syncGistId.value);
        showToast('接入成功，合并后共 ' + result.merged + ' 张卡片', 'success', 4000);
        syncToken.value = '';
        syncGistId.value = '';
      } catch (e) {
        showToast('接入失败: ' + e.message, 'error', 5000);
      }
    }

    // 手动立即同步
    async function syncNow() {
      const result = await window.Sync.syncNow();
      if (result.ok) {
        showToast('同步成功，已推送 ' + result.count + ' 张卡片', 'success');
      } else if (result.skipped) {
        showToast('同步进行中，请稍后', 'info');
      } else {
        showToast('同步失败: ' + (result.error || '未知错误'), 'error', 5000);
      }
    }

    // 退出同步（仅清除本地凭证，云端 Gist 保留）
    function unbindSync() {
      if (confirm('退出同步会清除本设备的同步凭证（Token 和 Gist ID）。云端进度保留，可随时重新接入。确定继续吗？')) {
        window.Sync.unbind();
        showToast('已退出同步', 'info');
      }
    }

    function navigate(page) {
      store.navigate(page);
    }

    function backToDashboard() {
      store.navigate('dashboard');
    }

    // Dashboard 事件
    function onStudy() {
      store.navigate('study');
    }

    // 复制 Gist ID 到剪贴板
    async function copyGistId() {
      const id = window.Sync.state.gistId;
      if (!id) return;
      try {
        await navigator.clipboard.writeText(id);
        showToast('Gist ID 已复制', 'success', 2000);
      } catch (e) {
        // clipboard API 在非 HTTPS 或旧浏览器可能失败，fallback 到 textarea
        const ta = document.createElement('textarea');
        ta.value = id;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
          showToast('Gist ID 已复制', 'success', 2000);
        } catch (e2) {
          showToast('复制失败，请手动选中复制', 'error', 3000);
        }
        document.body.removeChild(ta);
      }
    }

    async function onReview() {
      store.navigate('review');
    }

    async function onWordList(prof) {
      store.state.wordListProf = prof;
      await store.loadWordList(prof);
      store.navigate('wordlist');
    }

    async function openPracticeList() {
      await store.loadWordList('practice');
      store.navigate('wordlist');
    }

    // 设置
    function updateSetting(key, value) {
      store.updateSetting(key, value);
    }

    async function resetProgress() {
      if (confirm('确定要清空所有学习进度吗？此操作不可撤销！')) {
        await store.resetAll();
        showToast('学习进度已重置', 'info');
      }
    }

    // 导出学习数据为 JSON 文件下载
    async function exportProgress() {
      try {
        const data = await DB.exportData();
        const json = JSON.stringify(data);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `danci-backup-${DB.todayStr()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(`导出成功：${data.cards.length} 张卡片，${data.reviews.length} 条复习日志`, 'success', 4000);
      } catch (e) {
        showToast('导出失败: ' + e.message, 'error', 5000);
      }
    }

    // 触发文件选择
    function triggerImport() {
      document.getElementById('import-file-input').click();
    }

    // 从文件导入学习数据
    async function importProgress(event) {
      const file = event.target.files[0];
      if (!file) return;
      if (!confirm('导入会覆盖当前所有学习进度，确定继续吗？')) {
        event.target.value = '';
        return;
      }
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await DB.importData(data);
        await store.refreshStats();
        showToast(`导入成功：${data.cards.length} 张卡片，${data.reviews.length} 条复习日志`, 'success', 4000);
      } catch (e) {
        showToast('导入失败: ' + e.message, 'error', 5000);
      }
      event.target.value = '';
    }

    onMounted(async () => {
      // 先把进来时的 hash 记下来：下面 replaceState 会把它改掉
      const entryHash = (location.hash || '').replace('#', '');
      // 注册浏览器历史回退监听（物理返回键 → 回到上一页）
      if (typeof window !== 'undefined') {
        // 初始进入时用 replaceState 占位，避免回退栈污染
        if (typeof history !== 'undefined') {
          history.replaceState({ page: 'dashboard' }, '', '#dashboard');
        }
        window.addEventListener('popstate', (event) => {
          store._onPopState(event);
        });
      }
      // 注册自动同步事件监听（切前台拉取 + 关闭前推送 + 网络恢复重试）
      if (window.Sync && typeof window.Sync.registerAutoSync === 'function') {
        window.Sync.registerAutoSync();
      }
      await store.init();
      // 实战单词接收通道（独立部署时才需要；合并版同域直连，PracticeSync 不存在）
      if (window.PracticeSync) window.PracticeSync.start();

      // 从首页 / 截图页直达实战单词：/vocab/#practice
      if (entryHash === 'practice') {
        await store.loadWordList('practice');
        store.navigate('wordlist', true);
        try { history.replaceState({ page: 'wordlist' }, '', '#wordlist'); } catch (e) {}
      }

      // 已经在这个页面里时再改 hash（比如从浏览器收藏点 #practice），不会重新加载，
      // 所以单独监听一次。
      window.addEventListener('hashchange', async () => {
        if (location.hash === '#practice' && store.state.wordListProf !== 'practice') {
          await store.loadWordList('practice');
          store.navigate('wordlist', true);
        }
      });
    });

    return {
      state,
      syncState,
      toast,
      syncToken,
      syncGistId,
      navigate,
      backToDashboard,
      onStudy,
      onReview,
      onWordList,
      openPracticeList,
      updateSetting,
      resetProgress,
      exportProgress,
      triggerImport,
      importProgress,
      bindNew,
      bindExisting,
      syncNow,
      unbindSync,
      copyGistId,
      practiceSync,
      bridgeText,
      copyPracticeCode,
      syncPracticeNow
    };
  },
  template: `
    <div id="app">
      <!-- Toast 提示（非阻塞，自动消失） -->
      <transition name="toast">
        <div v-if="toast.show" class="toast" :class="'toast-' + toast.type">
          {{ toast.text }}
        </div>
      </transition>

      <!-- 加载中 -->
      <div v-if="!state.initialized" style="display:flex;justify-content:center;align-items:center;min-height:100vh;">
        <div style="text-align:center;color:var(--text-light);">
          <div style="font-size:24px;margin-bottom:8px;">📚</div>
          <div>加载中...</div>
        </div>
      </div>

      <template v-else>
        <!-- 顶部导航 -->
        <nav class="nav">
          <div class="nav-title">考研词频背诵</div>
          <div class="nav-tabs">
            <span v-if="syncState.configured && syncState.syncing" class="sync-indicator" title="正在与 GitHub Gist 同步">⟳ 同步中</span>
            <a class="nav-tab nav-home" href="../" title="返回导航首页">← 主页</a>
            <button class="nav-tab"
                    :class="{ active: state.currentPage === 'dashboard' }"
                    @click="navigate('dashboard')">
              首页
            </button>
            <button class="nav-tab"
                    :class="{ active: state.currentPage === 'settings' }"
                    @click="navigate('settings')">
              设置
            </button>
          </div>
        </nav>

        <!-- 页面内容 -->
        <dashboard v-if="state.currentPage === 'dashboard'"
                   @study="onStudy"
                   @review="onReview"
                   @wordlist="onWordList">
        </dashboard>

        <card-view v-else-if="state.currentPage === 'study'"
                   @back="backToDashboard">
        </card-view>

        <review-view v-else-if="state.currentPage === 'review'"
                     @back="backToDashboard">
        </review-view>

        <word-list v-else-if="state.currentPage === 'wordlist'"
                   @back="backToDashboard">
        </word-list>

        <div v-else-if="state.currentPage === 'settings'" class="settings-group">
          <h3>显示设置</h3>
          <div class="setting-row">
            <label>释义对齐方式</label>
            <div style="display:flex;gap:6px;">
              <button class="nav-tab"
                      :style="{ background: state.settings.defAlign === 'left' ? 'var(--accent)' : '#edf2f7', color: state.settings.defAlign === 'left' ? 'white' : 'var(--primary)' }"
                      @click="updateSetting('defAlign', 'left')">
                左对齐
              </button>
              <button class="nav-tab"
                      :style="{ background: state.settings.defAlign === 'center' ? 'var(--accent)' : '#edf2f7', color: state.settings.defAlign === 'center' ? 'white' : 'var(--primary)' }"
                      @click="updateSetting('defAlign', 'center')">
                居中
              </button>
            </div>
          </div>

          <h3 style="margin-top:20px;">数据统计</h3>
          <div class="setting-row">
            <label>总词数</label>
            <span>{{ state.stats.total }}</span>
          </div>
          <div class="setting-row">
            <label>已学习</label>
            <span>{{ state.stats.learned }}</span>
          </div>
          <div class="setting-row">
            <label>完全记住</label>
            <span>{{ state.stats.byProficiency[6] || 0 }}</span>
          </div>
          <div class="setting-row">
            <label>正常记住</label>
            <span>{{ state.stats.byProficiency[5] || 0 }}</span>
          </div>
          <div class="setting-row">
            <label>勉强记住</label>
            <span>{{ state.stats.byProficiency[4] || 0 }}</span>
          </div>
          <div class="setting-row">
            <label>看了才记住</label>
            <span>{{ state.stats.byProficiency[3] || 0 }}</span>
          </div>
          <div class="setting-row">
            <label>熟悉但不记得</label>
            <span>{{ state.stats.byProficiency[2] || 0 }}</span>
          </div>
          <div class="setting-row">
            <label>完全不熟悉</label>
            <span>{{ state.stats.byProficiency[1] || 0 }}</span>
          </div>

          <h3 style="margin-top:20px;">云端同步</h3>

          <!-- 未配置：显示绑定表单（Token 与 Gist ID 合在一处，避免填错框） -->
          <template v-if="!syncState.configured">
            <div class="sync-block">
              <div class="sync-block-title">连接云端同步</div>
              <input class="sync-input" v-model="syncToken" type="password"
                     placeholder="GitHub Token（需要 gist 权限）" />
              <input class="sync-input" v-model="syncGistId"
                     placeholder="Gist ID —— 已有进度时必填（32 位十六进制）" />
              <div class="sync-actions">
                <button class="btn-primary" style="width:auto;padding:8px 14px;font-size:13px;"
                        @click="bindExisting" :disabled="syncState.syncing">
                  {{ syncState.syncing ? '同步中...' : '拉取并接入（推荐）' }}
                </button>
                <button class="btn-secondary" style="width:auto;padding:8px 14px;font-size:13px;"
                        @click="bindNew" :disabled="syncState.syncing">
                  新建 Gist
                </button>
              </div>
              <div class="sync-warn">
                <b>已有进度</b>（换设备 / 换了网址 / 重装浏览器）→ 填 Gist ID，点「拉取并接入」，云端记录会合并到本机。<br>
                <b>新建 Gist</b> 只用于第一次启用同步：它会把<b>本机</b>进度写成一份新的云端记录，
                不会去拉旧 Gist 里的任何东西。
              </div>
            </div>

            <div class="sync-tip">
              Token 申请：GitHub Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token，勾选 <code>gist</code> 权限即可。
              Token 仅存在本设备 localStorage，不会上传到任何服务器。
            </div>
          </template>

          <!-- 已配置：显示状态和操作 -->
          <template v-else>
            <div class="setting-row">
              <label>Gist ID</label>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span style="font-family:monospace;font-size:12px;word-break:break-all;">{{ syncState.gistId }}</span>
                <button class="btn-small" @click="copyGistId" style="padding:4px 10px;font-size:11px;">复制</button>
              </div>
            </div>
            <div class="setting-row">
              <label>上次同步</label>
              <span>{{ syncState.lastSync || '从未' }}</span>
            </div>
            <div class="setting-row">
              <label>当前状态</label>
              <span>{{ syncState.syncing ? '同步中...' : (syncState.error ? '错误' : '已就绪') }}</span>
            </div>
            <div v-if="syncState.error" class="sync-error">{{ syncState.error }}</div>
            <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
              <button class="btn-secondary" style="width:auto;padding:8px 14px;font-size:13px;"
                      @click="syncNow" :disabled="syncState.syncing">
                {{ syncState.syncing ? '同步中...' : '立即同步' }}
              </button>
              <button class="btn-danger" style="width:auto;padding:8px 14px;font-size:13px;"
                      @click="unbindSync">
                退出同步
              </button>
            </div>
            <div class="sync-tip" style="margin-top:10px;">
              评分后会自动同步（防抖 1.5 秒）。打开 App 时会自动拉取云端最新进度。
            </div>
          </template>

          <h3 style="margin-top:20px;">实战单词</h3>
          <div class="setting-row">
            <label>接收方式</label>
            <span>{{ bridgeText }}</span>
          </div>
          <div class="sync-tip" style="margin-top:8px;">
            回到首页进入「截图词频标注」，点单词旁边的 ＋，这里就会多一条。同一个词反复添加只累计次数，不会重复显示。
          </div>
          <div style="margin-top:10px;">
            <button class="btn-secondary" style="width:auto;padding:8px 14px;font-size:13px;" @click="openPracticeList">打开实战单词</button>
          </div>

          <h3 style="margin-top:20px;">数据管理</h3>
          <div class="setting-row">
            <label>导入 / 导出学习进度</label>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button class="btn-secondary" style="width:auto;padding:8px 14px;font-size:13px;" @click="exportProgress">
                导出
              </button>
              <button class="btn-secondary" style="width:auto;padding:8px 14px;font-size:13px;" @click="triggerImport">
                导入
              </button>
            </div>
          </div>
          <input type="file" id="import-file-input" accept=".json" style="display:none;" @change="importProgress">

          <div style="margin-top:20px;">
            <button class="btn-danger" @click="resetProgress">
              重置所有进度
            </button>
          </div>
        </div>
      </template>
    </div>
  `
});

// 注册组件
app.component('dashboard', window.Dashboard);
app.component('card-view', window.CardView);
app.component('review-view', window.ReviewView);
app.component('word-list', window.WordList);

// 挂载
app.mount('#app');
