// db.js - IndexedDB 数据库封装（基于 Dexie.js）
// 三张表：words（词频数据，只读）、cards（学习卡片，含熟练度）、reviews（复习日志）

const DB_NAME = 'vocab-pwa-v2';

// 词库路径按脚本自身位置解析。db.js 在 js/ 下，词库在 data/ 下；
// 直接写 'data/...' 时首页（/）会请求成 /data/... 而 404，只有背诵页（/vocab/）碰巧对。
const DB_SCRIPT_SRC = (document.currentScript && document.currentScript.src) || '';
const WORDS_DATA_URL = DB_SCRIPT_SRC
  ? new URL('../data/netem_full_list.json', DB_SCRIPT_SRC).href
  : 'data/netem_full_list.json';

const db = new Dexie(DB_NAME);

db.version(1).stores({
  // words: 词频数据，从 netem_full_list.json 导入
  words: 'rank, word, frequency, category, subcategory',

  // cards: 每个单词的学习卡片
  // proficiency: 0=未学习 1=完全不熟悉 2=熟悉但是不记得 3=看了才记住
  //              4=勉强记住 5=正常记住 6=完全记住
  // lastReview: 上次复习日期 (YYYY-MM-DD)
  // firstLearned: 首次学习日期 (YYYY-MM-DD)
  cards: 'word, proficiency, lastReview, firstLearned',

  // reviews: 每次复习的日志记录
  reviews: '++id, word, proficiency, date'
});

// v2：新增 tempWords 表（临时词，复制语义，独立于 cards 表）
db.version(2).stores({
  tempWords: 'word, addedAt'
});

// v3：新增 practiceWords 表（实战单词，来源是「截图词频标注」）
// addCount 记录累计添加次数（同一个词可以反复添加，只累计不改熟练度）
db.version(3).stores({
  practiceWords: 'word, addCount, firstAddedAt, lastAddedAt'
});

// ====== 多副本共存保护 ======
// 如果同一个 origin（例如两个副本都在 localhost:8090）下开了多个标签页，
// 旧标签页会持有旧版本的数据库连接，新标签页的版本升级就会一直挂起，
// 页面表现就是永远停在「加载中」。这里主动暴露状态，让 UI 能给出提示。
db.on('blocked', function () {
  console.warn('[db] 数据库升级被阻塞：有其它标签页正在使用旧版本数据库');
  window.__dbBlocked = true;
  if (typeof window.__onDbBlocked === 'function') window.__onDbBlocked();
});

// 反过来，本页被更新版本要求让路时，主动断开连接，避免把新页面堵死
db.on('versionchange', function () {
  console.log('[db] 检测到新版本，关闭当前连接以放行升级');
  try { db.close(); } catch (e) {}
  window.__dbSuperseded = true;
});

// ====== 数据初始化 ======

async function initWordsData() {
  const count = await db.words.count();
  if (count > 0) {
    console.log(`[db] words 表已有 ${count} 条，跳过导入`);
    return count;
  }

  console.log('[db] 首次启动，开始导入词频数据...');
  const resp = await fetch(WORDS_DATA_URL);
  if (!resp.ok) throw new Error('词库加载失败：HTTP ' + resp.status + '（' + WORDS_DATA_URL + '）');
  const raw = await resp.json();

  const key = Object.keys(raw)[0];
  const rows = raw[key];

  const words = rows.map(r => ({
    rank: r['序号'],
    frequency: r['词频'],
    word: r['单词'],
    definition: r['释义'] || '',
    variant: r['其他拼写'] || '',
    category: r['分类'] || '',
    subcategory: r['子分类'] || ''
  }));

  await db.words.bulkPut(words);
  console.log(`[db] 导入完成，共 ${words.length} 条`);
  return words.length;
}

// ====== 工具函数 ======

