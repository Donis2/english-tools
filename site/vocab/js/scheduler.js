// scheduler.js - 每日任务调度
//
// 规则（按需求文档）：
//   每天任务 = 50 个新词（按词频从高到低） + 随机 30 个昨天不会的词
//   第二任务 = 看熟练度为 1/2/3/4 的词表（勉强记住/看了才记住/熟悉但不记得/完全不熟悉）

const SCHEDULER_CONFIG = {
  newPerDay: 50,           // 每日新词数
  reviewFromYesterday: 30  // 从昨天不会的词里随机抽 30 个
};

// ====== 主任务：每日新词 + 昨天不会的 ======

async function getDailyTask() {
  // 1. 获取 50 个新词（按词频从高到低）
  const newWords = await DB.getUnlearnedWords(SCHEDULER_CONFIG.newPerDay);

  // 2. 获取昨天不会的词，随机抽 30 个
  const forgotten = await DB.getYesterdayForgotten();
  const forgottenWords = [];
  for (const card of forgotten) {
    const wordData = await db.words.where('word').equals(card.word).first();
    if (wordData) forgottenWords.push(wordData);
  }

  // 随机抽 30 个（如果不够 30 个就全取）
  const reviewWords = shuffle(forgottenWords).slice(0, SCHEDULER_CONFIG.reviewFromYesterday);

  return {
    newWords,      // 新词（按词频降序）
    reviewWords,   // 昨天不会的随机 30 个
    total: newWords.length + reviewWords.length
  };
}

// ====== 第二任务：复习 4 个熟练度词表 ======
// 熟练度 1-4：完全不熟悉/熟悉但不记得/看了才记住/勉强记住

async function getReviewTask() {
  const result = { 1: [], 2: [], 3: [], 4: [] };
  for (const prof of [1, 2, 3, 4]) {
    const cards = await DB.getCardsByProficiency(prof);
    for (const card of cards) {
      const wordData = await db.words.where('word').equals(card.word).first();
      if (wordData) result[prof].push(wordData);
    }
  }
  return result;
}

// ====== 构建学习队列 ======

function buildStudyQueue(newWords, reviewWords) {
  const queue = [];

  // 新词在前（按词频降序）
  for (const w of newWords) {
    queue.push({ type: 'new', wordData: w });
  }
  // 复习词在后（已随机）
  for (const w of reviewWords) {
    queue.push({ type: 'review', wordData: w });
  }

  return queue;
}

// ====== 工具函数 ======

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 导出全局
window.Scheduler = {
  CONFIG: SCHEDULER_CONFIG,
  getDailyTask,
  getReviewTask,
  buildStudyQueue
};
