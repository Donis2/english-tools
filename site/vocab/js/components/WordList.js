// WordList.js - 熟练度词表查看组件（点击单词进入卡片学习，可连续下一个）

const WordList = {
  name: 'WordList',
  setup(props, { emit }) {
    const { ref, onMounted, computed, watch } = Vue;
    const store = window.Store;

    const searchQuery = ref('');
    const currentIndex = ref(-1);  // 当前查看的单词索引，-1 表示在列表模式
    const flipped = ref(false);
    const tempWordSet = ref(new Set());   // 已在临时列表中的词
    const showClearModal = ref(false);    // 清空确认弹窗
    const clearTarget = ref('temp');      // 'temp' | 'practice'
    const showPasteModal = ref(false);    // 粘贴导入弹窗
    const pasteText = ref('');
    const importing = ref(false);

    function refreshTempSet() {
      return DB.getTempWordSet().then(set => { tempWordSet.value = set; });
    }

    onMounted(async () => {
      if (store.state.wordListProf !== null) {
        await store.loadWordList(store.state.wordListProf);
      }
      await refreshTempSet();
    });

    const profNames = {
      0: '未学习', 1: '完全不熟悉', 2: '熟悉但不记得', 3: '看了才记住',
      4: '勉强记住', 5: '正常记住', 6: '完全记住',
      temp: '临时', practice: '实战单词'
    };

    const profColors = {
      0: '#a0aec0', 1: '#e53e3e', 2: '#dd6b20', 3: '#d69e2e',
      4: '#3182ce', 5: '#38a169', 6: '#2f855a',
      temp: '#805ad5', practice: '#319795'
    };

    // 6档熟练度
    const proficiencyLevels = [
      { value: 1, name: '完全不熟悉', desc: '根本没印象', color: '#e53e3e' },
      { value: 2, name: '熟悉但不记得', desc: '感觉背过但不记得', color: '#dd6b20' },
      { value: 3, name: '看了才记住', desc: '看中文才想起', color: '#d69e2e' },
      { value: 4, name: '勉强记住', desc: '想一会儿才想起', color: '#3182ce' },
      { value: 5, name: '正常记住', desc: '偶尔忘记瞄两眼就想起', color: '#38a169' },
      { value: 6, name: '完全记住', desc: 'am/the 这种基础词', color: '#2f855a' }
    ];

    // 筛选后的词表
    const filteredWords = computed(() => {
      const words = store.state.wordList || [];
      if (!searchQuery.value) return words;
      const q = searchQuery.value.toLowerCase();
      return words.filter(w =>
        w.word.toLowerCase().includes(q) ||
        (w.definition || '').includes(searchQuery.value)
      );
    });

    // 当前选中的单词
    const currentWord = computed(() => {
      if (currentIndex.value < 0 || currentIndex.value >= filteredWords.value.length) return null;
      return filteredWords.value[currentIndex.value];
    });

    // 格式化释义：按词性分行（卡片模式用）
    const formattedDef = computed(() => {
      if (!currentWord.value) return '';
      return DB.formatDefinition(currentWord.value.definition, currentWord.value.word);
    });

    // 当前是否为「临时」词表
    const isTempProf = computed(() => store.state.wordListProf === 'temp');

    // 当前是否为「实战单词」词表（来自截图词频标注）
    const isPracticeProf = computed(() => store.state.wordListProf === 'practice');

    // 列表模式预览释义：把换行替换为空格，单行显示
    function previewDef(def, word) {
      const f = DB.formatDefinition(def, word);
      return f.replace(/\n/g, ' ');
    }

    // 点击单词进入卡片模式
    function selectWord(word) {
      const idx = filteredWords.value.findIndex(w => w.word === word.word);
      currentIndex.value = idx >= 0 ? idx : 0;
      flipped.value = false;
      // 自动朗读
      setTimeout(() => TTS.speak(word.word), 150);
    }

    function flipCard() {
      flipped.value = !flipped.value;
    }

    function speakWord() {
      if (currentWord.value) TTS.speak(currentWord.value.word);
    }

    // 下一个单词
    function nextWord() {
      if (currentIndex.value < filteredWords.value.length - 1) {
        currentIndex.value++;
        flipped.value = false;
        // 自动朗读下一个
        setTimeout(() => {
          if (currentWord.value) TTS.speak(currentWord.value.word);
        }, 150);
      }
    }

    // 上一个单词（额外加的，方便回看）
    function prevWord() {
      if (currentIndex.value > 0) {
        currentIndex.value--;
        flipped.value = false;
        setTimeout(() => {
          if (currentWord.value) TTS.speak(currentWord.value.word);
        }, 150);
      }
    }

    // 滑动翻页手势（左滑下一个，右滑上一个）
    const swipe = window.createSwipe({ onPrev: prevWord, onNext: nextWord });
    function onCardClick() {
      if (swipe.shouldIgnoreClick()) return;
      flipCard();
    }

    // 评分：设置熟练度，然后自动跳下一个
    // 实战单词例外：只"记入"对应熟练度，词本身留在实战单词里（复制而不是剪贴）
    async function rate(newProf) {
      if (!currentWord.value) return;
      if (isPracticeProf.value) {
        await store.rateInPractice(currentWord.value.word, newProf);
        if (window.showToast) {
          window.showToast(`已记入「${profNames[newProf]}」，实战单词保留`, 'success', 2600);
        }
        return;
      }
      await store.changeProficiency(currentWord.value.word, newProf);
      // 如果还有下一个，自动跳到下一个
      if (currentIndex.value < filteredWords.value.length - 1) {
        nextWord();
      } else {
        // 已经是最后一个，返回列表
        closeCard();
      }
    }

    function closeCard() {
      currentIndex.value = -1;
      flipped.value = false;
    }

    // 朗读列表中的单词
    function speak(word) {
      TTS.speak(word);
    }

    function back() {
      emit('back');
    }

    // ====== 临时词操作 ======
    function isTemp(word) {
      return tempWordSet.value.has(word);
    }

    async function addToTemp(word) {
      await store.addToTemp(word);
      const s = new Set(tempWordSet.value);
      s.add(word);
      tempWordSet.value = s;
    }

    async function removeFromTemp(word) {
      await store.removeFromTemp(word);
      const s = new Set(tempWordSet.value);
      s.delete(word);
      tempWordSet.value = s;
    }

    function askClear() {
      clearTarget.value = isPracticeProf.value ? 'practice' : 'temp';
      showClearModal.value = true;
    }

    async function confirmClear() {
      if (clearTarget.value === 'practice') {
        await store.clearPractice();
      } else {
        await store.clearTemp();
        tempWordSet.value = new Set();
      }
      showClearModal.value = false;
      currentIndex.value = -1;
      flipped.value = false;
    }

    function cancelClear() {
      showClearModal.value = false;
    }

    // ====== 实战单词操作 ======
    async function removeFromPractice(word) {
      await store.removeFromPractice(word);
      if (window.showToast) window.showToast('已从实战单词移除', 'info', 1800);
      if (currentWord.value && currentWord.value.word === word) closeCard();
    }

    function openPaste() {
      pasteText.value = '';
      showPasteModal.value = true;
    }

    function closePaste() {
      if (importing.value) return;
      showPasteModal.value = false;
    }

    async function confirmPaste() {
      const text = pasteText.value.trim();
      if (!text) { showPasteModal.value = false; return; }
      importing.value = true;
      try {
        const r = await store.importPracticeText(text);
        if (window.showToast) {
          window.showToast(r.added > 0 ? `已导入 ${r.added} 个单词` : '没有识别到单词', r.added > 0 ? 'success' : 'error');
        }
        showPasteModal.value = false;
      } catch (e) {
        if (window.showToast) window.showToast('导入失败：' + e.message, 'error', 4000);
      } finally {
        importing.value = false;
      }
    }

    function fmtDate(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const pad = n => String(n).padStart(2, '0');
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function profLabel(w) {
      if (w.proficiency === null || w.proficiency === undefined) return '未记入';
      if (w.proficiency === 0) return '已跳过';
      return profNames[w.proficiency] || '';
    }

    // 加入临时并在卡片模式自动前进（无下一个则回到列表）
    async function addToTempAndNext() {
      if (!currentWord.value) return;
      await addToTemp(currentWord.value.word);
      if (currentIndex.value < filteredWords.value.length - 1) {
        nextWord();
      } else {
        closeCard();
      }
    }

    return {
      state: store.state,
      searchQuery,
      filteredWords,
      currentIndex,
      currentWord,
      flipped,
      profNames,
      profColors,
      proficiencyLevels,
      formattedDef,
      isTempProf,
      isPracticeProf,
      isTemp,
      showClearModal,
      clearTarget,
      showPasteModal,
      pasteText,
      importing,
      previewDef,
      selectWord,
      flipCard,
      speakWord,
      nextWord,
      prevWord,
      onTouchStart: swipe.onTouchStart,
      onTouchMove: swipe.onTouchMove,
      onTouchEnd: swipe.onTouchEnd,
      onCardClick,
      rate,
      closeCard,
      speak,
      back,
      addToTemp,
      removeFromTemp,
      addToTempAndNext,
      removeFromPractice,
      openPaste,
      closePaste,
      confirmPaste,
      fmtDate,
      profLabel,
      askClear,
      confirmClear,
      cancelClear
    };
  },
  template: `
    <div class="wordlist-view">
      <!-- 头部 -->
      <div class="wordlist-header">
        <button class="back-btn" @click="back">← 返回</button>
        <div class="wordlist-title">
          <span class="prof-badge" :style="{ background: profColors[state.wordListProf] }">
            {{ profNames[state.wordListProf] }}
          </span>
          <span class="wordlist-total">{{ (state.wordList || []).length }} 词</span>
        </div>
      </div>

      <!-- 临时词：清空按钮（实战单词的清空放在工具栏里，避免大块红色按钮抢视线） -->
      <button v-if="isTempProf && (state.wordList || []).length > 0 && !currentWord"
              class="temp-clear-btn" @click="askClear">
        清空全部临时词
      </button>

      <!-- 实战单词：一行轻量工具条（低频操作都收进这里） -->
      <div v-if="isPracticeProf && !currentWord && (state.wordList || []).length > 0" class="practice-toolbar">
        <span class="practice-tip">在截图页点单词旁的 ＋，词会加到这里</span>
        <span class="practice-toolbar-actions">
          <button class="practice-link-btn" @click="openPaste">粘贴导入</button>
          <span class="practice-sep">·</span>
          <button class="practice-link-btn danger" @click="askClear">清空</button>
        </span>
      </div>

      <!-- 卡片学习模式（点击单词后） -->
      <div v-if="currentWord" class="card-container" style="padding-top:0;">
        <!-- 顶部返回 + 进度 -->
        <div style="width:100%;max-width:500px;display:flex;justify-content:space-between;align-items:center;">
          <button class="back-btn" @click="closeCard">← 返回列表</button>
          <span style="font-size:12px;color:var(--text-light);">
            {{ currentIndex + 1 }} / {{ filteredWords.length }}
          </span>
        </div>

        <!-- 进度条 -->
        <div style="width:100%;max-width:500px;">
          <div class="progress-bar">
            <div class="progress-fill"
                 :style="{ width: ((currentIndex) / filteredWords.length * 100) + '%' }">
            </div>
          </div>
        </div>

        <!-- 卡片 -->
        <div class="flashcard" :class="{ flipped: flipped }"
             @click="onCardClick"
             @touchstart.passive="onTouchStart"
             @touchmove.passive="onTouchMove"
             @touchend.passive="onTouchEnd">
          <div class="card-face">
            <div class="card-word">{{ currentWord.word }}</div>
            <div class="card-rank">词频排名 #{{ currentWord.rank }}</div>
            <div class="card-frequency">真题出现 {{ currentWord.frequency }} 次</div>
            <div class="card-hint">点击卡片查看释义</div>
          </div>
          <div class="card-face card-back">
            <div class="card-word" style="font-size:24px;">{{ currentWord.word }}</div>
            <div class="card-definition" :style="{ textAlign: state.settings.defAlign }"><span class="def-inner">{{ formattedDef }}</span></div>
            <div class="card-variant" v-if="currentWord.variant">
              其他拼写：{{ currentWord.variant }}
            </div>
            <div class="card-category" v-if="currentWord.category">
              {{ currentWord.category }}
              <span v-if="currentWord.subcategory"> / {{ currentWord.subcategory }}</span>
            </div>
          </div>
        </div>

        <!-- 实战单词：一行小字，不抢卡片的视觉重心 -->
        <div v-if="isPracticeProf" class="practice-mini">
          加入 <b>{{ currentWord.practiceCount }}</b> 次<template v-if="currentWord.practiceLastAt"> · 最近 {{ fmtDate(currentWord.practiceLastAt) }}</template><template v-if="currentWord.proficiency !== null && currentWord.proficiency !== undefined"> · 已记入：{{ profLabel(currentWord) }}</template>
        </div>

        <!-- 发音按钮 -->
        <button class="speak-btn-large" @click="speakWord" title="朗读单词">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
          </svg>
          <span>朗读</span>
        </button>

        <!-- 6档熟练度按钮（一直显示） -->
        <div class="proficiency-grid">
          <button v-for="level in proficiencyLevels"
                  :key="level.value"
                  class="prof-btn"
                  :style="{ background: level.color }"
                  @click.stop="rate(level.value)"
                  :title="level.desc">
            <span class="prof-name">{{ level.name }}</span>
            <span class="prof-desc">{{ level.desc }}</span>
          </button>
        </div>

        <!-- 加入临时（复制，不影响原熟练度） -->
        <button v-if="!isPracticeProf && isTemp(currentWord.word)" class="temp-added-btn-block" disabled>
          🔖 已在临时列表
        </button>
        <button v-else-if="!isPracticeProf" class="temp-add-btn" @click="addToTempAndNext" title="复制到临时列表，当前熟练度保持不变">
          🔖 加入临时
        </button>

        <!-- 上一个 / 下一个 按钮 -->
        <div style="display:flex;gap:10px;width:100%;max-width:500px;">
          <button class="btn-secondary" style="flex:1;" @click="prevWord"
                  :disabled="currentIndex === 0"
                  :style="{ opacity: currentIndex === 0 ? 0.5 : 1, cursor: currentIndex === 0 ? 'not-allowed' : 'pointer' }">
            ← 上一个
          </button>
          <button class="btn-primary" style="flex:1;" @click="nextWord"
                  :disabled="currentIndex >= filteredWords.length - 1"
                  :style="{ opacity: currentIndex >= filteredWords.length - 1 ? 0.5 : 1, cursor: currentIndex >= filteredWords.length - 1 ? 'not-allowed' : 'pointer' }">
            下一个 →
          </button>
        </div>
      </div>

      <!-- 列表模式（默认） -->
      <template v-else>
        <!-- 搜索框 -->
        <input v-model="searchQuery" class="search-input"
               placeholder="搜索单词或释义..." />

        <!-- 词表 -->
        <div class="wordlist-items" v-if="filteredWords.length > 0">
          <div v-for="word in filteredWords" :key="word.word" class="wordlist-item" @click="selectWord(word)" style="cursor:pointer;">
            <div class="word-info">
              <div class="word-text">
                {{ word.word }}
                <span v-if="isPracticeProf && word.practiceCount > 1" class="practice-count"
                      :title="'被添加了 ' + word.practiceCount + ' 次'">×{{ word.practiceCount }}</span>
                <button class="speak-mini" @click.stop="speak(word.word)" title="朗读">🔊</button>
              </div>
              <div class="word-def">{{ previewDef(word.definition, word.word) }}</div>
              <div class="word-meta">
                <span>词频 #{{ word.rank }}</span>
                <span v-if="word.category"> · {{ word.category }}</span>
              </div>
            </div>
            <span v-if="isPracticeProf" class="prof-chip"
                  :class="{ empty: word.proficiency === null || word.proficiency === undefined }"
                  :style="{ color: (word.proficiency === null || word.proficiency === undefined) ? '#a0aec0' : profColors[word.proficiency] }">
              {{ profLabel(word) }}
            </span>
            <div class="wordlist-actions">
              <button v-if="isPracticeProf || isTempProf" class="practice-remove-btn" @click.stop="isPracticeProf ? removeFromPractice(word.word) : removeFromTemp(word.word)">移除</button>
              <template v-else>
                <button v-if="isTemp(word.word)" class="temp-added-btn" disabled>已在临时</button>
                <button v-else class="temp-add-mini" @click.stop="addToTemp(word.word)">加入临时</button>
              </template>
            </div>
            <div style="color:var(--text-light);font-size:20px;">›</div>
          </div>
        </div>

        <!-- 空状态 -->
        <div v-else class="empty-state">
          <div style="font-size:48px;margin-bottom:12px;">📋</div>
          <div v-if="searchQuery">没有匹配的单词</div>
          <template v-else-if="isPracticeProf">
            <div>还没有收进实战单词</div>
            <div class="empty-hint">在「截图取词」页点单词旁的 ＋，词就会出现在这里</div>
            <button class="practice-link-btn" style="margin-top:14px;padding:8px 16px;" @click="openPaste">或粘贴导入</button>
          </template>
          <div v-else>这个词表还是空的</div>
        </div>
      </template>

      <!-- 清空确认弹窗 -->
      <div v-if="showClearModal" class="modal-overlay" @click.self="cancelClear">
        <div class="modal-content">
          <div class="modal-title">{{ clearTarget === 'practice' ? '清空实战单词？' : '清空临时词？' }}</div>
          <div class="modal-desc">
            {{ clearTarget === 'practice'
              ? '会清空实战单词列表（含累计添加次数），但不会影响它们已经记入的熟练度。此操作不可撤销。'
              : '将从临时列表移除全部单词，但不会影响它们原有的熟练度。此操作不可撤销。' }}
          </div>
          <div class="modal-actions">
            <button class="btn-secondary" style="flex:1;" @click="cancelClear">取消</button>
            <button class="btn-danger" style="flex:1;" @click="confirmClear">清空</button>
          </div>
        </div>
      </div>

      <!-- 粘贴导入弹窗（截图工具无法直连时的兜底） -->
      <div v-if="showPasteModal" class="modal-overlay" @click.self="closePaste">
        <div class="modal-content">
          <div class="modal-title">粘贴导入实战单词</div>
          <div class="modal-desc">
            把截图词频标注里「复制」的单词粘贴进来。支持它复制的 JSON，也支持一行一个词或空格分隔的纯文本。
          </div>
          <textarea class="paste-textarea" v-model="pasteText"
                    placeholder='plastic / artificial / debt（空格或换行分隔），也可以直接粘贴截图工具复制的 JSON'></textarea>
          <div class="modal-actions">
            <button class="btn-secondary" style="flex:1;" @click="closePaste" :disabled="importing">取消</button>
            <button class="btn-primary" style="flex:1;" @click="confirmPaste" :disabled="importing">
              {{ importing ? '导入中...' : '导入' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `
};

window.WordList = WordList;
