// ClusterView.js - 词群背诵 Beta
//
// 数据来自 tools/word_groups/ 的两张表，经 tools/build_word_groups.py 生成：
//   syn 近义词组 / cnf 易混词 / fam 同词根派生
//
// 组级进度存在 localStorage 的 wordg_v1，与独立「词群背诵」页面共用。
// 单词级别的 6 档熟练度仍然在普通背词页里维护，两边不混写。

const WORD_GROUPS_URL = (function () {
  const src = document.currentScript && document.currentScript.src;
  return src ? new URL('../../data/word_groups.json?v=3', src).href : 'data/word_groups.json?v=3';
})();

const WORDG_KEY = 'wordg_v1';
const PAGE_SIZE = 45;
const TYPE_ORDER = ['syn', 'cnf', 'fam'];

const ClusterView = {
  name: 'ClusterView',
  setup(props, { emit }) {
    const { ref, computed, onMounted, onUnmounted } = Vue;

    // 读取与独立「词群背诵」页共用的进度
    let saved = { lv: {}, prefs: {} };
    try {
      const raw = JSON.parse(localStorage.getItem(WORDG_KEY) || 'null');
      if (raw) saved = raw;
    } catch (e) {}
    saved.lv = saved.lv || {};
    saved.prefs = saved.prefs || {};

    const data = ref(null);
    const loading = ref(true);
    const error = ref('');
    const type = ref(saved.prefs.type && TYPE_ORDER.includes(saved.prefs.type) ? saved.prefs.type : 'syn');
    const query = ref('');
    const freqMin = ref(Number(saved.prefs.freq) || 0);
    const onlyNew = ref(!!saved.prefs.onlyNew);
    const shuffleOn = ref(!!saved.prefs.shuffle);
    const mask = ref(saved.prefs.mask !== undefined ? !!saved.prefs.mask : true);
    const page = ref(0);
    const levels = ref({ ...saved.lv });
    const shown = ref({});
    const shuffleRank = ref({});
    const mode = ref('browse');
    const study = ref(null);
    const studySize = ref(20);

    const types = computed(() => (data.value && data.value.types) || {});
    const currentType = computed(() => types.value[type.value] || { groups: [] });
    const groups = computed(() => currentType.value.groups || []);

    function mastered(g) {
      return (levels.value[g.id] || 0) >= 2;
    }

    const tabStats = computed(() => {
      const out = {};
      TYPE_ORDER.forEach(k => {
        const t = types.value[k];
        if (!t) return;
        const list = t.groups || [];
        out[k] = {
          total: list.length,
          done: list.filter(g => (levels.value[g.id] || 0) >= 2).length
        };
      });
      return out;
    });

    const totalGroups = computed(() => TYPE_ORDER.reduce((s, k) => s + (tabStats.value[k] ? tabStats.value[k].total : 0), 0));
    const totalMastered = computed(() => TYPE_ORDER.reduce((s, k) => s + (tabStats.value[k] ? tabStats.value[k].done : 0), 0));

    const filteredGroups = computed(() => {
      const q = query.value.trim().toLowerCase();
      return groups.value.filter(g => {
        if (onlyNew.value && mastered(g)) return false;
        if (g.maxFreq < freqMin.value) return false;
        if (q) {
          const hay = (g.name + ' ' + g.words.map(w => w.word + ' ' + w.definition).join(' ')).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    });

    const orderedGroups = computed(() => {
      if (!shuffleOn.value) return filteredGroups.value;
      const rank = shuffleRank.value;
      return [...filteredGroups.value].sort((a, b) => (rank[a.id] || 0) - (rank[b.id] || 0));
    });

    const visibleGroups = computed(() => orderedGroups.value.slice(0, (page.value + 1) * PAGE_SIZE));

    const currentGroup = computed(() => {
      const s = study.value;
      if (!s || s.pos >= s.queue.length) return null;
      return s.queue[s.pos];
    });

    const studyEnd = computed(() => !!study.value && study.value.pos >= study.value.queue.length);
    const studyIndex = computed(() => study.value ? Math.min(study.value.pos + 1, study.value.queue.length) : 0);
    const studyProgress = computed(() => {
      const s = study.value;
      if (!s || !s.queue.length) return 0;
      return Math.round(s.pos / s.queue.length * 100);
    });

    // 单组背诵结束后，按当前筛选顺序找下一组
    const nextGroup = computed(() => {
      const s = study.value;
      if (!s || !s.single) return null;
      const list = orderedGroups.value;
      const idx = list.findIndex(g => g.id === s.single.id);
      if (idx === -1) {
        return list.find(g => !mastered(g) && g.id !== s.single.id) || null;
      }
      return idx + 1 < list.length ? list[idx + 1] : null;
    });

    function persist() {
      try {
        localStorage.setItem(WORDG_KEY, JSON.stringify({
          lv: levels.value,
          prefs: {
            type: type.value,
            mask: mask.value,
            freq: freqMin.value,
            onlyNew: onlyNew.value,
            shuffle: shuffleOn.value
          }
        }));
      } catch (e) {}
    }

    function buildRank() {
      const ids = groups.value.map(g => g.id);
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      const rank = {};
      ids.forEach((id, i) => { rank[id] = i; });
      shuffleRank.value = rank;
    }

    async function loadGroups() {
      try {
        const resp = await fetch(WORD_GROUPS_URL);
        if (!resp.ok) throw new Error('分组数据加载失败 HTTP ' + resp.status);
        data.value = await resp.json();
        if (shuffleOn.value) buildRank();
      } catch (e) {
        console.error('[clusters] 加载失败:', e);
        error.value = e.message || '分组数据加载失败';
      } finally {
        loading.value = false;
      }
    }

    function setType(k) {
      if (type.value === k) return;
      type.value = k;
      page.value = 0;
      stopStudy();
      if (shuffleOn.value) buildRank();
      persist();
    }

    function onQuery(e) {
      query.value = e.target.value;
      page.value = 0;
    }

    function onFreq(e) {
      freqMin.value = Number(e.target.value) || 0;
      page.value = 0;
      persist();
    }

    function toggleMask() {
      mask.value = !mask.value;
      persist();
    }

    function toggleOnlyNew() {
      onlyNew.value = !onlyNew.value;
      page.value = 0;
      persist();
    }

    function toggleShuffle() {
      shuffleOn.value = !shuffleOn.value;
      if (shuffleOn.value) buildRank();
      page.value = 0;
      persist();
    }

    function loadMore() {
      page.value++;
    }

    function groupTitle(g) {
      if (type.value === 'syn') return g.name;
      if (type.value === 'cnf') return '易混词 · ' + g.name;
      return '词根 ' + g.name;
    }

    function groupPos(g) {
      return type.value === 'syn' ? g.pos : (type.value === 'cnf' ? '形近' : '同根');
    }

    function cleanDef(d, w) {
      let s = String(d || '').replace(/\s+/g, ' ');
      const i = s.toLowerCase().indexOf(String(w).toLowerCase());
      if (i >= 0) s = s.slice(i + String(w).length);
      return s.replace(/^\s*[a-z]{1,4}\./i, '').replace(/^[，,；;:：\s]+/, '').trim() || d;
    }

    function isShown(g, w) {
      return !mask.value || !!shown.value[g.id + '|' + w.word];
    }

    function toggleWord(g, w) {
      if (!mask.value) return;
      const key = g.id + '|' + w.word;
      shown.value = { ...shown.value, [key]: !shown.value[key] };
    }

    function startStudy(oneGroup) {
      let pool;
      let size;
      if (oneGroup && oneGroup.id) {
        pool = [oneGroup];
        size = 1;
      } else {
        pool = orderedGroups.value;
        size = studySize.value > 0 ? Math.min(studySize.value, pool.length) : pool.length;
      }
      if (!pool.length) {
        if (window.showToast) window.showToast('当前筛选下没有可背的词群', 'error', 2500);
        return;
      }
      study.value = {
        queue: pool.slice(0, size),
        pos: 0,
        revealed: false,
        good: 0,
        hard: 0,
        again: 0,
        requeued: new Set(),
        single: (oneGroup && oneGroup.id) ? oneGroup : null
      };
      mode.value = 'study';
      window.scrollTo({ top: 0 });
    }

    function stopStudy() {
      study.value = null;
      mode.value = 'browse';
      window.scrollTo({ top: 0 });
    }

    function reveal() {
      const s = study.value;
      if (!s || s.revealed) return;
      s.revealed = true;
    }

    function requeue(g, gap) {
      const s = study.value;
      if (!s || s.requeued.has(g.id)) return;
      s.requeued.add(g.id);
      const at = Math.min(s.pos + gap, s.queue.length);
      s.queue.splice(at, 0, g);
    }

    function answer(kind) {
      const s = study.value;
      if (!s) return;
      if (!s.revealed) { reveal(); return; }
      const g = currentGroup.value;
      if (!g) return;
      const lv = levels.value[g.id] || 0;
      if (kind === 'good') {
        levels.value[g.id] = Math.min(2, lv + 1);
        s.good++;
        s.pos++;
      } else if (kind === 'hard') {
        levels.value[g.id] = Math.max(1, lv);
        s.hard++;
        requeue(g, 8);
        s.pos++;
      } else {
        levels.value[g.id] = 0;
        s.again++;
        requeue(g, 6);
        s.pos++;
      }
      persist();
    }

    function againRound() {
      const one = study.value && study.value.single;
      if (one) startStudy(one);
      else startStudy();
    }

    function nextSingleGroup() {
      const g = nextGroup.value;
      if (g) {
        startStudy(g);
      } else if (window.showToast) {
        window.showToast('当前筛选下没有下一组了', 'info', 2000);
      }
    }

    function resetProgress() {
      if (!window.confirm('清除所有词群背诵进度？单词熟练度不受影响。')) return;
      levels.value = {};
      persist();
      if (window.showToast) window.showToast('词群进度已清除', 'success', 2000);
    }

    function onKey(e) {
      if (mode.value !== 'study' || !study.value) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        reveal();
      } else if (e.key === '1') {
        answer('again');
      } else if (e.key === '2') {
        answer('hard');
      } else if (e.key === '3') {
        answer('good');
      } else if (e.key === 'Escape') {
        stopStudy();
      }
    }

    onMounted(() => {
      loadGroups();
      window.addEventListener('keydown', onKey);
    });
    onUnmounted(() => {
      window.removeEventListener('keydown', onKey);
    });

    return {
      data, loading, error, type, query, freqMin, onlyNew, shuffleOn, mask,
      page, mode, study, studySize, types, currentType, groups,
      typeOrder: TYPE_ORDER,
      tabStats, totalGroups, totalMastered, filteredGroups, visibleGroups,
      currentGroup, studyEnd, studyIndex, studyProgress, nextGroup,
      mastered, setType, onQuery, onFreq, toggleMask, toggleOnlyNew, toggleShuffle,
      loadMore, groupTitle, groupPos, cleanDef, isShown, toggleWord,
      startStudy, stopStudy, reveal, answer, againRound, nextSingleGroup, resetProgress,
      emitBack: () => emit('back')
    };
  },
  template: `
    <div class="cluster-page">
      <div class="cluster-head">
        <button class="nav-tab cluster-back" @click="emitBack">← 首页</button>
        <div>
          <div class="cluster-head-title">词群背诵 <span class="beta-badge">Beta</span></div>
          <div class="cluster-head-sub">
            共 {{ totalGroups }} 组 · 已掌握 {{ totalMastered }} · 组级进度与独立「词群背诵」页共用
          </div>
        </div>
      </div>

      <!-- 浏览模式 -->
      <div v-if="mode === 'browse'">
        <div v-if="loading" class="cluster-empty">加载词群…</div>
        <div v-else-if="error" class="cluster-empty cluster-error">{{ error }}</div>
        <template v-else>
          <div class="cluster-tabs">
            <button v-for="k in typeOrder" :key="k"
                    class="cluster-tab"
                    :class="{ active: type === k }"
                    @click="setType(k)">
              {{ types[k].label }}
              <span>{{ tabStats[k] ? tabStats[k].done : 0 }}/{{ tabStats[k] ? tabStats[k].total : 0 }}</span>
            </button>
          </div>

          <div class="cluster-toolbar">
            <input class="cluster-search" type="search" :value="query"
                   placeholder="搜单词、义项或释义…"
                   @input="onQuery">
            <div class="cluster-controls">
              <select :value="freqMin" @change="onFreq">
                <option :value="0">全部词频</option>
                <option :value="10">最高词频 ≥ 10</option>
                <option :value="30">最高词频 ≥ 30</option>
                <option :value="60">最高词频 ≥ 60</option>
              </select>
              <label class="cluster-chk">
                <input type="checkbox" :checked="mask" @change="toggleMask"> 遮住释义
              </label>
              <label class="cluster-chk">
                <input type="checkbox" :checked="onlyNew" @change="toggleOnlyNew"> 只背未掌握
              </label>
              <button class="cluster-ghost" :class="{ active: shuffleOn }" @click="toggleShuffle">乱序</button>
            </div>
          </div>

          <div class="cluster-modebar">
            <div class="cluster-seg">
              <button class="on" @click="mode = 'browse'">浏览</button>
              <button @click="startStudy()">开始背诵</button>
            </div>
            <select v-model.number="studySize">
              <option :value="20">每轮 20 组</option>
              <option :value="50">每轮 50 组</option>
              <option :value="0">全部</option>
            </select>
            <span class="cluster-count">共 {{ filteredGroups.length }} 组</span>
          </div>

          <div v-if="!visibleGroups.length" class="cluster-empty">
            没有匹配的词群，换个关键词或放宽筛选条件。
          </div>

          <div v-else class="cluster-list">
            <article v-for="g in visibleGroups" :key="g.id"
                     class="cluster-card" :class="{ done: mastered(g) }">
              <div class="cluster-card-top">
                <span class="cluster-type">{{ types[type].short }}</span>
                <span class="cluster-max">最高词频 {{ g.maxFreq }}</span>
                <span v-if="mastered(g)" class="cluster-status done">已掌握</span>
              </div>
              <div class="cluster-card-title">
                {{ groupTitle(g) }}
                <small v-if="g.pos">{{ g.pos }}</small>
              </div>
              <div class="cluster-words">
                <div v-for="w in g.words" :key="w.word"
                     class="cluster-wrow" :class="{ show: isShown(g, w) }"
                     @click.stop="toggleWord(g, w)">
                  <span class="cluster-en">{{ w.display || w.word }}</span>
                  <span class="cluster-fq">{{ w.freq }}</span>
                  <span class="cluster-cn">
                    {{ isShown(g, w) ? cleanDef(w.definition, w.word) : '点击显示释义' }}
                  </span>
                </div>
              </div>
              <div class="cluster-card-foot">
                <span>{{ g.words.length }} 词</span>
                <button class="cluster-study-one" @click.stop="startStudy(g)">背这一组 →</button>
              </div>
            </article>
          </div>

          <div v-if="visibleGroups.length < filteredGroups.length" class="cluster-more">
            <button class="btn-secondary" @click="loadMore">
              加载更多（还有 {{ filteredGroups.length - visibleGroups.length }} 组）
            </button>
          </div>

          <div class="cluster-foot">
            <button class="cluster-reset" @click="resetProgress">清除词群进度</button>
          </div>
        </template>
      </div>

      <!-- 组级背诵模式 -->
      <div v-else class="cluster-study">
        <div class="cluster-study-head">
          <button class="nav-tab cluster-back" @click="stopStudy">← 返回浏览</button>
          <div class="cluster-study-title">{{ types[type].label }} · 背诵</div>
          <div class="cluster-study-count">{{ studyIndex }} / {{ study.queue.length }}</div>
        </div>

        <div class="cluster-progress"><i :style="{ width: studyProgress + '%' }"></i></div>

        <div v-if="!studyEnd" class="cluster-flash" @click="reveal">
          <div class="cluster-flash-kind">
            {{ types[type].label }}
            <span v-if="currentGroup.pos">{{ currentGroup.pos }}</span>
          </div>
          <div class="cluster-flash-freq">最高词频 {{ currentGroup.maxFreq }}</div>
          <div class="cluster-flash-words">
            <div v-for="w in currentGroup.words" :key="w.word" class="cluster-bigword">
              {{ w.display || w.word }}<span>词频 {{ w.freq }}</span>
            </div>
          </div>
          <div v-if="!study.revealed" class="cluster-veil">
            点击显示释义 <small>SPACE</small>
          </div>
          <div v-else class="cluster-defs">
            <div v-for="w in currentGroup.words" :key="w.word" class="cluster-def">
              <b>{{ w.display || w.word }}</b>
              <span>{{ cleanDef(w.definition, w.word) }}</span>
            </div>
          </div>
        </div>

        <div v-else class="cluster-end">
          <h2>{{ study.again === 0 ? '这一轮很稳' : '这一轮完成' }}</h2>
          <p>
            共过 {{ study.good + study.hard + study.again }} 次卡，
            {{ study.again > 0 ? '错过的卡片会在下一轮再出现。' : '没有卡住的词群。' }}
          </p>
          <div class="cluster-end-stats">
            <div><b>{{ study.good }}</b><span>记住了</span></div>
            <div><b>{{ study.hard }}</b><span>有点印象</span></div>
            <div><b>{{ study.again }}</b><span>想不起来</span></div>
          </div>
          <template v-if="study.single">
            <button v-if="nextGroup" class="btn-primary" @click="nextSingleGroup">下一组 →</button>
            <button class="btn-secondary" @click="againRound">再背这一组</button>
            <p v-if="!nextGroup" class="cluster-end-note">这已经是当前筛选下的最后一组。</p>
          </template>
          <template v-else>
            <button class="btn-primary" @click="againRound">再背一轮</button>
          </template>
          <button class="btn-secondary" @click="stopStudy">返回浏览</button>
        </div>

        <div v-if="!studyEnd" class="cluster-actions">
          <button v-if="!study.revealed" class="btn-primary" @click="reveal">显示释义</button>
          <template v-else>
            <button class="cluster-act again" @click="answer('again')">想不起来 <kbd>1</kbd></button>
            <button class="cluster-act hard" @click="answer('hard')">有点印象 <kbd>2</kbd></button>
            <button class="cluster-act good" @click="answer('good')">记住了 <kbd>3</kbd></button>
          </template>
        </div>
      </div>
    </div>
  `
};

window.ClusterView = ClusterView;
