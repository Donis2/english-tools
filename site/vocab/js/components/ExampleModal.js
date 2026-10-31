// ExampleModal.js - 真题例句小卡片（例句里的单词可点，点词上方浮出释义）

const ExampleModal = {
  name: 'ExampleModal',
  props: {
    word: { type: String, default: '' },
    example: { type: Object, required: true }
  },
  setup(props, { emit }) {
    const { ref, computed } = Vue;
    const cardRef = ref(null);
    const tip = ref(null);
    const active = ref('');

    // 把例句拆成「单词 / 其他字符」，只有单词可点
    const tokens = computed(() => {
      const parts = String((props.example && props.example.en) || '')
        .split(/([A-Za-z][A-Za-z'-]*)/);
      return parts.filter(Boolean).map(text => ({
        text,
        isWord: /^[A-Za-z]/.test(text)
      }));
    });

    // 例句里的词可能是变形，先按原形查；查不到再试常见词尾还原
    async function lookup(raw) {
      const tries = [];
      const add = w => {
        if (w && w.length > 2 && !tries.includes(w)) tries.push(w);
      };
      add(raw);

      if (/ies$/.test(raw)) add(raw.slice(0, -3) + 'y');
      if (/ied$/.test(raw)) add(raw.slice(0, -3) + 'y');
      if (/ing$/.test(raw)) {
        const b = raw.slice(0, -3);
        add(b);
        add(b + 'e');
        if (b.length > 2 && b[b.length - 1] === b[b.length - 2]) add(b.slice(0, -1));
      }
      if (/ed$/.test(raw)) {
        const b = raw.slice(0, -2);
        add(b);
        add(b + 'e');
        if (b.length > 2 && b[b.length - 1] === b[b.length - 2]) add(b.slice(0, -1));
      }
      if (/es$/.test(raw)) {
        add(raw.slice(0, -2));
        add(raw.slice(0, -1));
      }
      if (/s$/.test(raw)) add(raw.slice(0, -1));
      if (/er$/.test(raw)) add(raw.slice(0, -2));
      if (/est$/.test(raw)) add(raw.slice(0, -3));

      for (const t of tries) {
        try {
          const rows = await DB.getWordsByNames([t]);
          if (rows && rows[0]) return { row: rows[0], lemma: t };
        } catch (e) { /* 继续试下一个 */ }
      }
      return null;
    }

    function showTip(word, def, rect, note) {
      const card = cardRef.value;
      if (!card) return;
      const base = card.getBoundingClientRect();
      const rawLeft = rect.left - base.left + rect.width / 2;
      tip.value = {
        word,
        def,
        note: note || '',
        left: Math.min(Math.max(rawLeft, 56), base.width - 56),
        top: rect.top - base.top
      };
    }

    async function onWordClick(event, tok) {
      event.stopPropagation();
      const clean = tok.text.toLowerCase().replace(/^['-]+|['-]+$/g, '');
      if (!clean) return;
      active.value = tok.text;
      const rect = event.currentTarget.getBoundingClientRect();
      showTip(tok.text, '查询中…', rect);

      let def = '';
      let note = '';
      try {
        const found = await lookup(clean);
        if (found) {
          def = DB.formatDefinition(found.row.definition, found.row.word) || '';
          def = def.split('\n')[0].trim();
          if (found.lemma !== clean) note = '原形 ' + found.lemma;
        }
      } catch (e) {
        def = '';
      }
      showTip(tok.text, def || '词库未收录', rect, note);
    }

    function clearTip() {
      tip.value = null;
      active.value = '';
    }

    return {
      cardRef,
      tip,
      active,
      tokens,
      onWordClick,
      clearTip,
      close: () => emit('close')
    };
  },
  template: `
    <div class="example-modal" @click="close">
      <div class="example-modal-card" ref="cardRef" @click.stop="clearTip">
        <div class="example-modal-head">{{ word }} · 真题例句</div>

        <div class="example-modal-en">
          <template v-for="(tok, i) in tokens" :key="i">
            <span v-if="tok.isWord"
                  class="ex-word"
                  :class="{ active: active === tok.text }"
                  @click="onWordClick($event, tok)">{{ tok.text }}</span>
            <template v-else>{{ tok.text }}</template>
          </template>
        </div>

        <div class="example-modal-zh">{{ example.zh }}</div>
        <div class="example-modal-src">{{ example.src }}</div>

        <div class="ex-tip" v-if="tip"
             :style="{ left: tip.left + 'px', top: tip.top + 'px' }">
          <div class="ex-tip-word">{{ tip.word }}</div>
          <div class="ex-tip-def">{{ tip.def }}</div>
          <div class="ex-tip-note" v-if="tip.note">{{ tip.note }}</div>
        </div>

        <div class="example-modal-hint">点单词看释义 · 点卡片空白处收起 · 点卡片外关闭</div>
      </div>
    </div>
  `
};

window.ExampleModal = ExampleModal;
