// CardView.js - 卡片视图组件（正面单词 + 翻转 + 6档熟练度按钮 + 发音 + 上一个/下一个）

const CardView = {
  name: 'CardView',
  setup(props, { emit }) {
    const { watch, computed } = Vue;
    const store = window.Store;

    function flipCard() {
      store.flip();
    }

    function rate(prof) {
      store.rateCard(prof);
    }

    function skip() {
      store.skipCard();
    }

    function speakWord() {
      if (!store.state.currentCard) return;
      TTS.speak(store.state.currentCard.wordData.word);
    }

    // 下一个单词（跳过当前，不评分）
    function nextWord() {
      store.skipCard();
    }

    // 上一个单词（回看）
    function prevWord() {
      store.prevCard();
    }

    // 滑动翻页手势（左滑下一个，右滑上一个）
    const swipe = window.createSwipe({ onPrev: prevWord, onNext: nextWord });
    function onCardClick() {
      if (swipe.shouldIgnoreClick()) return;
      flipCard();
    }

    // 加入临时（复制语义，不改原熟练度），并前进到下一个
    function addTemp() {
      store.rateCardTemp();
    }

    // 监听卡片变化自动朗读
    watch(
      () => store.state.currentCard,
      (newCard) => {
        if (newCard && newCard.wordData) {
          setTimeout(() => TTS.speak(newCard.wordData.word), 150);
        }
      }
    );

    // 格式化释义：按词性分行
    const formattedDef = computed(() => {
      if (!store.state.currentCard) return '';
      const wd = store.state.currentCard.wordData;
      return DB.formatDefinition(wd.definition, wd.word);
    });

    const proficiencyLevels = [
      { value: 1, name: '完全不熟悉', desc: '根本没印象', color: '#e53e3e' },
      { value: 2, name: '熟悉但不记得', desc: '感觉背过但不记得', color: '#dd6b20' },
      { value: 3, name: '看了才记住', desc: '看中文才想起', color: '#d69e2e' },
      { value: 4, name: '勉强记住', desc: '想一会儿才想起', color: '#3182ce' },
      { value: 5, name: '正常记住', desc: '偶尔忘记瞄两眼就想起', color: '#38a169' },
      { value: 6, name: '完全记住', desc: 'am/the 这种基础词', color: '#2f855a' }
    ];

    return {
      state: store.state,
      flipCard,
      rate,
      skip,
      speakWord,
      nextWord,
      prevWord,
      onTouchStart: swipe.onTouchStart,
      onTouchMove: swipe.onTouchMove,
      onTouchEnd: swipe.onTouchEnd,
      onCardClick,
      addTemp,
      proficiencyLevels,
      formattedDef
    };
  },
  template: `
    <div class="card-container" v-if="state.currentCard">
      <!-- 进度条 -->
      <div style="width:100%;max-width:500px;">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-light);margin-bottom:4px;">
          <span>{{ state.queueIndex + 1 }} / {{ state.queue.length }}</span>
          <span v-if="state.currentCard.type === 'new'" style="color:var(--success);">新词</span>
          <span v-else style="color:var(--accent);">复习</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill"
               :style="{ width: ((state.queueIndex) / state.queue.length * 100) + '%' }">
          </div>
        </div>
      </div>

      <!-- 卡片 -->
      <div class="flashcard" :class="{ flipped: state.flipped }"
           @click="onCardClick"
           @touchstart.passive="onTouchStart"
           @touchmove.passive="onTouchMove"
           @touchend.passive="onTouchEnd">
        <!-- 正面：单词 -->
        <div class="card-face">
          <div class="card-word">{{ state.currentCard.wordData.word }}</div>
          <div class="card-rank">词频排名 #{{ state.currentCard.wordData.rank }}</div>
          <div class="card-frequency">真题出现 {{ state.currentCard.wordData.frequency }} 次</div>
          <div class="card-hint">点击卡片查看释义</div>
        </div>
        <!-- 背面：释义 -->
        <div class="card-face card-back">
          <div class="card-word card-word-back">{{ state.currentCard.wordData.word }}</div>
          <div class="card-definition" :style="{ textAlign: state.settings.defAlign }"><span class="def-inner">{{ formattedDef }}</span></div>
          <div class="card-variant" v-if="state.currentCard.wordData.variant">
            其他拼写：{{ state.currentCard.wordData.variant }}
          </div>
          <div class="card-category" v-if="state.currentCard.wordData.category">
            {{ state.currentCard.wordData.category }}
            <span v-if="state.currentCard.wordData.subcategory"> / {{ state.currentCard.wordData.subcategory }}</span>
          </div>
        </div>
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

      <!-- 评分按钮（6档熟练度 + 临时） -->
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
        <!-- 临时：复制语义，保留原熟练度，额外复制一份到临时 -->
        <button class="prof-btn temp-prof-btn" @click.stop="addTemp"
                title="复制到临时列表，当前熟练度保持不变">
          <span class="prof-name">🔖 临时（复制）</span>
          <span class="prof-desc">保留原熟练度，不移动</span>
        </button>
      </div>

      <!-- 上一个 / 下一个 按钮 -->
      <div style="display:flex;gap:10px;width:100%;max-width:500px;">
        <button class="btn-secondary" style="flex:1;" @click="prevWord"
                :disabled="state.queueIndex === 0"
                :style="{ opacity: state.queueIndex === 0 ? 0.5 : 1, cursor: state.queueIndex === 0 ? 'not-allowed' : 'pointer' }">
          ← 上一个
        </button>
        <button class="btn-primary" style="flex:1;" @click="nextWord"
                :disabled="state.queueIndex >= state.queue.length - 1"
                :style="{ opacity: state.queueIndex >= state.queue.length - 1 ? 0.5 : 1, cursor: state.queueIndex >= state.queue.length - 1 ? 'not-allowed' : 'pointer' }">
          下一个 →
        </button>
      </div>
    </div>

    <!-- 完成页面 -->
    <div class="complete-view" v-else>
      <div class="complete-icon">🎉</div>
      <div class="complete-title">今日任务完成！</div>
      <div class="complete-stats">
        已完成 {{ state.queueIndex }} / {{ state.queue.length }} 张卡片
      </div>
      <div class="complete-stats" v-if="state.stats.learned > 0">
        累计学习 {{ state.stats.learned }} 词，覆盖真题 {{ state.coverage.coveragePercent }}% 文本
      </div>
      <button class="btn-primary" style="max-width:200px;" @click="$emit('back')">
        返回首页
      </button>
    </div>
  `
};

window.CardView = CardView;