// 格式化释义：按词性分行显示
// 输入: "address n.住址；致词 v.向...致词"  word="address"
// 输出: "n.住址；致词\nv.向...致词"
function formatDefinition(def, word) {
  if (!def) return '';
  let text = String(def).trim();
  // 去掉开头的单词本身
  if (word) {
    const w = String(word).trim();
    if (text.startsWith(w + ' ')) {
      text = text.substring(w.length + 1);
    } else if (text.startsWith(w)) {
      text = text.substring(w.length);
    }
  }
  text = text.trim();
  // 常见词性标记：前有空格时切分（支持半角 . 和全角 ．）
  // n v vt vi a adj adv pron prep conj art num aux int abbr
  const posPattern = / (?=(?:n|v|vt|vi|a|adj|adv|pron|prep|conj|art|num|aux|int|abbr)[.．])/g;
  const parts = text.split(posPattern).map(p => p.trim()).filter(p => p);
  if (parts.length <= 1) return text;
  return parts.join('\n');
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ====== words 表查询 ======

async function getWordsByRange(fromRank, count) {
  return await db.words
    .where('rank')
    .between(fromRank, fromRank + count - 1, true, true)
    .toArray();
}

// 按单词名批量取词条（保留传入顺序）。逐个 where(...).first() 会变成 N+1 次查询，
// 列表一长就明显卡；这里一次 anyOf 查回来再按名字映射。
async function getWordsByNames(names) {
  const keys = [...new Set((names || []).filter(Boolean))];
  if (!keys.length) return [];
  const rows = await db.words.where('word').anyOf(keys).toArray();
  const byWord = new Map(rows.map(w => [w.word, w]));
  return (names || []).map(n => byWord.get(n)).filter(Boolean);
}

// ====== cards 表 CRUD ======

async function getCardsByProficiency(prof) {
  return await db.cards.where('proficiency').equals(prof).toArray();
}

// 设置单词熟练度（核心方法）
async function setProficiency(word, proficiency) {
  const today = todayStr();
  const existing = await db.cards.get(word);

  if (existing) {
    existing.proficiency = proficiency;
    existing.lastReview = today;
    await db.cards.put(existing);
  } else {
    await db.cards.put({
      word,
      proficiency,
      lastReview: today,
      firstLearned: today
    });
  }

  // 记录日志
  await db.reviews.add({
    word,
    proficiency,
    date: today
  });

  // 触发云端同步（防抖，1.5 秒内多次评分只推一次）
  // 用可选链避免 Sync 未加载时报错
  if (window.Sync && typeof window.Sync.debouncedSync === 'function') {
    window.Sync.debouncedSync();
  }
}

// 标记单词为"已见过"（跳过未评分时调用）
// 写入 proficiency=0 的记录，让 getUnlearnedWords 能过滤掉它
// 不写 reviews 日志（未评分不算复习）
async function markSeen(word) {
  const existing = await db.cards.get(word);
  if (!existing) {
    const today = todayStr();
    await db.cards.put({
      word,
      proficiency: 0,
      lastReview: today,
      firstLearned: today
    });
    // 见过的词也触发同步，让其他设备能感知到
    if (window.Sync && typeof window.Sync.debouncedSync === 'function') {
      window.Sync.debouncedSync();
    }
  }
}

// ====== 数据修复 ======
// 旧版曾把"临时"当成一个熟练度存入 cards.proficiency，导致单词从原熟练度消失。
// 这里扫描 proficiency 不在 0-6 的记录，从 reviews 日志找回最后一次合法评分恢复。
async function repairInvalidProficiency() {
  const valid = new Set([0, 1, 2, 3, 4, 5, 6]);
  const cards = await db.cards.toArray();
  let fixed = 0;
  for (const card of cards) {
    if (valid.has(card.proficiency)) continue;
    // reviews 用自增 id，id 越大越新；取最后一次合法评分
    const logs = await db.reviews.where('word').equals(card.word).toArray();
    logs.sort((a, b) => (b.id || 0) - (a.id || 0));
    const lastValid = logs.find(l => valid.has(l.proficiency));
    card.proficiency = lastValid ? lastValid.proficiency : 0;
    card.lastReview = lastValid ? lastValid.date : card.lastReview;
    await db.cards.put(card);
    fixed++;
  }
  if (fixed > 0) console.log(`[db] 已修复非法熟练度 ${fixed} 条`);
}

// ====== 临时词（tempWords）======
// 临时是"复制"语义：把词加进 tempWords，不改变 cards 表的原熟练度。
// 原熟练度保留在 cards 表，临时词独立存储，所以删除/清空临时不影响熟练度。

function tempTouch() {
  try { localStorage.setItem('temp_updated', String(Date.now())); } catch (e) {}
}

function getTempUpdated() {
  try { return parseInt(localStorage.getItem('temp_updated') || '0', 10); } catch (e) { return 0; }
}

function setTempUpdated(ts) {
  try { localStorage.setItem('temp_updated', String(ts)); } catch (e) {}
}

// 加入临时（已存在则忽略，重复加入不刷新时间戳）
async function addTempWord(word) {
  const exists = await db.tempWords.get(word);
  if (exists) return;
  await db.tempWords.put({ word, addedAt: Date.now() });
  tempTouch();
  if (window.Sync && typeof window.Sync.debouncedSync === 'function') {
    window.Sync.debouncedSync();
  }
}

// 从临时移除单个单词
async function removeTempWord(word) {
  await db.tempWords.delete(word);
  tempTouch();
  if (window.Sync && typeof window.Sync.debouncedSync === 'function') {
    window.Sync.debouncedSync();
  }
}

// 清空全部临时词
async function clearTempWords() {
  await db.tempWords.clear();
  tempTouch();
  if (window.Sync && typeof window.Sync.debouncedSync === 'function') {
    window.Sync.debouncedSync();
  }
}

// 获取临时词对应的完整单词数据（join words 表）
async function getTempWords() {
  const temps = await db.tempWords.toArray();
  return await getWordsByNames(temps.map(t => t.word));
}

async function getTempCount() {
  return await db.tempWords.count();
}

// 返回临时词集合（用于 UI 判断某个词是否已在临时）
async function getTempWordSet() {
  const temps = await db.tempWords.toArray();
  return new Set(temps.map(t => t.word));
}

// ====== 实战单词（practiceWords）======
// 与「临时」同样是复制语义：在实战单词里点熟练度，只会写 cards 表，
// 实战单词这条记录原封不动留着，词不会从列表里消失。
// 区别在于 addCount：同一个词可以被反复添加（刷题反复遇到），只累加次数、不重复显示。

function practiceTouch() {
  try { localStorage.setItem('practice_updated', String(Date.now())); } catch (e) {}
}

// 实战单词变了就推一次云端（截图页没有 Sync，这里会自动跳过）
function practiceSyncKick() {
  if (window.Sync && typeof window.Sync.debouncedSync === 'function') {
    window.Sync.debouncedSync();
  }
}

function getPracticeUpdated() {
  try { return parseInt(localStorage.getItem('practice_updated') || '0', 10); } catch (e) { return 0; }
}

function setPracticeUpdated(ts) {
  try { localStorage.setItem('practice_updated', String(ts)); } catch (e) {}
}

// 记录"用户主动移除/清空"的时间，避免下一次从云端拉取时又被加回来
function getPracticeRemoved() {
  try { return JSON.parse(localStorage.getItem('practice_removed') || '{}') || {}; } catch (e) { return {}; }
}

function markPracticeRemoved(word) {
  try {
    const map = getPracticeRemoved();
    map[word] = Date.now();
    const keys = Object.keys(map);
    // 只留最近 300 条，防止无限增长
    if (keys.length > 300) {
      keys.sort((a, b) => map[a] - map[b]);
      for (const k of keys.slice(0, keys.length - 300)) delete map[k];
    }
    localStorage.setItem('practice_removed', JSON.stringify(map));
  } catch (e) {}
}

function setPracticeRemovedMap(map) {
  try { localStorage.setItem('practice_removed', JSON.stringify(map || {})); } catch (e) {}
}

function unmarkPracticeRemoved(word) {
  try {
    const map = getPracticeRemoved();
    if (map[word]) { delete map[word]; localStorage.setItem('practice_removed', JSON.stringify(map)); }
  } catch (e) {}
}

function getPracticeClearedAt() {
  try { return parseInt(localStorage.getItem('practice_cleared_at') || '0', 10); } catch (e) { return 0; }
}

function setPracticeClearedAt(ts) {
  try { localStorage.setItem('practice_cleared_at', String(ts)); } catch (e) {}
}

function normalizePracticeWord(word) {
  return String(word || '').trim().toLowerCase();
}

const PRACTICE_META_KEYS = ['freq', 'rank', 'meaning', 'definition', 'category', 'subcategory', 'alt'];

// 添加一个实战单词：已存在则 addCount + 1，并刷新最近添加时间
// meta 可带 freq / rank / meaning / category / subcategory / alt
async function addPracticeWord(word, meta = {}) {
  const key = normalizePracticeWord(word);
  if (!key) return null;
  const now = Date.now();
  const existing = await db.practiceWords.get(key);
  const rec = existing
    ? { ...existing, addCount: (existing.addCount || 1) + 1, lastAddedAt: now }
    : { word: key, addCount: 1, firstAddedAt: now, lastAddedAt: now, source: meta.source || '实战单词' };

  for (const k of PRACTICE_META_KEYS) {
    if (meta[k] !== undefined && meta[k] !== null && meta[k] !== '') rec[k] = meta[k];
  }
  if (meta.source) rec.source = meta.source;

  await db.practiceWords.put(rec);
  unmarkPracticeRemoved(key);
  practiceTouch();
  practiceSyncKick();
  return rec;
}

// 移除单个实战单词（同时记下时间，防止云端把它补回来）
async function removePracticeWord(word) {
  const key = normalizePracticeWord(word);
  if (!key) return;
  await db.practiceWords.delete(key);
  markPracticeRemoved(key);
  practiceTouch();
  practiceSyncKick();
}

// 清空实战单词
async function clearPracticeWords() {
  await db.practiceWords.clear();
  setPracticeClearedAt(Date.now());
  practiceTouch();
  practiceSyncKick();
}

// 合并来自「本地桥接 / Gist」的实战单词，count 取较大值（幂等，重复拉取不会翻倍）
async function mergePracticeWords(list, source) {
  if (!Array.isArray(list) || list.length === 0) return { added: 0, updated: 0 };
  const clearedAt = getPracticeClearedAt();
  const removed = getPracticeRemoved();
  let added = 0, updated = 0;

  for (const item of list) {
    if (!item) continue;
    const key = normalizePracticeWord(item.word);
    if (!key) continue;
    const count = Math.max(1, parseInt(item.count, 10) || 1);
    const lastAt = Number(item.lastAt) || 0;
    const firstAt = Number(item.firstAt) || lastAt || Date.now();

    // 用户清空/移除过的，按时间戳判定是否还要收
    if (lastAt && lastAt <= clearedAt) continue;
    if (removed[key] && (!lastAt || lastAt <= removed[key])) continue;

    const existing = await db.practiceWords.get(key);
    if (!existing) {
      const rec = {
        word: key,
        addCount: count,
        firstAddedAt: firstAt,
        lastAddedAt: lastAt || Date.now(),
        source: item.source || source || '实战单词'
      };
      for (const k of PRACTICE_META_KEYS) {
        if (item[k] !== undefined && item[k] !== null && item[k] !== '') rec[k] = item[k];
      }
      await db.practiceWords.put(rec);
      added++;
    } else if ((existing.addCount || 0) < count) {
      existing.addCount = count;
      existing.lastAddedAt = Math.max(existing.lastAddedAt || 0, lastAt);
      for (const k of PRACTICE_META_KEYS) {
        if (item[k] !== undefined && item[k] !== null && item[k] !== '') existing[k] = item[k];
      }
      await db.practiceWords.put(existing);
      updated++;
    }
  }

  if (added || updated) practiceTouch();
  return { added, updated };
}

// 应用一份云端快照：并集累加次数，同时按「清空时间 / 移除记录」删掉该删的。
// 这样两端各自加的词都不会丢，而清空和移除也能传播过去。
async function applyPracticeRemote(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.words)) return { added: 0, updated: 0, removed: 0 };

  const remoteCleared = Number(snapshot.clearedAt) || 0;
  const localCleared = getPracticeClearedAt();
  const clearedAt = Math.max(remoteCleared, localCleared);
  if (remoteCleared > localCleared) setPracticeClearedAt(remoteCleared);

  const removed = getPracticeRemoved();
  let removedChanged = false;
  for (const [w, ts] of Object.entries(snapshot.removed || {})) {
    const t = Number(ts) || 0;
    if (t && (!removed[w] || removed[w] < t)) { removed[w] = t; removedChanged = true; }
  }
  if (removedChanged) setPracticeRemovedMap(removed);

  const rows = await db.practiceWords.toArray();
  const doomed = rows.filter(r => {
    const last = r.lastAddedAt || 0;
    if (clearedAt && last && last <= clearedAt) return true;
    const t = removed[r.word];
    return !!(t && last && last <= t);
  });
  if (doomed.length) await db.practiceWords.bulkDelete(doomed.map(r => r.word));

  const merged = await mergePracticeWords(snapshot.words, 'Gist');
  return { ...merged, removed: doomed.length };
}

