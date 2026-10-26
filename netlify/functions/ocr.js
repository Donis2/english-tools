/**
 * Netlify Function：OCR 代理
 * 前端发图 + 指定引擎 -> 服务端调用识别接口 -> 返回纯文本行
 * 密钥只存在 Netlify 环境变量里，前端看不到：
 *   BAIDU_API_KEY / BAIDU_SECRET_KEY
 *   OCR_SPACE_KEY
 *
 * 引擎（payload.engine）：
 *   auto            自动（默认）：PaddleOCR-VL → 百度高精度 → 百度标准 → OCR.space
 *   paddle_vl       PaddleOCR-VL（AI Studio，最准，异步任务）
 *   easyocr         EasyOCR（按图片像素扣点，只手动选，不进自动链）
 *   ocrspace        OCR.space（免费额度大）
 *   baidu_accurate  百度高精度版（按次计费/有免费额度）
 *   baidu_general   百度标准版（免费）
 *
 * 返回里带 attempts（每次都试了哪个引擎、耗时、失败原因），
 * 前端据此显示「谁挂了、为什么、最后用了谁」，不再黑箱静默切换。
 * 所有引擎都失败时才由前端回退浏览器内 Tesseract。
 */
const TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
const OCR_ROOT = 'https://aip.baidubce.com/rest/2.0/ocr/v1/';
const OCRSPACE_URL = 'https://api.ocr.space/parse/image';
// PaddleOCR：异步任务，POST 提交 -> 轮询 jobId -> 下载 resultUrl.jsonUrl
const PADDLE_JOB_URL = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs';
const PADDLE_DEFAULT_MODEL = 'PaddleOCR-VL-1.6';
// EasyOCR：同步接口，按图片长边像素扣点
const EASYOCR_URL = 'https://console.easyocr.org/api/ocr';

const MB = 1024 * 1024;
const LABELS = {
  paddle_vl: 'PaddleOCR-VL',
  easyocr: 'EasyOCR',
  ocrspace: 'OCR.space',
  baidu_accurate: '百度 OCR 高精度版',
  baidu_general: '百度 OCR 标准版',
};
const BAIDU_APIS = {
  baidu_accurate: 'accurate_basic',
  baidu_general: 'general_basic',
};
// 图片体积上限（按原始字节算；OCR.space 免费版 1MB，百度 4MB base64 ≈ 3MB 原始）
const SIZE_LIMIT = {
  paddle_vl: 20 * MB,
  easyocr: 3 * MB,          // 官方硬上限
  ocrspace: 1 * MB,
  baidu_accurate: 3 * MB,
  baidu_general: 3 * MB,
};
// 函数整体预算：Netlify 同步函数 10s 上限，留出余量提前收尾
const TOTAL_BUDGET_MS = 8200;
// 给 PaddleOCR 的上限：它要「提交 + 轮询 + 下载」三步，冷启动实测 2~7s，
// 但必须给后面的百度留出 ~1.2s，否则一个慢任务会把整批时间吃光。
const PADDLE_BUDGET_MS = 6000;
const PADDLE_MIN_MS = 2600;

let cache = { token: '', exp: 0 };

class OcrError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;       // config | size | quota | auth | image | timeout | network | empty | other
  }
}

function respond(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(obj),
  };
}

function hasBaidu() {
  return !!(process.env.BAIDU_API_KEY && process.env.BAIDU_SECRET_KEY);
}

function configured(id) {
  if (id === 'paddle_vl') return !!process.env.PADDLE_TOKEN;
  if (id === 'easyocr') return !!process.env.EASYOCR_KEY;
  if (id === 'ocrspace') return !!process.env.OCR_SPACE_KEY;
  if (id === 'baidu_accurate' || id === 'baidu_general') return hasBaidu();
  return false;
}

function paddleModel() {
  return process.env.PADDLE_MODEL || PADDLE_DEFAULT_MODEL;
}

function statusBody() {
  const engines = {};
  let any = false;
  for (const id of Object.keys(LABELS)) {
    const ok = configured(id);
    any = any || ok;
    engines[id] = { label: LABELS[id], configured: ok };
    if (id === 'paddle_vl') engines[id].model = paddleModel();
  }
  return { ok: true, cloud: true, engines, anyConfigured: any };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new OcrError('timeout', `请求超时（${Math.round(ms / 1000)}s）`);
    }
    throw new OcrError('network', '网络请求失败：' + ((e && e.message) || e));
  } finally {
    clearTimeout(timer);
  }
}

