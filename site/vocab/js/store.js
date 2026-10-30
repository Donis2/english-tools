// store.js - 全局状态管理

const { reactive } = Vue;

// 从 localStorage 恢复今日学习进度
function loadStudyProgress() {
  try {
    const saved = localStorage.getItem('study_progress');
    if (!saved) return null;
    const data = JSON.parse(saved);
    const today = DB.todayStr();
    if (data.studyDate === today && data.queue && data.queue.length > 0) {
      return data;
    }
    return null;
  } catch (e) {
    console.warn('[store] 恢复学习进度失败:', e);
    return null;
  }
}

function saveStudyProgress(state) {
  try {
    localStorage.setItem('study_progress', JSON.stringify({
      studyDate: state.studyDate,
      queue: state.queue,
      queueIndex: state.queueIndex
    }));
  } catch (e) {
    console.warn('[store] 保存学习进度失败:', e);
  }
}

function clearStudyProgress() {
  try { localStorage.removeItem('study_progress'); } catch (e) {}
}

// 解析粘贴进来的实战单词：优先按 JSON 理解（截图工具复制的格式），
// 否则当成纯文本，按空格/逗号/换行切词。
function parsePracticePayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  try {
    const data = JSON.parse(raw);
    const arr = Array.isArray(data)
      ? data
      : (Array.isArray(data.words) ? data.words : (data.word ? [data] : null));
    if (Array.isArray(arr)) {
      return arr
        .map(x => (typeof x === 'string' ? { word: x } : (x || {})))
        .filter(x => x.word && String(x.word).trim());
    }
  } catch (e) { /* 不是 JSON，走纯文本 */ }

  const out = [];
  for (const token of raw.split(/[\s,;、，；]+/)) {
    const word = token.replace(/[^A-Za-z'-]/g, '').trim();
    if (!word) continue;
    out.push({ word });   // 重复出现就按多次计算，和"每次点击 +1"一致
  }
  return out;
}

const Store = {
  state: reactive({
    currentPage: 'dashboard',
    initialized: false,
    totalWords: 0,

    // 主任务队列（init 时从 localStorage 恢复，初始为空）
    queue: [],
    queueIndex: 0,
    dailyTask: null,
    studyDate: '',

    currentCard: null,
    flipped: false,

    reviewTask: null,
    reviewQueue: [],
    reviewIndex: 0,

    wordListProf: null,

    stats: { total: 0, learned: 0, byProficiency: {} },
    coverage: { coveredCount: 0, totalFrequency: 0, coveragePercent: 0 },
    tempCount: 0,
    practiceCount: 0,

    settings: {
      defAlign: (function() { try { return localStorage.getItem('setting_defAlign') || 'center'; } catch(e) { return 'center'; } })()
    }
  }),

  async init() {
    try {
      console.log('[store] 开始初始化...');
      this.state.totalWords = await DB.initWordsData();
      // 修复旧版遗留的非法熟练度（把"临时"错存进 cards 的历史脏数据）
      await DB.repairInvalidProficiency();
      await this.refreshStats();

      // 初始化完成后，恢复今日学习进度（不在顶层调用，避免加载顺序问题）
      const saved = loadStudyProgress();
      if (saved) {
        this.state.queue = saved.queue;
        this.state.queueIndex = saved.queueIndex;
        this.state.studyDate = saved.studyDate;
        if (this.state.queueIndex < this.state.queue.length) {
          await this.loadCurrentCard();
        }
        console.log('[store] 恢复进度:', this.state.queueIndex + 1, '/', this.state.queue.length);
      }

      // 先标记初始化完成，让用户立即看到首页（不阻塞 UI）
      this.state.initialized = true;
      console.log('[store] 初始化完成');

      // 异步触发云端同步，不阻塞页面渲染
      // 同步完成后：如果拉到了远端 study_progress，重新加载到 state
      if (window.Sync) {
        window.Sync.pullOnStart((result) => {
          if (!result.ok) {
            console.warn('[store] 启动同步失败:', result.error);
            return;
          }
          // 如果拉到了远端学习队列（study_progress），重新加载到 state
          // 这样用户点"开始今日学习"时能从云端的位置继续
          if (result.studyMerged) {
            console.log('[store] 同步拉取到远端学习队列，重新加载到 state');
            const sp = loadStudyProgress();
            if (sp) {
              this.state.queue = sp.queue;
              this.state.queueIndex = sp.queueIndex;
              this.state.studyDate = sp.studyDate;
              if (this.state.currentPage === 'study' && this.state.queueIndex < this.state.queue.length) {
                this.loadCurrentCard();
              }
            }
          }
          // 同步成功且拉到了远端数据：如果用户已进入学习/复习页，刷新统计
          if (result.pulled > 0 || result.studyMerged) {
            this._refreshCurrentQueue();
          }
        }).catch(e => {
          console.warn('[store] 启动同步异常:', e);
        });
      }
    } catch (e) {
      console.error('[store] 初始化失败:', e);
      this.state.initialized = true;
    }
  },

  // 同步后刷新当前学习/复习队列（让云端拉来的进度反映到 UI）
  // 保留 queueIndex 不变（用户不会被打断），只更新卡片数据
  _refreshCurrentQueue() {
    if (this.state.currentPage === 'study' && this.state.queue.length > 0) {
      // 重建当日队列会丢失进度，这里只刷新当前卡片的数据
      // 实际上 cards 表的变化会通过 refreshStats 反映在统计数字上
      // 队列中的卡片数据已固定（words 表），不需要重建
      // 仅刷新统计即可
      this.refreshStats();
    } else if (this.state.currentPage === 'review' && this.state.reviewQueue.length > 0) {
      this.refreshStats();
    } else {
      this.refreshStats();
    }
  },

  updateSetting(key, value) {
    this.state.settings[key] = value;
    if (key === 'defAlign') { try { localStorage.setItem('setting_defAlign', value); } catch(e){} }
  },

  async refreshStats() {
    const s = await DB.getStats();
    this.state.stats = s.stats;
    this.state.coverage = s.coverage;
    this.state.tempCount = s.tempCount;
    this.state.practiceCount = s.practiceCount;
  },

  async startStudy() {
    const today = DB.todayStr();

    // 开始学习前先拉取云端最新进度（确保多设备进度一致）
    if (window.Sync && window.Sync.state.configured && !window.Sync.state.syncing) {
      console.log('[store] startStudy 前先拉取云端');
      const r = await window.Sync.pullAndMerge(true);
      // 如果拉到了远端 study_progress，重新加载到 state
      if (r.ok && r.studyMerged) {
        const sp = loadStudyProgress();
        if (sp) {
          this.state.queue = sp.queue;
          this.state.queueIndex = sp.queueIndex;
          this.state.studyDate = sp.studyDate;
        }
      }
    }

    console.log('[store] startStudy 调用, today:', today,
      'state.studyDate:', this.state.studyDate,
      'state.queue.length:', this.state.queue.length,
      'state.queueIndex:', this.state.queueIndex);

    // 同一天内，队列还在且未完成，直接恢复进度（不重建队列）
    if (this.state.studyDate === today &&
        this.state.queue.length > 0 &&
        this.state.queueIndex < this.state.queue.length) {
      console.log('[store] 恢复今日学习进度:', this.state.queueIndex + 1, '/', this.state.queue.length);
      await this.loadCurrentCard();
      return true;
    }

    // 防御：如果 state 没恢复但 localStorage 有，先从 localStorage 恢复
    const saved = loadStudyProgress();
    if (saved && saved.studyDate === today &&
        saved.queue && saved.queue.length > 0 &&
        saved.queueIndex < saved.queue.length) {
      console.log('[store] state 未恢复，从 localStorage 恢复:', saved.queueIndex + 1, '/', saved.queue.length);
      this.state.queue = saved.queue;
      this.state.queueIndex = saved.queueIndex;
      this.state.studyDate = saved.studyDate;
      await this.loadCurrentCard();
      return true;
    }

    console.log('[store] 构建新队列（首次开始或新的一天）');
    // 新的一天，或已完成，或首次开始：构建新队列
    const task = await Scheduler.getDailyTask();
    this.state.dailyTask = task;
    this.state.studyDate = today;
    this.state.queue = Scheduler.buildStudyQueue(task.newWords, task.reviewWords);
    this.state.queueIndex = 0;
    this.state.flipped = false;
    await this.loadCurrentCard();
    saveStudyProgress(this.state);
    return this.state.queue.length > 0;
  },

  async loadCurrentCard() {
    if (this.state.queueIndex >= this.state.queue.length) {
      this.state.currentCard = null;
      clearStudyProgress();
      return;
    }
    this.state.currentCard = this.state.queue[this.state.queueIndex];
    this.state.flipped = false;
  },

  flip() {
    this.state.flipped = !this.state.flipped;
  },

  async rateCard(proficiency) {
    if (!this.state.currentCard) return;
    const word = this.state.currentCard.wordData.word;
    await DB.setProficiency(word, proficiency);
    this.state.queueIndex++;
    await this.loadCurrentCard();
    await this.refreshStats();
    saveStudyProgress(this.state);
  },

  // 加入临时并前进（不评分、不改原熟练度，仅复制进临时列表）
  async rateCardTemp() {
    if (!this.state.currentCard) return;
    const word = this.state.currentCard.wordData.word;
    await DB.addTempWord(word);
    this.state.queueIndex++;
    await this.loadCurrentCard();
    await this.refreshStats();
    saveStudyProgress(this.state);
  },

  async skipCard() {
    // 标记当前词为"已见过"，让其他设备不再把它当新词
    if (this.state.currentCard) {
      const word = this.state.currentCard.wordData.word;
      await DB.markSeen(word);
    }
    this.state.queueIndex++;
    await this.loadCurrentCard();
    saveStudyProgress(this.state);
  },

  async prevCard() {
    if (this.state.queueIndex > 0) {
      this.state.queueIndex--;
      await this.loadCurrentCard();
      saveStudyProgress(this.state);
    }
  },

  async startReview(proficiencies) {
    const reviewTask = await Scheduler.getReviewTask();
    this.state.reviewTask = reviewTask;

    const allWords = [];
    for (const prof of proficiencies) {
      for (const w of reviewTask[prof] || []) {
        allWords.push({ type: 'review', wordData: w });
      }
    }

    if (allWords.length === 0) {
      return false;
    }

    this.state.reviewQueue = allWords;
    this.state.reviewIndex = 0;
    return true;
  },

  async loadWordList(proficiency) {
    this.state.wordListProf = proficiency;
    let list;
    if (proficiency === 'temp') {
      list = await DB.getTempWords();
    } else if (proficiency === 'practice') {
      list = await DB.getPracticeWords();
    } else if (proficiency === 0) {
      list = await DB.getUnlearnedWords(200);
    } else {
      const cards = await DB.getCardsByProficiency(proficiency);
      list = await DB.getWordsByNames(cards.map(c => c.word));
    }

    // 其他词表也标出「这个单词进过实战单词」，次数取实战表的累计值
    if (proficiency !== 'practice') {
      const counts = await DB.getPracticeCounts();
      list = list.map(w => ({
        ...w,
        practiceCount: counts[DB.normalizePracticeWord(w.word)] || 0
      }));
    }

    this.state.wordList = list;
  },

  async changeProficiency(word, newProf) {
    await DB.setProficiency(word, newProf);
    await this.refreshStats();
    if (this.state.wordListProf !== null) {
      await this.loadWordList(this.state.wordListProf);
    }
  },

  // 加入临时（复制语义，原熟练度不变）
  async addToTemp(word) {
    await DB.addTempWord(word);
    await this.refreshStats();
  },

  // 从临时移除单个单词
  async removeFromTemp(word) {
    await DB.removeTempWord(word);
    await this.refreshStats();
    if (this.state.wordListProf === 'temp') {
      await this.loadWordList('temp');
    }
  },

  // 清空全部临时词
  async clearTemp() {
    await DB.clearTempWords();
    await this.refreshStats();
    if (this.state.wordListProf === 'temp') {
      await this.loadWordList('temp');
    }
  },

  // ====== 实战单词 ======
  // 评分同样是"复制"：只写 cards 表，实战单词这条记录不动，词不会从列表消失。
  async rateInPractice(word, prof) {
    await DB.setProficiency(word, prof);
    await this.refreshStats();
    // 重新读一次列表，让"已记入 X"的徽标刷新；排序按最近添加，位置不变
    if (this.state.wordListProf === 'practice') {
      await this.loadWordList('practice');
    }
  },

  async addPracticeWord(word, meta) {
    const rec = await DB.addPracticeWord(word, meta);
    await this.refreshStats();
    if (this.state.wordListProf === 'practice') {
      await this.loadWordList('practice');
    }
    return rec;
  },

  async removeFromPractice(word) {
    await DB.removePracticeWord(word);
    await this.refreshStats();
    if (this.state.wordListProf === 'practice') {
      await this.loadWordList('practice');
    }
  },

  async clearPractice() {
    await DB.clearPracticeWords();
    await this.refreshStats();
    if (this.state.wordListProf === 'practice') {
      await this.loadWordList('practice');
    }
  },

  // 粘贴导入：接受截图工具复制的 JSON，也接受一行一个词的纯文本
  async importPracticeText(text) {
    const words = parsePracticePayload(text);
    if (words.length === 0) return { added: 0 };
    const seen = new Set();
    for (const item of words) {
      await DB.addPracticeWord(item.word, { ...item, source: item.source || '粘贴导入' });
      seen.add(DB.normalizePracticeWord(item.word));
    }
    await this.refreshStats();
    if (this.state.wordListProf === 'practice') {
      await this.loadWordList('practice');
    }
    return { added: seen.size };
  },

  // 导航到指定页面，同时更新浏览器历史（让物理返回键能回退）
  // - skipHistory=true 时不 pushState（用于 popstate 回调中避免循环）
  // - dashboard 是根页面：若从 dashboard 到 dashboard，不重复 push
  navigate(page, skipHistory = false) {
    const prev = this.state.currentPage;
    this.state.currentPage = page;

    // 更新历史栈
    if (!skipHistory && typeof history !== 'undefined') {
      if (prev === page) {
        // 同页跳转：仅 replace 防止状态丢失
        history.replaceState({ page }, '', '#' + page);
      } else {
        history.pushState({ page }, '', '#' + page);
      }
    }
  },

  // 处理浏览器后退/前进：仅更新当前页，不再改 history
  _onPopState(event) {
    const page = (event.state && event.state.page) || 'dashboard';
    this.state.currentPage = page;
  },

  async resetAll() {
    await DB.resetProgress();
    await this.refreshStats();
    this.state.queue = [];
    this.state.queueIndex = 0;
    this.state.currentCard = null;
    this.state.studyDate = '';
    clearStudyProgress();
  },

  // 导出今日学习的所有新词（firstLearned === today）
  // 即使今日任务已完成（queue 已清空），仍可从 cards 表查到
  async exportTodayWords() {
    const today = DB.todayStr();
    const cards = await db.cards.where('firstLearned').equals(today).toArray();
    if (cards.length === 0) return null;

    const cardByWord = new Map(cards.map(c => [c.word, c]));
    const words = (await DB.getWordsByNames(cards.map(c => c.word))).map(w => ({
      word: w.word,
      rank: w.rank,
      frequency: w.frequency,
      definition: w.definition,
      variant: w.variant,
      category: w.category,
      subcategory: w.subcategory,
      proficiency: cardByWord.get(w.word).proficiency
    }));
    // 按词频排名升序（高频词在前）
    words.sort((a, b) => (a.rank || 0) - (b.rank || 0));
    return { date: today, words };
  },

  // 按熟练度导出单词：返回按熟练度分组的单词数据
  // profs: 要导出的熟练度数组，如 [1, 2, 3] 或 [1,2,3,4,5,6]
  async exportWordsByProficiency(profs) {
    const result = {};
    for (const prof of profs) {
      const cards = await db.cards.where('proficiency').equals(prof).toArray();
      const cardByWord = new Map(cards.map(c => [c.word, c]));
      const words = (await DB.getWordsByNames(cards.map(c => c.word))).map(w => {
        const card = cardByWord.get(w.word);
        return {
          word: w.word,
          rank: w.rank,
          frequency: w.frequency,
          definition: w.definition,
          variant: w.variant,
          category: w.category,
          subcategory: w.subcategory,
          proficiency: card.proficiency,
          firstLearned: card.firstLearned,
          lastReview: card.lastReview
        };
      });
      // 按词频排名升序
      words.sort((a, b) => (a.rank || 0) - (b.rank || 0));
      result[prof] = words;
    }
    return result;
  }
};

window.Store = Store;