// 取全部实战单词（join words 表补全释义，join cards 表显示已记入的熟练度）
async function getPracticeWords() {
  const rows = await db.practiceWords.toArray();
  if (!rows.length) return [];
  const keys = rows.map(p => p.word);
  // 一次批量查词条 + 一次批量查卡片，避免每个词都跑两轮查询
  const [wordRows, cards] = await Promise.all([
    db.words.where('word').anyOf(keys).toArray(),
    db.cards.bulkGet(keys)
  ]);
  const wordByKey = new Map(wordRows.map(w => [w.word, w]));
  const cardByKey = new Map();
  cards.forEach((c, i) => { if (c) cardByKey.set(keys[i], c); });

  const out = rows.map(p => {
    const w = wordByKey.get(p.word);
    const card = cardByKey.get(p.word);
    return {
      word: p.word,
      rank: w ? w.rank : (p.rank || 99999),
      frequency: w ? w.frequency : (p.freq || 0),
      definition: w ? w.definition : (p.definition || p.meaning || ''),
      variant: w ? w.variant : '',
      category: w ? w.category : (p.category || ''),
      subcategory: w ? w.subcategory : (p.subcategory || ''),
      inVocab: !!w,
      practiceCount: p.addCount || 1,
      practiceFirstAt: p.firstAddedAt || 0,
      practiceLastAt: p.lastAddedAt || 0,
      practiceSource: p.source || '',
      proficiency: card ? card.proficiency : null
    };
  });
  // 最近加进来的排前面
  out.sort((a, b) => (b.practiceLastAt || 0) - (a.practiceLastAt || 0));
  return out;
}