async function getToken(force) {
  if (!force && cache.token && Date.now() < cache.exp) return cache.token;
  const key = process.env.BAIDU_API_KEY;
  const secret = process.env.BAIDU_SECRET_KEY;
  if (!key || !secret) throw new OcrError('config', '未配置 BAIDU_API_KEY / BAIDU_SECRET_KEY');
  const url = new URL(TOKEN_URL);
  url.searchParams.set('grant_type', 'client_credentials');
  url.searchParams.set('client_id', key);
  url.searchParams.set('client_secret', secret);
  let data;
  try {
    const res = await fetchTimeout(url, {}, 5000);
    data = await res.json();
  } catch (e) {
    throw e instanceof OcrError ? e : new OcrError('network', '获取 access_token 失败');
  }
  if (!data.access_token) {
    throw new OcrError('auth', '获取 access_token 失败：' + (data.error_description || data.error || '密钥不正确'));
  }
  cache = {
    token: data.access_token,
    exp: Date.now() + Math.max(60, (data.expires_in || 2592000) - 300) * 1000,
  };
  return cache.token;
}

function baiduCode(code) {
  if (code === 110 || code === 111 || code === 5 || code === 6) return 'auth';
  if (code === 17 || code === 18 || code === 19 || code === 4) return 'quota';
  if (code === 216201 || code === 216202 || code === 216203 || code === 216630) return 'image';
  return 'other';
}

