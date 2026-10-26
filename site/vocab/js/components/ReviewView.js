// ReviewView.js - 第二任务复习组件（熟练度 1-4 词表复习）

const ReviewView = {
  name: 'ReviewView',
  setup(props, { emit }) {
    const { watch, computed } = Vue;
    const store = window.Store;

    // 复习队列用 reviewQueue
    function getCurrentCard() {
      if (store.state.reviewIndex >= store.state.reviewQueue.length) return null;
      return store.state.reviewQueue[store.state.reviewIndex];
    }

    function flip() {
      store.state.flipped = !store.state.flipped;
    }

    async function rate(prof) {
      const card = getCurrentCard();
      if (!card) return;
      await DB.setProficiency(card.wordData.word, prof);
      store.state.reviewIndex++;
      store.state.flipped = false;
      await store.refreshStats();
    }

    function skip() {
      store.state.reviewIndex++;
      store.state.flipped = false;
    }

    // 上一个复习词
    function prevCard() {
      if (store.state.reviewIndex > 0) {
        store.state.reviewIndex--;
        store.state.flipped = false;
      }
    }

    // 滑动翻页手势（左滑下一个，右滑上一个）
    const swipe = window.createSwipe({ onPrev: prevCard, onNext: skip });
    function onCardClick() {
      if (swipe.shouldIgnoreClick()) return;
      flip();
    }

    function speakWord() {
      const card = getCurrentCard();
      if (card) TTS.speak(card.wordData.word);
    }

    // 加入临时（复制语义，不改原熟练度），并前进到下一个
    async function addTemp() {
      const card = getCurrentCard();
      if (!card) return;
      await DB.addTempWord(card.wordData.word);
      store.state.reviewIndex++;
      store.state.flipped = false;
      await store.refreshStats();
    }

    const proficiencyLevels = [
      { value: 1, name: '完全不熟悉', color: '#e53e3e' },
      { value: 2, name: '熟悉但不记得', color: '#dd6b20' },
      { value: 3, name: '看了才记住', color: '#d69e2e' },
      { value: 4, name: '勉强记住', color: '#3182ce' },
      { value: 5, name: '正常记住', color: '#38a169' },
      { value: 6, name: '完全记住', color: '#2f855a' }
    ];

    // 格式化释义：按词性分行
    const formattedDef = computed(() => {
      const card = getCurrentCard();
      if (!card) return '';
      return DB.formatDefinition(card.wordData.definition, card.wordData.word);
    });

    return {
      state: store.state,
      getCurrentCard,
      flip,
      rate,
      skip,
      onTouchStart: swipe.onTouchStart,
      onTouchMove: swipe.onTouchMove,
      onTouchEnd: swipe.onTouchEnd,
      onCardClick,
      addTemp,
      speakWord,
      proficiencyLevels,
      formattedDef
    };
  },
  template: `
    <div class="card-container" v-if="getCurrentCard()">
      <!-- 进度条 -->
      <div style="width:100%;max-width:500px;">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-light);margin-bottom:4px;">
          <span>{{ state.reviewIndex + 1 }} / {{ state.reviewQueue.length }}</span>
          <span style="color:var(--accent);">第二任务复习</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill"
               :style="{ width: ((state.reviewIndex) / state.reviewQueue.length * 100) + '%' }">
          </div>
        </div>
      </div>

      <!-- 卡片 -->
      <div class="flashcard" :class="{ flipped: state.flipped }"
           @click="onCardClick"
           @touchstart.passive="onTouchStart"
           @touchmove.passive="onTouchMove"
           @touchend.passive="onTouchEnd">
        <div class="card-face">
          <div class="card-word">{{ getCurrentCard().wordData.word }}</div>
          <div class="card-rank">词频排名 #{{ getCurrentCard().wordData.rank }}</div>
          <div class="card-frequency">真题出现 {{ getCurrentCard().wordData.frequency }} 次</div>
          <div class="card-hint">点击卡片查看释义</div>
        </div>
        <div class="card-face card-back">
          <div class="card-word" style="font-size:24px;">{{ getCurrentCard().wordData.word }}</div>
          <div class="card-definition" :style="{ textAlign: state.settings.defAlign }"><span class="def-inner">{{ formattedDef }}</span></div>
          <div class="card-variant" v-if="getCurrentCard().wordData.variant">
            其他拼写：{{ getCurrentCard().wordData.variant }}
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

      <!-- 熟练度按钮（一直显示） -->
      <div class="proficiency-grid">
        <button v-for="level in proficiencyLevels"
                :key="level.value"
                class="prof-btn"
                :style="{ background: level.color }"
                @click.stop="rate(level.value)">
          <span class="prof-name">{{ level.name }}</span>
        </button>
      </div>

      <!-- 加入临时（复制，不影响原熟练度） -->
      <button class="temp-add-btn" @click="addTemp" title="复制到临时列表，当前熟练度保持不变">
        🔖 加入临时
      </button>

      <button @click="skip"
              style="background:none;border:none;color:var(--text-light);cursor:pointer;font-size:13px;">
        跳过
      </button>
    </div>

    <!-- 完成页面 -->
    <div class="complete-view" v-else>
      <div class="complete-icon">🎉</div>
      <div class="complete-title">复习完成！</div>
      <div class="complete-stats">
        已复习 {{ state.reviewIndex }} / {{ state.reviewQueue.length }} 词
      </div>
      <button class="btn-primary" style="max-width:200px;" @click="$emit('back')">
        返回首页
      </button>
    </div>
  `
};

window.ReviewView = ReviewView;
