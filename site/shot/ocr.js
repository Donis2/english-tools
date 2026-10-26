/* 纯前端 OCR + 词频匹配（Tesseract.js + vocab.json）
 * 不依赖任何后端；所有识别都在浏览器本地完成。
 */
(function (global) {
  'use strict';

  const WORD_RE = /[A-Za-z]+(?:['\u2019\-][A-Za-z]+)*/g;
  const TERMINAL_PUNCT = ".!?;:。！？；：…";
  const BULLET_RE = /^\s*(?:[-*•·○◦▪‣–—]|\(?\d{1,2}[.)、]|（\d{1,2}）|[①-⑳])/;

  const Vocab = {
    byKey: new Map(),
    aliases: {},
    loaded: false,
  };

  // ---------------------------------------------------------------- 词频表
  async function loadVocab(url) {
    if (Vocab.loaded) return;
    const res = await fetch(url || 'vocab.json');
    if (!res.ok) throw new Error('词频表加载失败');
    const data = await res.json();
    for (const e of data.entries) {
      Vocab.byKey.set(e.w.toLowerCase(), e);
    }
    Vocab.aliases = data.aliases || {};
    Vocab.loaded = true;
  }

  function lemmaCandidates(w) {
    const out = [];
    if (w.endsWith("'s") || w.endsWith("\u2019s")) out.push(w.slice(0, -2));
    if (w.endsWith('ies') && w.length > 4) out.push(w.slice(0, -3) + 'y');
    if (w.endsWith('es')) out.push(w.slice(0, -2));
    if (w.endsWith('s') && !w.endsWith('ss')) out.push(w.slice(0, -1));
    if (w.endsWith('ing') && w.length > 5) {
      const stem = w.slice(0, -3);
      out.push(stem, stem + 'e');
      if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
        out.push(stem.slice(0, -1));
      }
    }
    if (w.endsWith('ed') && w.length > 4) {
      const stem = w.slice(0, -2);
      out.push(stem, stem + 'e', w.slice(0, -1));
      if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
        out.push(stem.slice(0, -1));
      }
    }
    if (w.endsWith('er') && w.length > 4) out.push(w.slice(0, -2), w.slice(0, -1));
    if (w.endsWith('est') && w.length > 5) out.push(w.slice(0, -3), w.slice(0, -2));
    if (w.endsWith('ly') && w.length > 4) out.push(w.slice(0, -2));
    const seen = new Set();
    return out.filter(c => c && c !== w && !seen.has(c) && seen.add(c));
  }

  function lookup(token) {
    const key = token.toLowerCase();
    let e = Vocab.byKey.get(key);
    if (e) return { entry: e, inflected: false };
    if (Vocab.aliases[key]) {
      e = Vocab.byKey.get(Vocab.aliases[key]);
      if (e) return { entry: e, inflected: false };
    }
    for (const base of lemmaCandidates(key)) {
      e = Vocab.byKey.get(base);
      if (e) return { entry: e, inflected: true };
      if (Vocab.aliases[base]) {
        e = Vocab.byKey.get(Vocab.aliases[base]);
        if (e) return { entry: e, inflected: true };
      }
    }
    return null;
  }

  function tierOf(rank) {
    return rank <= 1000 ? 'high' : (rank <= 3000 ? 'mid' : 'low');
  }

  function normalizeSpaces(s) {
    return s.replace(/[ \t\u3000]+/g, ' ').trim();
  }

  function tokenize(text) {
    const spans = [];
    let n = 0;
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(text)) !== null) {
      n += 1;
      const found = lookup(m[0]);
      if (found) spans.push([m.index, m.index + m[0].length, m[0], found.entry, found.inflected]);
    }
    return { n, spans };
  }

  function buildText(words, stats) {
    if (!words.length) {
      return `未识别到词频表内的单词。\n（共识别英文单词 ${stats.total_words} 个）`;
    }
    const ws = words.slice().sort((a, b) => a.rank - b.rank);
    const wmax = Math.max(...ws.map(w => w.word.length));
    const head = `考研词频标注  命中 ${stats.matched_unique} 词 / 识别 ${stats.total_words} 词\n` + '─'.repeat(46);
    const body = ws.map(w =>
      `${w.word.padEnd(wmax)}  词频 ${String(w.freq).padEnd(6)}第${w.rank}名  ${w.meaning}`);
    return head + '\n' + body.join('\n');
  }

  function assemble(parsed, nWords, elapsed) {
    const groups = new Map();
    const order = [];
    let nOcc = 0;
    for (const [, spans] of parsed) {
      for (const sp of spans) {
        nOcc += 1;
        const entry = sp[3];
        const k = entry.w.toLowerCase();
        if (!groups.has(k)) {
          groups.set(k, { entry, count: 0, forms: new Set(), inflected: false });
          order.push(k);
        }
        const g = groups.get(k);
        g.count += 1;
        g.forms.add(sp[2]);
        g.inflected = g.inflected || sp[4];
      }
    }
    const idxOf = new Map(order.map((k, i) => [k, i]));
    const words = order.map(k => {
      const g = groups.get(k);
      const e = g.entry;
      return {
        word: e.w, freq: e.f, rank: e.r, tier: tierOf(e.r), meaning: e.m,
        alt: e.a || '', category: e.c || '', subcategory: e.s || '',
        count: g.count, forms: [...g.forms].sort(), inflected: g.inflected,
      };
    });
    const lines = parsed.map(([text, spans]) => ({
      text,
      spans: spans.map(sp => [sp[0], sp[1], idxOf.get(sp[3].w.toLowerCase())]),
    }));
    const stats = {
      total_words: nWords,
      matched_unique: words.length,
      matched_occurrences: nOcc,
      elapsed: Math.round(elapsed * 100) / 100,
    };
    return { ok: true, stats, words, lines, text: buildText(words, stats) };
  }

  // ---------------------------------------------------------- 段落重建
  function joinTwo(prev, cur) {
    if (prev.endsWith('-')) {
      const head = prev.slice(prev.lastIndexOf(' ') + 1).toLowerCase();
      const tail = cur.split(' ', 1)[0].toLowerCase();
      if (Vocab.byKey.has(head.slice(0, -1) + tail)) return prev.slice(0, -1) + cur;
      return prev + cur;                       // 还原不了就保留
    }
    return prev + ' ' + cur;
  }

  function joinLines(texts) {
    let out = texts[0].trim();
    for (let i = 1; i < texts.length; i++) {
      const t = texts[i].trim();
      if (t) out = joinTwo(out, t);
    }
    return normalizeSpaces(out);
  }

  function groupParagraphs(items) {
    const heights = items.map(i => i.height).filter(h => h > 1);
    const lh = heights.length
      ? heights.slice().sort((a, b) => a - b)[Math.floor(heights.length / 2)]
      : 20;
    const gaps = [];
    for (let i = 1; i < items.length; i++) gaps.push(items[i].top - (items[i - 1].top + items[i - 1].height));
    const baseGap = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : lh * 0.3;

    const paras = [];
    let cur = [];
    for (const it of items) {
      if (!cur.length) { cur = [it]; continue; }
      const prev = cur[cur.length - 1];
      const newPara =
        (it.top - (prev.top + prev.height) > baseGap + lh * 0.7) ||
        (it.left - prev.left > lh * 1.3) ||
        (prev.text && TERMINAL_PUNCT.indexOf(prev.text[prev.text.length - 1]) >= 0) ||
        BULLET_RE.test(it.text);
      if (newPara) { paras.push(cur); cur = [it]; }
      else cur.push(it);
    }
    if (cur.length) paras.push(cur);
    return paras;
  }

  // ---------------------------------------------------------------- OCR
  let workerPromise = null;
  let readyHandler = null;

  // 本地引擎的脚本 + worker + wasm 核心都给几个源，jsdelivr 连不上就自动换下一个
  // （这台机器连不上 jsdelivr，以前「回退本地」等于直接失效）
  const TESSERACT_SOURCES = [
    {
      script: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
      worker: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
      core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0',
    },
    {
      script: 'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js',
      worker: 'https://unpkg.com/tesseract.js@5.1.1/dist/worker.min.js',
      core: 'https://unpkg.com/tesseract.js-core@5.1.0',
    },
    {
      script: 'https://registry.npmmirror.com/tesseract.js/5.1.1/files/dist/tesseract.min.js',
      worker: 'https://registry.npmmirror.com/tesseract.js/5.1.1/files/dist/worker.min.js',
      core: 'https://registry.npmmirror.com/tesseract.js-core/5.1.0/files',
    },
    // 想彻底离线：把这三个文件放进 site/shot/vendor/tesseract/ 就会优先命中（放最后，没有就 404 略过）
    {
      script: 'vendor/tesseract/tesseract.min.js',
      worker: 'vendor/tesseract/worker.min.js',
      core: 'vendor/tesseract',
    },
  ];
  let tessSource = null;
  let tessLoading = null;

  function onProgress(fn) { readyHandler = fn; }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve(src);
      s.onerror = () => { s.remove(); reject(new Error('加载失败：' + src)); };
      document.head.appendChild(s);
    });
  }

  async function loadTesseract() {
    if (typeof Tesseract !== 'undefined' && tessSource) return tessSource;
    if (tessLoading) return tessLoading;
    tessLoading = (async () => {
      for (const src of TESSERACT_SOURCES) {
        try {
          await loadScript(src.script);
          if (typeof Tesseract !== 'undefined') return src;
        } catch (e) { /* 换下一个源 */ }
      }
      throw new Error('本地 OCR 脚本加载失败（jsdelivr / unpkg / npmmirror 都连不上）');
    })();
    return tessLoading;
  }

  async function ensureWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      const src = await loadTesseract();
      tessSource = src;
      if (readyHandler) readyHandler({ status: 'initializing tesseract' });
      const worker = await Tesseract.createWorker('eng', 1, {
        langPath: '.',                  // 同站点根目录的 eng.traineddata.gz
        gzip: true,
        workerPath: src.worker,
        corePath: src.core,
        logger: m => {
          if (readyHandler && m && m.status) readyHandler(m);
        },
      });
      await worker.setParameters({
        tessedit_pageseg_mode: '3',    // 自动分页/分块
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });
      return worker;
    })();
    try {
      return await workerPromise;
    } catch (e) {
      workerPromise = null;           // 失败不缓存，下次还能重试
      throw e;
    }
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        // 小图放大有助于 Tesseract 提升准确率
        const scale = img.width < 1100 ? 2 : 1;
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  function extractLines(data) {
    const out = [];
    const blocks = data.blocks || [];
    for (const b of blocks) {
      for (const p of (b.paragraphs || [])) {
        for (const l of (p.lines || [])) {
          const text = normalizeSpaces(l.text || '');
          if (!text) continue;
          const bb = l.bbox || {};
          out.push({
            text,
            top: bb.y0 || 0,
            left: bb.x0 || 0,
            height: (bb.y1 || 0) - (bb.y0 || 0) || 20,
          });
        }
      }
    }
    if (out.length) return out;
    // 兜底：没有 blocks 时按文本换行切
    return String(data.text || '')
      .split('\n').map(t => normalizeSpaces(t)).filter(Boolean)
      .map(t => ({ text: t, top: 0, left: 0, height: 20 }));
  }

  // ------------------------------------------------- 云端 OCR（PaddleOCR / 百度 / OCR.space）
  const CLOUD_ENDPOINT = '/.netlify/functions/ocr';
  const ENGINE_LABELS = {
    auto: '自动选择',
    paddle_vl: 'PaddleOCR-VL',
    easyocr: 'EasyOCR',
    baidu_accurate: '百度 OCR 高精度版',
    baidu_general: '百度 OCR 标准版',
    ocrspace: 'OCR.space',
    local: 'Tesseract.js（本地）',
  };
  // 结果里用的短名，长名字塞进 chip 太挤
  const ENGINE_SHORT = {
    paddle_vl: 'PaddleOCR-VL',
    easyocr: 'EasyOCR',
    ocrspace: 'OCR.space',
    baidu_accurate: '百度高精度版',
    baidu_general: '百度标准版',
    local: '本地 Tesseract',
  };
  // 失败原因 → 一句人话
  const CODE_TEXT = {
    config: '未配置密钥',
    size: '图片超出上限',
    quota: '额度/频率受限',
    auth: '鉴权失败',
    image: '图片无法识别',
    timeout: '超时',
    network: '网络失败',
    empty: '没认出文字',
    other: '调用失败',
  };

  // 引擎可用性：进页面探一次，之后按需复用
  const cloudState = {
    checked: false,
    deployed: false,
    engines: {},
    anyConfigured: false,
    checkedAt: 0,
    error: '',
    reason: '',        // missing = 函数没部署；error = 探测失败（网络等）
    deadUntil: 0,      // 云端整体不可用时的冷却期，避免每张图都白等一次
  };
  const PROBE_TTL = 5 * 60 * 1000;
  const DEAD_COOLDOWN = 60 * 1000;

  function fetchTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
      .catch(e => {
        if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
          const err = new Error('请求超时');
          err.code = 'timeout';
          throw err;
        }
        throw e;
      })
      .finally(() => clearTimeout(timer));
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  /** 探测云端函数是否部署、各引擎有没有配密钥。force=true 时强制重查。 */
  async function probe(force) {
    const fresh = cloudState.checked && Date.now() - cloudState.checkedAt < PROBE_TTL;
    if (!force && fresh) return cloudState;
    cloudState.error = '';
    try {
      const res = await fetchTimeout(CLOUD_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status' }),
      }, 7000);
      if (!res.ok) {
        const err = new Error(res.status === 404 ? '云端函数未部署' : 'HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      const j = await res.json();
      cloudState.deployed = !!(j && j.ok);
      cloudState.engines = (j && j.engines) || {};
      cloudState.anyConfigured = (j && typeof j.anyConfigured === 'boolean')
        ? j.anyConfigured
        : Object.values(cloudState.engines).some(e => e.configured);
      cloudState.reason = '';
      cloudState.deadUntil = 0;
    } catch (e) {
      cloudState.deployed = false;
      cloudState.engines = {};
      cloudState.anyConfigured = false;
      cloudState.error = (e && e.message) || String(e);
      // 404/405/501 = 这个环境根本没有云函数（本地 python 静态服务就是），不必再重试
      const st = e && e.status;
      cloudState.reason = (st === 404 || st === 405 || st === 501) ? 'missing' : 'error';
    }
    cloudState.checked = true;
    cloudState.checkedAt = Date.now();
    return cloudState;
  }

  async function cloudOcr(file, engine) {
    // 太大先压一压，别一上来就因体积被判失败。
    // PaddleOCR 内部会把长边缩到 960 再识别，传原尺寸反而白等（实测 2600px 要 6s+），
    // 所以先缩到 1800：画质够用，上传和服务端都快。其余引擎按各自体积上限压。
    const MB = 1024 * 1024;
    const isPaddle = engine === 'paddle_vl' || engine === 'auto';
    const target = engine === 'ocrspace' ? 0.95 * MB
      : isPaddle ? 6 * MB
      : 2.8 * MB;                                // 百度 3MB、EasyOCR 3MB 的共同安全线
    const maxSide = isPaddle ? 1800 : 2600;
    const upload = await shrinkForCloud(file, target, maxSide);
    const dataUrl = await fileToDataURL(upload);
    let res;
    try {
      res = await fetchTimeout(CLOUD_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, engine }),
      }, 28000);
    } catch (e) {
      const err = new Error('云端 OCR 请求失败：' + ((e && e.message) || e));
      err.cloudDown = true;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(res.status === 404
        ? '云端 OCR 未部署（本地预览只有浏览器内引擎）'
        : '云端 OCR 不可用（HTTP ' + res.status + '）');
      err.cloudDown = res.status === 404 || res.status >= 500;
      throw err;
    }
    const j = await res.json();
    const lines = (j.lines || []).map(t => normalizeSpaces(t)).filter(Boolean);
    if (!j.ok || !lines.length) {
      const err = new Error(j.error || '云端 OCR 没有返回文字');
      err.attempts = j.attempts || [];
      throw err;
    }
    return { lines, endpoint: j.endpoint || '', attempts: j.attempts || [], shrunk: upload !== file };
  }

  /* 大图先缩到云端吃得快的尺寸：体积超标或长边超限才处理，
     省掉「因为太大被每个引擎拒绝」和「服务端慢慢缩图」两种白跑。 */
  function imageSize(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { resolve({ w: img.width, h: img.height }); URL.revokeObjectURL(url); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  function drawToCanvas(file, maxSide) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';                 // 透明底转白，识别更稳
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  async function shrinkForCloud(file, targetBytes = 1.4 * 1024 * 1024, maxSide = 2600) {
    if (!file) return file;
    let long = 0;
    try {
      const { w, h } = await imageSize(file);
      long = Math.max(w, h);
    } catch (e) {
      long = 0;                                  // 读不出尺寸就只按体积判断
    }
    if (long <= maxSide && file.size <= targetBytes) return file;

    const canvas = await drawToCanvas(file, maxSide);
    for (const quality of [0.92, 0.85, 0.75, 0.65, 0.55]) {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
      if (blob && blob.size <= targetBytes) {
        return new File([blob], (file.name || 'image').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
      }
    }
    return file;                                 // 压不下去就原样发，交给服务端按上限换引擎
  }

  function mergeByPunct(lines) {
    const paras = [];
    let cur = [];
    for (const line of lines) {
      if (cur.length && TERMINAL_PUNCT.indexOf(cur[cur.length - 1].slice(-1)) >= 0) {
        paras.push(cur); cur = [];
      }
      cur.push(line);
    }
    if (cur.length) paras.push(cur);
    return paras.map(joinLines);
  }

  /* PaddleOCR-VL 按「版块」返回，一段可能好几百字符；逐行模式下按句软拆，
     否则整段挤成一行既难看也没法逐词点。 */
  function splitLongLines(lines, max = 260) {
    const out = [];
    for (const line of lines) {
      if (line.length <= max) { out.push(line); continue; }
      const parts = line.split(/(?<=[.!?])\s+/);
      let buf = '';
      for (const p of parts) {
        if (buf && (buf.length + 1 + p.length) > max) { out.push(buf); buf = p; }
        else buf = buf ? buf + ' ' + p : p;
      }
      if (buf) out.push(buf);
    }
    return out;
  }

  async function analyze(file, opts) {
    const merge = !!(opts && opts.merge);
    const prefer = (opts && opts.engine) || 'auto';
    const t0 = performance.now();
    await loadVocab();

    let texts = null;
    let engineId = '';
    let attempts = [];
    let cloudError = '';
    let shrunk = false;

    // 云端：明确选「本地」就不上传；已知云端不在（未部署/没密钥/冷却期）就直接跳过，别每张图白等一次
    const wantCloud = prefer !== 'local';
    const cs = cloudState;
    const cloudKnownOff = cs.checked && (cs.reason === 'missing' || (cs.deployed && !cs.anyConfigured));
    if (wantCloud) {
      if (cloudKnownOff) {
        cloudError = cs.reason === 'missing' ? '云端 OCR 未部署' : '云端引擎都没配密钥';
      } else if (Date.now() < cs.deadUntil) {
        cloudError = '云端 OCR 暂不可用，已直接用本地引擎';
      } else {
        try {
          const r = await cloudOcr(file, prefer);
          texts = merge ? mergeByPunct(r.lines) : splitLongLines(r.lines);
          engineId = r.endpoint || '';
          attempts = r.attempts;
          shrunk = !!r.shrunk;
        } catch (e) {
          cloudError = (e && e.message) ? e.message : String(e);
          attempts = (e && e.attempts) || [];
          if (e && e.cloudDown) {
            cloudState.deadUntil = Date.now() + DEAD_COOLDOWN;
            cloudState.deployed = false;
            cloudState.checkedAt = Date.now();
          }
        }
      }
    }

    if (!texts || !texts.length) {
      try {
        const worker = await ensureWorker();
        const canvas = await loadImage(file);
        const { data } = await worker.recognize(canvas, { blocks: true });
        const items = extractLines(data);
        if (merge && items.some(i => i.height > 1)) {
          texts = groupParagraphs(items).map(para => joinLines(para.map(i => i.text)));
        } else if (merge) {
          texts = mergeByPunct(items.map(i => i.text));
        } else {
          texts = items.map(i => i.text);
        }
        engineId = 'local';
      } catch (e) {
        const why = cloudError ? `云端：${cloudError}；` : '';
        throw new Error(`${why}本地识别也失败：${(e && e.message) || e}`);
      }
    }

    let nWords = 0;
    const parsed = texts.map(t => {
      const r = tokenize(t);
      nWords += r.n;
      return [t, r.spans];
    });
    const result = assemble(parsed, nWords, (performance.now() - t0) / 1000);
    result.engineId = engineId;
    result.engine = ENGINE_SHORT[engineId] || engineId || '未知';
    result.attempts = attempts;
    result.preferred = prefer;
    result.shrunk = shrunk;
    if (cloudError) result.cloudError = cloudError;
    return result;
  }

  function rematch(text) {
    const t0 = performance.now();
    let nWords = 0;
    const parsed = String(text).split('\n').map(line => {
      const t = normalizeSpaces(line);
      const r = tokenize(t);
      nWords += r.n;
      return [t, r.spans];
    });
    return assemble(parsed, nWords, (performance.now() - t0) / 1000);
  }

  global.OcrApp = {
    loadVocab, analyze, rematch, onProgress, ensureWorker, probe,
    ENGINE_LABELS, ENGINE_SHORT, CODE_TEXT, cloudState,
    tessSource: () => tessSource,     // 排查「本地引擎从哪个源加载的」
  };
})(window);