async function baiduRequest(api, image, token, ms) {
  const form = new URLSearchParams();
  form.set('image', image);
  form.set('detect_direction', 'true');
  form.set('paragraph', 'false');
  form.set('probability', 'false');
  const res = await fetchTimeout(
    `${OCR_ROOT}${api}?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    },
    ms,
  );
  return res.json();
}

async function callBaidu(api, image, ms) {
  let data = await baiduRequest(api, image, await getToken(false), ms);
  // token 过期：清缓存后重试一次，别把一次鉴权抖动记成「引擎坏了」
  if (data.error_code === 110 || data.error_code === 111) {
    cache = { token: '', exp: 0 };
    data = await baiduRequest(api, image, await getToken(true), ms);
  }
  if (data.error_code) {
    throw new OcrError(
      baiduCode(data.error_code),
      `错误 ${data.error_code}：${data.error_msg || '未知'}`,
    );
  }
  return (data.words_result || [])
    .map(x => (x && x.words ? String(x.words).trim() : ''))
    .filter(Boolean);
}

async function callOcrSpace(image, mime, ms) {
  const key = process.env.OCR_SPACE_KEY;
  if (!key) throw new OcrError('config', '未配置 OCR_SPACE_KEY');
  const form = new URLSearchParams();
  form.set('apikey', key);
  form.set('base64Image', `data:image/${mime};base64,${image}`);
  form.set('language', 'eng');
  form.set('OCREngine', '2');            // 2 = 对英文/截图更准
  form.set('isOverlayRequired', 'false');
  form.set('detectOrientation', 'true');
  form.set('scale', 'true');
  form.set('filetype', mime === 'jpeg' ? 'JPG' : mime.toUpperCase());
  const res = await fetchTimeout(
    OCRSPACE_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    },
    ms,
  );
  const data = await res.json();
  if (data.IsErroredOnProcessing) {
    const msg = [].concat(data.ErrorMessage || data.ErrorDetails || '未知错误').join('；');
    const low = msg.toLowerCase();
    const code = /limit|quota|exceed|too many/.test(low) ? 'quota'
      : /size|large|big/.test(low) ? 'size'
      : /timed? ?out|timeout/.test(low) ? 'timeout'
      : 'other';
    throw new OcrError(code, msg);
  }
  const text = (data.ParsedResults || []).map(p => p.ParsedText || '').join('\n');
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------- PaddleOCR
function paddleCode(code) {
  if (code === 401 || code === 403) return 'auth';
  if (code === 429) return 'quota';
  if (code === 10007) return 'config';   // 模型传参错误
  if (code === 10001) return 'image';    // 空文件
  return 'other';
}

/** 从结果 JSON 抽文本行：PP-OCR 系列给逐行，VL 系列给版块 */
function paddleLines(data) {
  const result = (data && data.result) || {};
  const out = [];

  // PP-OCR 系列：ocrResults[].prunedResult.rec_texts（逐行 + 坐标 + 置信度）
  for (const page of result.ocrResults || []) {
    const pr = (page && page.prunedResult) || {};
    for (const t of pr.rec_texts || []) {
      const s = String(t == null ? '' : t).trim();
      if (s) out.push(s);
    }
  }
  if (out.length) return out;

  // VL 系列：layoutParsingResults[].prunedResult.parsing_res_list（按版块，段内保持原文）
  for (const page of result.layoutParsingResults || []) {
    const blocks = (page && page.prunedResult && page.prunedResult.parsing_res_list) || [];
    for (const b of blocks) {
      if (!b || !b.block_content) continue;
      for (const s of String(b.block_content).split(/\r?\n/)) {
        const t = s.trim();
        if (t) out.push(t);
      }
    }
    if (!blocks.length) {           // 兜底：老版本只给 markdown
      const md = (page && page.markdown && page.markdown.text) || '';
      for (const s of md.split(/\r?\n/)) {
        const t = s.trim();
        if (t) out.push(t);
      }
    }
  }
  return out;
}

async function callPaddle(image, mime, ms) {
  const token = process.env.PADDLE_TOKEN;
  if (!token) throw new OcrError('config', '未配置 PADDLE_TOKEN');
  const deadline = Date.now() + ms;
  const auth = { Authorization: `Bearer ${token}` };

  // 1) 提交任务（multipart，字段名固定 model / file）
  const form = new FormData();
  form.set('model', paddleModel());
  form.set(
    'file',
    new Blob([Buffer.from(image, 'base64')], { type: `image/${mime}` }),
    `upload.${mime === 'jpeg' ? 'jpg' : mime}`,
  );
  const sres = await fetchTimeout(
    PADDLE_JOB_URL,
    { method: 'POST', headers: auth, body: form },
    Math.min(ms, 7000),
  );
  const sj = await sres.json();
  if (sj.code !== 0) throw new OcrError(paddleCode(sj.code), `提交失败：${sj.msg || sj.code}`);
  const jobId = sj.data && sj.data.jobId;
  if (!jobId) throw new OcrError('other', '提交后没拿到任务 ID');

  // 2) 轮询：间隔 300ms 起、逐次拉长到 1.2s，别把接口打爆
  let job = null;
  let wait = 300;
  while (Date.now() < deadline - 600) {
    const left = deadline - Date.now();
    const r = await fetchTimeout(
      `${PADDLE_JOB_URL}/${encodeURIComponent(jobId)}`,
      { headers: auth },
      Math.min(5000, Math.max(1200, left)),
    );
    const j = await r.json();
    if (j.code !== 0) throw new OcrError(paddleCode(j.code), `查询任务失败：${j.msg || j.code}`);
    const state = j.data && j.data.state;
    if (state === 'done') { job = j.data; break; }
    if (state === 'failed') {
      const why = (j.data && (j.data.errorMsg || j.data.error)) || '识别失败';
      throw new OcrError(paddleCode(j.data && j.data.errorCode), String(why));
    }
    await sleep(wait);
    wait = Math.min(Math.round(wait * 1.5), 1200);
  }
  if (!job) throw new OcrError('timeout', '等待识别结果超时');

  // 3) 结果放在对象存储的临时地址上，需要再拉一次
  const jsonUrl = job.resultUrl && job.resultUrl.jsonUrl;
  if (!jsonUrl) throw new OcrError('other', '任务完成但没给结果地址');
  const rres = await fetchTimeout(jsonUrl, {}, Math.min(6000, Math.max(1500, deadline - Date.now())));
  const data = await rres.json();
  const lines = paddleLines(data);
  if (!lines.length) {
    const why = (data && (data.errorMsg || data.errorCode)) || '';
    throw new OcrError('empty', why && why !== 'Success' ? String(why) : '没认出文字');
  }
  return lines;
}

// ---------------------------------------------------------------- EasyOCR
function easyCode(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 404) return 'config';
  if (status === 400) return 'image';
  return 'other';
}

async function callEasyOcr(image, mime, ms) {
  const key = process.env.EASYOCR_KEY;
  if (!key) throw new OcrError('config', '未配置 EASYOCR_KEY');
  const bin = Buffer.from(image, 'base64');
  const buildForm = () => {
    const form = new FormData();
    form.set('file', new Blob([bin], { type: `image/${mime}` }), `upload.${mime === 'jpeg' ? 'jpg' : mime}`);
    return form;
  };
  const send = () => fetchTimeout(
    EASYOCR_URL,
    { method: 'POST', headers: { 'X-Access-Key': key }, body: buildForm() },
    ms,
  );

  let res;
  try {
    res = await send();
  } catch (e) {
    // 这个接口实测偶尔会直接断连（不是鉴权/额度问题），重试一次再判失败
    if (e && e.code === 'network') res = await send();
    else throw e;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new OcrError('other', `返回不是 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const why = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    throw new OcrError(easyCode(res.status), String(why));
  }
  // 按版面从上到下、从左到右排一遍，别依赖接口返回顺序
  const blocks = (data.words || []).slice().sort((a, b) => (a.top - b.top) || (a.left - b.left));
  const lines = blocks.map(w => String((w && w.text) || '').trim()).filter(Boolean);
  if (!lines.length) throw new OcrError('empty', '没认出文字');
  return lines;
}

