// Dashboard.js - 仪表盘组件（统计 + 今日任务 + 第二任务 + 熟练度词表入口）

const Dashboard = {
  name: 'Dashboard',
  setup(props, { emit }) {
    const store = window.Store;
    const { ref, computed } = Vue;

    // 按熟练度导出弹窗状态
    const showProfExportModal = ref(false);
    const selectedProfs = ref([1, 2, 3, 4, 5, 6]); // 默认全选 1-6
    const exporting = ref(false);

    // 6 档熟练度（不含 0=未学习，因为未学习没有 cards 记录）
    const exportProfLevels = [
      { value: 1, name: '完全不熟悉', desc: '根本没印象' },
      { value: 2, name: '熟悉但不记得', desc: '感觉背过但不记得' },
      { value: 3, name: '看了才记住', desc: '看中文才想起' },
      { value: 4, name: '勉强记住', desc: '想一会儿才想起' },
      { value: 5, name: '正常记住', desc: '偶尔忘记瞄两眼就想起' },
      { value: 6, name: '完全记住', desc: 'am/the 这种基础词' }
    ];

    const allSelected = computed({
      get: () => selectedProfs.value.length === 6,
      set: (v) => {
        selectedProfs.value = v ? [1, 2, 3, 4, 5, 6] : [];
      }
    });

    function toggleProf(value) {
      const idx = selectedProfs.value.indexOf(value);
      if (idx >= 0) selectedProfs.value.splice(idx, 1);
      else selectedProfs.value.push(value);
    }

    function isProfSelected(value) {
      return selectedProfs.value.includes(value);
    }

    function openProfExportModal() {
      selectedProfs.value = [1, 2, 3, 4, 5, 6];
      showProfExportModal.value = true;
    }

    function closeProfExportModal() {
      showProfExportModal.value = false;
    }

    async function startStudy() {
      const hasCards = await store.startStudy();
      if (!hasCards) {
        alert('今日没有需要学习的单词，明天再来吧！');
      } else {
        emit('study');
      }
    }

    async function startReview() {
      const hasCards = await store.startReview([1, 2, 3, 4]);
      if (!hasCards) {
        alert('没有需要复习的单词（熟练度 1-4 的词表为空）');
      } else {
        emit('review');
      }
    }

    function viewWordList(prof) {
      emit('wordlist', prof);
    }

    // 从释义中提取词性标记（n. v. adj. 等）
    function extractPos(definition, word) {
      if (!definition) return '';
      let text = String(definition).trim();
      if (word) {
        const w = String(word).trim();
        if (text.startsWith(w + ' ')) text = text.substring(w.length + 1);
        else if (text.startsWith(w)) text = text.substring(w.length);
      }
      const posPattern = /\b(n|vt|vi|v|a|adj|adv|pron|prep|conj|art|num|aux|int|abbr)[.．]/g;
      const matches = [...text.matchAll(posPattern)];
      const posSet = new Set();
      for (const m of matches) posSet.add(m[1] + '.');
      return [...posSet].join(' / ');
    }

    // 导出今日词汇为 Markdown 文件，方便粘贴到 DeepSeek 改作文
    async function exportTodayWords() {
      const data = await store.exportTodayWords();
      if (!data || data.words.length === 0) {
        alert('今日暂无学习的单词可导出');
        return;
      }

      const profNames = {
        0: '已跳过', 1: '完全不熟悉', 2: '熟悉但不记得', 3: '看了才记住',
        4: '勉强记住', 5: '正常记住', 6: '完全记住'
      };

      // 转义 Markdown 表格中的特殊字符
      const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();

      let md = `# 今日学习的单词（${data.date}）\n\n`;
      md += `共 ${data.words.length} 个新词\n\n`;
      md += '| 序号 | 单词 | 词性 | 词频排名 | 真题出现次数 | 释义 | 其他拼写 | 分类 | 熟练度 |\n';
      md += '|------|------|------|----------|--------------|------|----------|------|--------|\n';

      data.words.forEach((w, i) => {
        const pos = esc(extractPos(w.definition, w.word)) || '-';
        const def = esc(w.definition);
        const variant = esc(w.variant) || '-';
        const category = esc(w.category) + (w.subcategory ? '/' + esc(w.subcategory) : '') || '-';
        md += `| ${i + 1} | ${esc(w.word)} | ${pos} | #${w.rank} | ${w.frequency} | ${def} | ${variant} | ${category} | ${profNames[w.proficiency] || '-'} |\n`;
      });

      md += '\n---\n\n## 任务说明\n\n';
      md += '我刚背完上面这些单词。现在我要用其中一些单词写一段英文（句子或小故事）。\n';
      md += '请你在我写完后：\n';
      md += '1. 指出语法错误并修改\n';
      md += '2. 解释每个错误的原因\n';
      md += '3. 给出修改后的完整版本\n';
      md += '4. 检查我是否正确使用了今天学的单词，并解释这些单词的常见用法和搭配\n';
      md += '\n---\n\n## 我的写作\n\n';
      md += '（在这里粘贴你写的英文）\n';

      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vocab_${data.date}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    // 按熟练度导出单词为 Markdown 文件，按熟练度分组
    async function exportByProficiency() {
      if (selectedProfs.value.length === 0) {
        alert('请至少选择一个熟练度');
        return;
      }

      exporting.value = true;
      try {
        const profNames = {
          1: '完全不熟悉', 2: '熟悉但不记得', 3: '看了才记住',
          4: '勉强记住', 5: '正常记住', 6: '完全记住'
        };

        const grouped = await store.exportWordsByProficiency(selectedProfs.value);
        const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();

        const sortedProfs = [...selectedProfs.value].sort((a, b) => a - b);
        let totalCount = 0;
        for (const p of sortedProfs) totalCount += (grouped[p] || []).length;

        if (totalCount === 0) {
          alert('所选熟练度下暂无单词');
          return;
        }

        const today = DB.todayStr();
        let md = `# 单词熟练度词表（${today}导出）\n\n`;
        md += `共 ${totalCount} 个单词，按熟练度分组\n\n`;

        for (const prof of sortedProfs) {
          const words = grouped[prof] || [];
          if (words.length === 0) continue;
          md += `## ${profNames[prof]}（熟练度 ${prof}，${words.length} 词）\n\n`;
          md += '| 序号 | 单词 | 词性 | 词频排名 | 真题出现次数 | 释义 | 其他拼写 | 分类 | 首次学习 | 上次复习 |\n';
          md += '|------|------|------|----------|--------------|------|----------|------|----------|----------|\n';
          words.forEach((w, i) => {
            const pos = esc(extractPos(w.definition, w.word)) || '-';
            const def = esc(w.definition);
            const variant = esc(w.variant) || '-';
            const category = esc(w.category) + (w.subcategory ? '/' + esc(w.subcategory) : '') || '-';
            md += `| ${i + 1} | ${esc(w.word)} | ${pos} | #${w.rank} | ${w.frequency} | ${def} | ${variant} | ${category} | ${esc(w.firstLearned) || '-'} | ${esc(w.lastReview) || '-'} |\n`;
          });
          md += '\n';
        }

        md += '---\n\n## 任务说明\n\n';
        md += '上面是我按熟练度整理的单词表。现在我要用其中一些单词写一段英文（句子或小故事）。\n';
        md += '请你在我写完后：\n';
        md += '1. 指出语法错误并修改\n';
        md += '2. 解释每个错误的原因\n';
        md += '3. 给出修改后的完整版本\n';
        md += '4. 检查我是否正确使用了这些单词，并解释单词的常见用法和搭配\n';
        md += '\n---\n\n## 我的写作\n\n';
        md += '（在这里粘贴你写的英文）\n';

        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const profTag = sortedProfs.length === 6 ? 'all' : sortedProfs.join('-');
        a.download = `vocab_by_prof_${profTag}_${today}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        closeProfExportModal();
      } catch (e) {
        console.error('[Dashboard] 按熟练度导出失败:', e);
        alert('导出失败：' + e.message);
      } finally {
        exporting.value = false;
      }
    }

    // 熟练度配置（用于词表入口卡片）
    const profLevels = [
      { value: 0, name: '未学习', desc: '还没学过的词' },
      { value: 1, name: '完全不熟悉', desc: '根本没印象' },
      { value: 2, name: '熟悉但不记得', desc: '感觉背过但不记得' },
      { value: 3, name: '看了才记住', desc: '看中文才想起' },
      { value: 4, name: '勉强记住', desc: '想一会儿才想起' },
      { value: 5, name: '正常记住', desc: '偶尔忘记瞄两眼就想起' },
      { value: 6, name: '完全记住', desc: 'am/the 这种基础词' },
      { value: 'practice', name: '实战单词', desc: '截图刷题时汇入，复制语义' },
      { value: 'temp', name: '临时', desc: '复制暂存，不动原熟练度' }
    ];

    // 未学习单独放，其余熟练度排在顶部
    const studiedLevels = profLevels.filter(level => level.value !== 0);

    return {
      state: store.state,
      startStudy,
      startReview,
      viewWordList,
      exportTodayWords,
      exportByProficiency,
      showProfExportModal,
      selectedProfs,
      exporting,
      exportProfLevels,
      allSelected,
      toggleProf,
      isProfSelected,
      openProfExportModal,
      closeProfExportModal,
      profLevels,
      studiedLevels
    };
  },
  template: `
    <div class="dashboard">
      <!-- 覆盖率卡片 -->
      <div class="coverage-card">
        <div class="coverage-number">{{ state.coverage.coveragePercent }}%</div>
        <div class="coverage-label">真题文本覆盖率</div>
        <div style="font-size:12px;opacity:0.8;margin-top:8px;">
          已学习 {{ state.stats.learned }} / {{ state.stats.total }} 词
        </div>
      </div>

      <!-- 熟练度词表入口（置顶） -->
      <div class="wordlists-section">
        <div class="section-title">
          <span>熟练度词表</span>
          <button class="unlearned-link" @click="viewWordList(0)">
            未学习 {{ getProfCount(0) }} 词 →
          </button>
        </div>
        <div class="wordlists-grid">
          <div v-for="level in studiedLevels"
               :key="level.value"
               class="wordlist-card"
               :style="{ borderLeftColor: getProfColor(level.value) }"
               @click="viewWordList(level.value)">
            <div class="wordlist-name">{{ level.name }}</div>
            <div class="wordlist-count">{{ getProfCount(level.value) }}</div>
            <div class="wordlist-desc">{{ level.desc }}</div>
          </div>
        </div>
      </div>

      <!-- 今日主任务 -->
      <div class="task-card">
        <div class="task-title">今日主任务</div>
        <div class="task-desc">50 个新词（按词频降序）+ 30 个昨天不会的词</div>
        <button class="btn-primary" @click="startStudy">开始今日学习</button>
      </div>

      <!-- 第二任务 -->
      <div class="task-card">
        <div class="task-title">第二任务</div>
        <div class="task-desc">复习熟练度 1-4 的词表（完全不熟悉 / 熟悉但不记得 / 看了才记住 / 勉强记住）</div>
        <button class="btn-secondary" @click="startReview">开始复习</button>
      </div>

      <!-- 词群背诵 Beta -->
      <div class="task-card">
        <div class="task-title">词群背诵 <span class="beta-badge">Beta</span></div>
        <div class="task-desc">近义词、易混词、同词根词族成组背；支持遮释义、词频筛选、乱序和错题回队。不占每日 50+30 的任务。</div>
        <button class="btn-secondary" @click="$emit('clusters')">进入词群背诵</button>
      </div>

      <!-- 导出今日词汇 -->
      <div class="task-card">
        <div class="task-title">导出今日词汇</div>
        <div class="task-desc">导出今天学习的所有新词（Markdown 格式），含单词、词性、词频、释义、分类等。复制到 DeepSeek 让 AI 改你写的句子。</div>
        <button class="btn-secondary" @click="exportTodayWords">导出今日词汇</button>
      </div>

      <!-- 按熟练度导出 -->
      <div class="task-card">
        <div class="task-title">按熟练度导出</div>
        <div class="task-desc">导出已学单词，按熟练度分组（6 档可选），适合针对性复习或让 DeepSeek 改写。</div>
        <button class="btn-secondary" @click="openProfExportModal">按熟练度导出</button>
      </div>

      <!-- 按熟练度导出弹窗 -->
      <div v-if="showProfExportModal" class="modal-overlay" @click.self="closeProfExportModal">
        <div class="modal-content">
          <div class="modal-title">选择要导出的熟练度</div>
          <div class="modal-desc">勾选后导出对应熟练度的所有单词，按熟练度分组排列。</div>

          <label class="modal-checkall">
            <input type="checkbox" v-model="allSelected">
            <span>全选</span>
          </label>

          <div class="modal-prof-list">
            <label v-for="level in exportProfLevels"
                   :key="level.value"
                   class="modal-prof-item"
                   :class="{ checked: isProfSelected(level.value) }">
              <input type="checkbox"
                     :checked="isProfSelected(level.value)"
                     @change="toggleProf(level.value)">
              <div class="modal-prof-info">
                <div class="modal-prof-name">{{ level.name }}</div>
                <div class="modal-prof-count">{{ getProfCount(level.value) }} 词</div>
                <div class="modal-prof-desc">{{ level.desc }}</div>
              </div>
            </label>
          </div>

          <div class="modal-actions">
            <button class="btn-secondary" style="flex:1;" @click="closeProfExportModal" :disabled="exporting">取消</button>
            <button class="btn-primary" style="flex:1;" @click="exportByProficiency" :disabled="exporting">
              {{ exporting ? '导出中...' : '导出' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
  methods: {
    getProfCount(prof) {
      if (prof === 'temp') return this.state.tempCount || 0;
      if (prof === 'practice') return this.state.practiceCount || 0;
      return this.state.stats.byProficiency[prof] || 0;
    },
    getProfColor(prof) {
      const colors = {
        0: '#7d8ca6', 1: '#e11d48', 2: '#a855f7', 3: '#7c3aed',
        4: '#0284c7', 5: '#2563eb', 6: '#4338ca',
        practice: '#0284c7',
        temp: '#7c3aed'
      };
      return colors[prof] || '#7d8ca6';
    }
  }
};

window.Dashboard = Dashboard;
