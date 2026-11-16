// SearchView.js - 全局查词
// 在整张词频表里模糊搜索：英文单词 / 其他拼写 / 中文释义都能查
// 结果点开可看完整释义，带发音和学习状态

const SearchView = {
  name: 'SearchView',
  setup() {
    const { ref, computed, watch, onMounted, nextTick } = Vue;
    const store = window.Store;
    const state = store.state;

    const query = ref(state.searchQuery || '');
    const results = ref([]);
    const searching = ref(false);
    const searched = ref(false);
    const expanded = ref('');
    const inputEl = ref(null);
    let timer = null;

    const PROF_NAMES = {
      0: '未学习', 1: '完全不熟悉', 2: '熟悉但不记得', 3: '看了才记住',
      4: '勉强记住', 5: '正常记住', 6: '完全记住',
    };

    async function run() {
      const q = query.value.trim();
      state.searchQuery = q;
      if (!q) {
        results.value = [];
        searched.value = false;
        return;
      }
      searching.value = true;
      try {
        results.value = await store.searchWords(q);
        searched.value = true;
      } catch (e) {
        results.value = [];
        searched.value = true;
      } finally {
        searching.value = false;
      }
    }

    // 输入防抖，打字过程中不连续查
    watch(query, () => {
      expanded.value = '';
      clearTimeout(timer);
      timer = setTimeout(run, 160);
    });

    onMounted(() => {
      nextTick(() => {
        if (inputEl.value) inputEl.value.focus();
      });
      if (query.value) run();
    });

    function clearQuery() {
      query.value = '';
      results.value = [];
      searched.value = false;
      if (inputEl.value) inputEl.value.focus();
    }

    function toggle(word) {
      expanded.value = expanded.value === word ? '' : word;
    }

    function speak(word) {
      TTS.speak(word);
    }

    function formatDef(w) {
      return DB.formatDefinition(w.definition, w.word);
    }

    function previewDef(w) {
      return formatDef(w).replace(/\n/g, ' ');
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // 把命中的部分标出来，扫结果时一眼能看到匹配在哪
    function mark(text, q) {
      const s = String(text == null ? '' : text);
      const key = String(q || '').trim().toLowerCase();
      if (!key) return escapeHtml(s);
      const i = s.toLowerCase().indexOf(key);
      if (i < 0) return escapeHtml(s);
      return escapeHtml(s.slice(0, i)) + '<mark>' + escapeHtml(s.slice(i, i + key.length)) +
             '</mark>' + escapeHtml(s.slice(i + key.length));
    }

    function wordHtml(w) {
      return mark(w.word, query.value);
    }

    function defHtml(w) {
      return mark(previewDef(w), query.value);
    }

    // 展开时按词性分行，不用高亮
    function defFull(w) {
      return formatDef(w);
    }

    function profName(p) {
      return PROF_NAMES[p] || '';
    }

    // 命中数 / 形近词数分开统计，提示里说清楚
    const mainCount = computed(() => results.value.filter(w => !w.near).length);
    const nearCount = computed(() => results.value.filter(w => w.near).length);
    const metaText = computed(() => {
      if (!searched.value) return '';
      const parts = ['找到 ' + mainCount.value + ' 个词'];
      if (nearCount.value) parts.push('另有 ' + nearCount.value + ' 个拼写相近');
      if (results.value.length >= 80) parts.push('只显示前 80 个');
      return parts.join(' · ');
    });

    return {
      state,
      query,
      results,
      searching,
      searched,
      expanded,
      inputEl,
      clearQuery,
      toggle,
      speak,
      formatDef,
      previewDef,
      wordHtml,
      defHtml,
      defFull,
      profName,
      mainCount,
      nearCount,
      metaText,
    };
  },
  template: `
    <div class="search-view">
      <div class="search-head">
        <div class="search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="7"></circle>
            <path d="M20 20l-3.5-3.5"></path>
          </svg>
          <input ref="inputEl" v-model="query" class="search-input-lg"
                 type="search" autocomplete="off" spellcheck="false"
                 placeholder="查词：英文或中文，如 abandon / 放弃" />
          <button v-if="query" class="search-clear" @click="clearQuery" title="清空">×</button>
        </div>
        <div class="search-meta" v-if="query">
          <template v-if="searching">查询中…</template>
          <template v-else-if="searched">{{ metaText }}</template>
        </div>
        <div class="search-meta" v-else>覆盖全部大纲词，英文按单词 / 其他拼写匹配，中文按释义匹配</div>
      </div>

      <div class="wordlist-items" v-if="results.length">
        <template v-for="(w, i) in results" :key="w.word">
          <div v-if="w.near && (i === 0 || !results[i-1].near)" class="search-sep">拼写相近，可能也想要</div>
          <div class="wordlist-item search-item"
               :class="{ open: expanded === w.word }"
               @click="toggle(w.word)">
            <div class="word-info">
              <div class="word-text">
                <span class="search-word" v-html="wordHtml(w)"></span>
                <span class="search-rank">#{{ w.rank }}</span>
                <span v-if="w.near" class="search-near-tag">形近</span>
                <span v-if="w.practiceCount" class="practice-badge">实战 ×{{ w.practiceCount }}</span>
                <button class="speak-mini" @click.stop="speak(w.word)" title="朗读">🔊</button>
              </div>
              <div class="word-def" :class="{ expanded: expanded === w.word }">
                <template v-if="expanded === w.word">{{ defFull(w) }}</template>
                <span v-else v-html="defHtml(w)"></span>
              </div>
              <div class="word-meta">
                <span>词频 {{ w.frequency }} 次</span>
                <span v-if="w.category"> · {{ w.category }}</span>
                <span v-if="w.variant"> · 其他拼写：{{ w.variant }}</span>
                <span v-if="w.proficiency !== null && w.proficiency !== undefined"> · 熟练度：{{ profName(w.proficiency) }}</span>
                <span v-else> · 还没学过</span>
              </div>
            </div>
            <div class="search-toggle">{{ expanded === w.word ? '⌃' : '⌄' }}</div>
          </div>
        </template>
      </div>

      <div v-else-if="searched && !searching" class="empty-state">
        <div style="font-size:44px;margin-bottom:12px;">🔍</div>
        <div>词频表里没有匹配「{{ query }}」的单词</div>
        <div class="empty-hint">中文可以只输入释义里的几个字，比如「放弃」「稳定」</div>
      </div>

      <div v-else-if="!query" class="search-guide">
        <div class="search-guide-title">怎么查</div>
        <div class="search-guide-row"><b>英文</b><span>支持部分拼写，如 <code>aband</code>、<code>spect</code></span></div>
        <div class="search-guide-row"><b>中文</b><span>按释义匹配，如 <code>放弃</code>、<code>提高</code></span></div>
        <div class="search-guide-row"><b>其他拼写</b><span>变形词也能命中对应原形</span></div>
      </div>
    </div>
  `
};

window.SearchView = SearchView;