async function runEngine(name, image, mime, ms) {
  if (name === 'paddle_vl') return callPaddle(image, mime, ms);
  if (name === 'easyocr') return callEasyOcr(image, mime, ms);
  if (name === 'ocrspace') return callOcrSpace(image, mime, ms);
  return callBaidu(BAIDU_APIS[name], image, ms);
}

/** 选择顺序：auto 用 PaddleOCR-VL 打头（更准），失败再退百度 / OCR.space。
 *  EasyOCR 按点计费，只手动选，不进 auto 链。 */
function buildChain(prefer) {
  const chains = {
    paddle_vl: ['paddle_vl', 'baidu_accurate', 'baidu_general', 'ocrspace'],
    easyocr: ['easyocr', 'paddle_vl', 'baidu_accurate'],
    ocrspace: ['ocrspace', 'baidu_accurate', 'baidu_general', 'paddle_vl'],
    baidu_accurate: ['baidu_accurate', 'baidu_general', 'ocrspace', 'paddle_vl'],
    baidu_general: ['baidu_general', 'baidu_accurate', 'ocrspace', 'paddle_vl'],
  };
  if (chains[prefer]) return { preferred: prefer, chain: chains[prefer] };
  return { preferred: 'auto', chain: ['paddle_vl', 'baidu_accurate', 'baidu_general', 'ocrspace'] };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return respond(204, {});
  // 状态探测：页面上先问一句「云端在不在、哪些引擎配了密钥」
  if (event.httpMethod === 'GET') return respond(200, statusBody());
  if (event.httpMethod !== 'POST') return respond(405, { ok: false, error: '只支持 GET / POST' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { ok: false, error: '请求体不是合法 JSON' });
  }
  if (payload.action === 'status') return respond(200, statusBody());

  try {
    const m = /^data:image\/([^;]+);base64,(.*)$/s.exec(payload.image || '');
    if (!m) return respond(400, { ok: false, error: '没有收到有效的图片' });
    const [, mime, image] = m;

    const bytes = Math.floor(image.length * 3 / 4);        // base64 -> 原始字节
    const { preferred, chain } = buildChain(payload.engine);
    const deadline = Date.now() + TOTAL_BUDGET_MS;
    const attempts = [];

    for (const name of chain) {
      const label = LABELS[name];
      const fail = (code, error) => attempts.push({ engine: name, label, ok: false, code, error, ms: 0 });

      if (!configured(name)) { fail('config', '未配置密钥'); continue; }
      if (bytes > SIZE_LIMIT[name]) {
        fail('size', `图片 ${(bytes / MB).toFixed(2)}MB 超过该引擎上限`);
        continue;
      }
      const remain = deadline - Date.now();
      const need = name === 'paddle_vl' ? PADDLE_MIN_MS : 900;
      if (remain < need) {
        fail('timeout', remain < 900 ? '整体超时，未尝试' : '剩余时间不够跑这个引擎');
        continue;
      }
      // PaddleOCR 是「提交 + 轮询 + 下载」，给它独立预算，并且在后面给百度留 1.2s，
      // 免得一个慢任务把整批耗时吃光、连备用引擎都没机会试。
      const budget = name === 'paddle_vl'
        ? Math.min(PADDLE_BUDGET_MS, Math.max(1200, remain - 1200))
        : Math.min(remain - 300, 8000);

      const t0 = Date.now();
      try {
        const lines = await runEngine(name, image, mime, budget);
        const ms = Date.now() - t0;
        if (lines && lines.length) {
          attempts.push({ engine: name, label, ok: true, code: '', error: '', ms });
          return respond(200, {
            ok: true,
            lines,
            num: lines.length,
            endpoint: name,
            label,
            preferred,
            fallback: attempts.filter(a => !a.ok).length > 0,
            attempts,
            bytes,
          });
        }
        attempts.push({ engine: name, label, ok: false, code: 'empty', error: '没认出文字', ms });
      } catch (e) {
        attempts.push({
          engine: name,
          label,
          ok: false,
          code: (e && e.code) || 'other',
          error: (e && e.message) || String(e),
          ms: Date.now() - t0,
        });
      }
    }

    const reasons = attempts
      .filter(a => !a.ok)
      .map(a => `${a.label}：${a.error}`)
      .join('；');
    return respond(200, {
      ok: false,
      error: reasons || '没有识别到文字',
      preferred,
      attempts,
      bytes,
    });
  } catch (err) {
    return respond(500, { ok: false, error: String((err && err.message) || err) });
  }
};