async function getPracticeCount() {
  return await db.practiceWords.count();
}

async function getPracticeWordSet() {
  const rows = await db.practiceWords.toArray();
  return new Set(rows.map(r => r.word));
}

// word -> 累计添加次数，截图页要显示"×6"用这个
async function getPracticeCounts() {
  const rows = await db.practiceWords.toArray();
  const map = {};
  for (const r of rows) map[r.word] = r.addCount || 1;
  return map;
}

// 导出给同步模块用：把本地实战单词转成「云端格式」的 map
async function getPracticeMap() {
  const rows = await db.practiceWords.toArray();
  const map = {};
  for (const r of rows) {
    map[r.word] = {
      word: r.word,
      count: r.addCount || 1,
      firstAt: r.firstAddedAt || 0,
      lastAt: r.lastAddedAt || 0,
      freq: r.freq,
      rank: r.rank,
      meaning: r.meaning || '',
      category: r.category || '',
      subcategory: r.subcategory || '',
      alt: r.alt || '',
      source: r.source || ''
    };
  }
  return map;
}

// 获取昨天标记为"不会"的单词（proficiency 1-3，lastReview=昨天）
async function getYesterdayForgotten() {
  const yesterday = yesterdayStr();
  const cards = await db.cards
    .where('lastReview')
    .equals(yesterday)
    .toArray();
  // 只取熟练度低的（完全不熟悉/熟悉但不记得/看了才记住）
  return cards.filter(c => c.proficiency >= 1 && c.proficiency <= 3);
}

