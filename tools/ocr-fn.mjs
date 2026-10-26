/**
 * 本地跑 Netlify Function 的小壳子（本地预览没有 Netlify 运行时，但想用云端引擎）。
 *
 * 用法：stdin 进 JSON {httpMethod, body}，stdout 出 {statusCode, headers, body}
 *   node tools/ocr-fn.mjs netlify/functions/ocr.js
 *
 * 由 start.py 调起，密钥走进程环境变量（start.py 已把 .env 读进来）。
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const fnPath = path.resolve(process.argv[2] || 'netlify/functions/ocr.js');

let mod;
try {
  mod = require(fnPath);
} catch (e) {
  process.stdout.write(JSON.stringify({
    statusCode: 500,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ ok: false, error: '本地函数加载失败：' + ((e && e.message) || e) }),
  }));
  process.exit(0);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  let event;
  try {
    event = JSON.parse(raw || '{}');
  } catch {
    event = { httpMethod: 'POST', body: raw };
  }
  try {
    const res = await mod.handler(event);
    process.stdout.write(JSON.stringify(res || {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, error: '函数没有返回结果' }),
    }));
  } catch (e) {
    process.stdout.write(JSON.stringify({
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, error: String((e && e.message) || e) }),
    }));
  }
});
