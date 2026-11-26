/**
 * Netlify Function：划词翻译代理
 * 前端选中英文句子 -> 这里调用大模型接口 -> 返回中文译文
 *
 * 两种用法：
 * 1) 默认：读服务端环境变量（推荐，key 不下发到浏览器）
 *      TRANSLATE_API_KEY     必填，接口 key
 *      TRANSLATE_MODEL       可选，默认 qwen-flash
 *      TRANSLATE_API_BASE    可选，默认通义千问兼容模式，换别的 OpenAI 兼容服务时填
 * 2) 前端「设置 → AI · API」里填了 API 地址 / Key / 模型时，以页面设置为准（单人自用方便换服务）
 *
 * 同一段文字会缓存，重复翻译不重复扣额度。
 */

const DEFAULT_API_BASE = 'https://maas.qianwenaiapi.com/compatible-mode/v1';
const MAX_CHARS = 3000;          // 一次最多翻多少字符，防止误选整页
const CACHE_MAX = 300;          // 进程内缓存条数
const TIMEOUT_MS = 20000;

const cache = new Map();

const SYSTEM_PROMPT =
  '你是专业的英译中译者。只输出中文译文：不要解释、不要加引号、不要保留英文原文、不要加“译文：”这类前缀。' +
  '遇到人名、地名、术语按通行译法；原文是完整句子时译成通顺的中文，不要逐词硬译。';

function respond(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  };
}

/**
 * 把用户填的 API 地址规整成 chat/completions 端点。
 * 只允许公网 http(s)，挡掉 localhost / 内网地址，避免服务端被当成跳板。
 */
function resolveEndpoint(raw) {
  const base = String(raw || '').trim() || process.env.TRANSLATE_API_BASE || DEFAULT_API_BASE;
  let u;
  try {
    u = new URL(base);
  } catch {
    return '';
  }
  if (!/^https?:$/.test(u.protocol)) return '';
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '::1' || host === '[::1]') return '';
  if (/^(0\.|10\.|127\.|169\.254\.|192\.168\.)/.test(host)) return '';
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return '';
  let path = u.pathname.replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(path)) path += '/chat/completions';
  return u.origin + path;
}

function modelName(raw) {
  return String(raw || '').trim() || process.env.TRANSLATE_MODEL || 'qwen-flash';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return respond(204, {});
  if (event.httpMethod !== 'POST') return respond(405, { ok: false, error: '只支持 POST' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { ok: false, error: '请求体不是合法 JSON' });
  }

  // 页面里填了就优先用页面的，否则回落到服务端环境变量
  const endpoint = resolveEndpoint(payload.apiBase);
  const key = String(payload.apiKey || '').trim() || process.env.TRANSLATE_API_KEY;
  if (!endpoint) return respond(200, { ok: false, error: 'API 地址无效（只支持公网 http/https）' });
  if (!key) return respond(200, { ok: false, error: '还没有配置 API Key：去「设置 → AI · API」填，或在 Netlify 加 TRANSLATE_API_KEY' });

  // 兜底清洗：前端已去掉词频角标，这里再把多余空白压掉
  const text = String(payload.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return respond(400, { ok: false, error: '没有收到要翻译的文字' });
  if (!/[a-zA-Z]/.test(text)) return respond(400, { ok: false, error: '没有可翻译的英文内容' });
  if (text.length > MAX_CHARS) {
    return respond(400, { ok: false, error: `一次最多翻译 ${MAX_CHARS} 个字符，请缩短选区` });
  }

  const model = modelName(payload.model);
  const isTest = payload.test === true;          // 「测试连接」用短输出，且不读写缓存
  const cacheKey = endpoint + '|' + model + '|' + text;
  if (!isTest && cache.has(cacheKey)) {
    return respond(200, { ok: true, translation: cache.get(cacheKey), cached: true });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: isTest ? 64 : 4096,   // 部分模型会先花思考 token，给足余量
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
      signal: ctrl.signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (data && data.error && (data.error.message || data.error)) || `HTTP ${res.status}`;
      return respond(200, { ok: false, error: '翻译服务：' + detail });
    }

    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    const translation = String((msg && msg.content) || '').trim();
    if (!translation) return respond(200, { ok: false, error: '翻译服务没有返回内容，请稍后再试' });

    if (cache.size >= CACHE_MAX) cache.clear();
    if (!isTest) cache.set(cacheKey, translation);
    return respond(200, { ok: true, translation, model, endpoint });
  } catch (err) {
    const isTimeout = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return respond(200, {
      ok: false,
      error: isTimeout ? '翻译超时，请缩短选区再试' : '翻译请求失败：' + ((err && err.message) || err),
    });
  } finally {
    clearTimeout(timer);
  }
};