// 获取所有未学习的单词（用于每日新词）
async function getUnlearnedWords(limit) {
  const allCards = await db.cards.toArray();
  const learnedWords = new Set(allCards.map(c => c.word));

  const total = await db.words.count();
  const result = [];
  const batchSize = 200;

  for (let start = 1; start <= total && result.length < limit; start += batchSize) {
    const batch = await getWordsByRange(start, batchSize);
    for (const w of batch) {
      if (!learnedWords.has(w.word)) {
        result.push(w);
        if (result.length >= limit) break;
      }
    }
  }
  return result;
}

// ====== 统计 ======

// words 表只读，词频索引建一次就够。以前每次评分后刷新统计都会把 5463 条词条
// 重新读一遍（约 1.3MB），一天 80 张卡就是 80 次全表扫描；缓存后只剩首次一次。
let freqIndexPromise = null;
async function getFrequencyIndex() {
  if (!freqIndexPromise) {
    freqIndexPromise = db.words.toArray().then(rows => {
      const byWord = new Map();
      let total = 0;
      for (const w of rows) {
        const f = w.frequency || 0;
        byWord.set(w.word, f);
        total += f;
      }
      return { byWord, total };
    }).catch(e => {
      freqIndexPromise = null;      // 失败不缓存，下次还能重建
      throw e;
    });
  }

  const idx = await freqIndexPromise;
  if (!idx.byWord.size) freqIndexPromise = null;   // 词库还没导入，别把空表缓存住
  return idx;
}

function buildProgress(total, cards) {
  // proficiency >= 1 才算"已学"（0 表示见过但未评分，不计入已学）
  const learnedCards = cards.filter(c => c.proficiency >= 1);
  const seenCount = cards.filter(c => c.proficiency === 0).length;

  const stats = {
    total,
    learned: learnedCards.length,
    seen: seenCount,
    byProficiency: { 0: total - cards.length, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
  };

  // 只统计 proficiency >= 1 的（0 不进 byProficiency，避免污染）
  for (const c of learnedCards) {
    stats.byProficiency[c.proficiency] = (stats.byProficiency[c.proficiency] || 0) + 1;
  }

  return stats;
}

function buildCoverage(cards, freq) {
  // 见过的词（proficiency >= 0）都算覆盖，因为用户已经接触过
  const learnedWords = new Set(cards.map(c => c.word));
  let coveredFrequency = 0;
  for (const w of learnedWords) coveredFrequency += freq.byWord.get(w) || 0;

  const coveragePercent = freq.total > 0
    ? parseFloat((coveredFrequency / freq.total * 100).toFixed(1))
    : 0;

  return {
    coveredCount: learnedWords.size,
    totalFrequency: freq.total,
    coveragePercent
  };
}

async function getProgress() {
  const [total, cards] = await Promise.all([
    db.words.count(),
    db.cards.toArray()
  ]);
  return buildProgress(total, cards);
}

async function getCoverage() {
  const [cards, freq] = await Promise.all([
    db.cards.toArray(),
    getFrequencyIndex()
  ]);
  return buildCoverage(cards, freq);
}

// 首页统计一次取全：cards 只读一次，刷新时不用再分别跑 getProgress / getCoverage
async function getStats() {
  const [total, cards, tempCount, practiceCount, freq] = await Promise.all([
    db.words.count(),
    db.cards.toArray(),
    db.tempWords.count(),
    db.practiceWords.count(),
    getFrequencyIndex()
  ]);

  return {
    stats: buildProgress(total, cards),
    coverage: buildCoverage(cards, freq),
    tempCount,
    practiceCount
  };
}

// ====== 危险操作 ======

async function resetProgress() {
  await db.cards.clear();
  await db.reviews.clear();
  console.log('[db] 学习进度已重置');
}

// ====== 导入导出 ======

// 导出学习数据：熟练度词表（cards）+ 复习日志（reviews）+ 临时词（tempWords）+ 实战单词（practiceWords）
async function exportData() {
  const [cards, reviews, tempWords, practiceWords] = await Promise.all([
    db.cards.toArray(),
    db.reviews.toArray(),
    db.tempWords.toArray(),
    db.practiceWords.toArray()
  ]);
  return {
    version: 2,
    exportDate: todayStr(),
    cards,
    reviews,
    tempWords,
    practiceWords
  };
}

// 导入学习数据：清空现有数据后恢复
async function importData(data) {
  if (!data || !data.cards || !data.reviews) {
    throw new Error('数据格式不正确');
  }
  await db.transaction('rw', db.cards, db.reviews, db.tempWords, db.practiceWords, async () => {
    await db.cards.clear();
    await db.reviews.clear();
    await db.tempWords.clear();
    if (data.cards.length > 0) await db.cards.bulkPut(data.cards);
    if (data.reviews.length > 0) await db.reviews.bulkPut(data.reviews);
    if (data.tempWords && data.tempWords.length > 0) await db.tempWords.bulkPut(data.tempWords);
    if (data.practiceWords && data.practiceWords.length > 0) {
      await db.practiceWords.clear();
      await db.practiceWords.bulkPut(data.practiceWords);
    }
  });
  console.log(`[db] 导入完成：${data.cards.length} 张卡片，${data.reviews.length} 条日志，${(data.tempWords || []).length} 条临时词，${(data.practiceWords || []).length} 条实战单词`);
}

// 导出全局
window.db = db;
window.DB = {
  todayStr,
  yesterdayStr,
  formatDefinition,
  initWordsData,
  getWordsByRange,
  getWordsByNames,
  getCardsByProficiency,
  setProficiency,
  markSeen,
  getYesterdayForgotten,
  getUnlearnedWords,
  getProgress,
  getCoverage,
  getStats,
  repairInvalidProficiency,
  resetProgress,
  exportData,
  importData,
  addTempWord,
  removeTempWord,
  clearTempWords,
  getTempWords,
  getTempCount,
  getTempWordSet,
  getTempUpdated,
  setTempUpdated,
  // 实战单词
  addPracticeWord,
  removePracticeWord,
  clearPracticeWords,
  mergePracticeWords,
  getPracticeWords,
  getPracticeCount,
  getPracticeWordSet,
  getPracticeCounts,
  getPracticeMap,
  getPracticeUpdated,
  setPracticeUpdated,
  getPracticeClearedAt,
  setPracticeClearedAt,
  getPracticeRemoved,
  setPracticeRemovedMap,
  markPracticeRemoved,
  applyPracticeRemote,
  normalizePracticeWord
};
