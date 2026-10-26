#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
英语工具 English Tool · 本地启动器

做三件事，省掉手动改端口、手动敲网址：
  1. 自动挑一个空闲端口（默认从 8090 开始往上找），所以就算旧项目占着 8090 也不会失败；
  2. 起一个静态服务，根目录是 site/；
  3. 自动打开浏览器到首页（导航页）。

另外：如果同目录旁边的「单词文章记忆/html」存在，会把它挂在 /novel/ 下，
首页的「单词小说」卡片就能直接点进去。不需要复制文件，那边重新构建后刷新即可。
"""

import argparse
import json
import os
import posixpath
import shutil
import socket
import subprocess
import sys
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE_DIR = os.path.join(ROOT, "site")
NOVEL_DIR = os.path.normpath(os.path.join(ROOT, "..", "单词文章记忆", "html"))
ENV_FILE = os.path.join(ROOT, ".env")
FN_SCRIPT = os.path.join(ROOT, "tools", "ocr-fn.mjs")
FN_PATH = os.path.join(ROOT, "netlify", "functions", "ocr.js")

FN_PREFIX = "/.netlify/functions/"


def load_env(path=ENV_FILE):
    """把 .env 里的 KEY=VALUE 读进环境变量（已存在的同名变量不覆盖）。"""
    if not os.path.isfile(path):
        return
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and value:
                    os.environ.setdefault(key, value)
    except OSError as e:
        sys.stderr.write("  [警告] 读 .env 失败：%s\n" % e)


class Handler(SimpleHTTPRequestHandler):
    """静态文件 + /novel/ 外挂目录 + 本地跑 Netlify Function + 关掉缓存。"""

    def translate_path(self, path):
        raw = urlsplit(path).path
        if raw == "/novel" or raw.startswith("/novel/"):
            base = NOVEL_DIR
            raw = raw[len("/novel"):] or "/"
        else:
            base = SITE_DIR

        # 逐段过滤，挡掉 .. 之类的越界路径
        clean = posixpath.normpath(unquote(raw))
        parts = [p for p in clean.split("/") if p and p not in (".", "..")]
        return os.path.join(base, *parts)

    # ------------------------------------------------ 本地跑云端 OCR 函数
    def _send_payload(self, code, headers, body):
        raw = body.encode("utf-8") if isinstance(body, str) else (body or b"")
        self.send_response(code)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if raw:
            self.wfile.write(raw)

    def _send_json(self, code, obj):
        self._send_payload(code, {"Content-Type": "application/json; charset=utf-8"},
                           json.dumps(obj, ensure_ascii=False))

    def _serve_function(self, method):
        """把请求转给 tools/ocr-fn.mjs 里的 Node 进程（复用 netlify/functions/ocr.js）。"""
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8", "replace") if length else ""
        node = shutil.which("node")
        if not node:
            return self._send_json(500, {
                "ok": False,
                "error": "没找到 node，本地用不了云端引擎（可在「识别引擎」里选“只用本地”）",
            })
        payload = json.dumps({"httpMethod": method, "body": body}, ensure_ascii=False)
        try:
            proc = subprocess.run(
                [node, FN_SCRIPT, FN_PATH],
                input=payload, capture_output=True, text=True, encoding="utf-8",
                timeout=30, cwd=ROOT,
            )
        except subprocess.TimeoutExpired:
            return self._send_json(504, {"ok": False, "error": "本地函数超时（30s）"})
        except OSError as e:
            return self._send_json(500, {"ok": False, "error": "调不起 node：%s" % e})

        out = (proc.stdout or "").strip()
        if proc.returncode != 0 or not out:
            tail = (proc.stderr or "").strip().splitlines()
            reason = tail[-1] if tail else "无输出"
            return self._send_json(500, {"ok": False, "error": "本地函数执行失败：%s" % reason})
        try:
            res = json.loads(out)
        except ValueError:
            return self._send_json(500, {"ok": False, "error": "本地函数返回的不是 JSON"})
        self._send_payload(int(res.get("statusCode") or 200),
                           res.get("headers") or {"Content-Type": "application/json"},
                           res.get("body") or "")

    def do_POST(self):
        if urlsplit(self.path).path.startswith(FN_PREFIX):
            return self._serve_function("POST")
        self.send_error(405, "POST not supported")

    def do_GET(self):
        if urlsplit(self.path).path.startswith(FN_PREFIX):
            return self._serve_function("GET")
        super().do_GET()

    def end_headers(self):
        # 本地开发不走缓存：改完 js/css 刷新就生效，不用清缓存
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 只打 4xx/5xx，正常请求不刷屏
        try:
            text = fmt % args
        except Exception:
            text = " ".join(str(a) for a in args)
        code = str(args[1]) if len(args) > 1 else ""
        if code[:1] in ("4", "5"):
            sys.stderr.write("  " + text + "\n")


def find_port(start, tries=60):
    """从 start 开始找一个能绑的端口。"""
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            # 故意不设 SO_REUSEADDR：Windows 上它允许抢占已被占用的端口，
            # 会让「探测」误判成空闲，然后两个服务抢同一个端口。
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return None


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # Windows 上 SO_REUSEADDR 语义是「允许重复占用」，必须关掉，
    # 否则旧实例还在跑的时候新实例也能绑上同一个端口。
    allow_reuse_address = os.name != "nt"


def main():
    # 输出被重定向时默认是全缓冲，日志会卡住看不到，这里强制按行刷
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8090, help="起始端口，占用会自动往后找")
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    args = ap.parse_args()

    if not os.path.isdir(SITE_DIR):
        print("[错误] 找不到 site 目录：%s" % SITE_DIR)
        return 1

    # 云端 OCR 密钥：本地从 .env 读，Netlify 上从环境变量读
    load_env()
    cloud = []
    if os.environ.get("PADDLE_TOKEN"):
        cloud.append("PaddleOCR-%s" % os.environ.get("PADDLE_MODEL", "VL").replace("PaddleOCR-", ""))
    if os.environ.get("BAIDU_API_KEY") and os.environ.get("BAIDU_SECRET_KEY"):
        cloud.append("百度高精度/标准")
    if os.environ.get("OCR_SPACE_KEY"):
        cloud.append("OCR.space")
    if os.environ.get("EASYOCR_KEY"):
        cloud.append("EasyOCR")
    if not shutil.which("node"):
        cloud = []          # 本地函数要靠 node 跑，没有就只能本地识别
        cloud_note = "没装 node，本地用不了云端引擎"
    elif cloud:
        cloud_note = " + ".join(cloud)
    else:
        cloud_note = "未配置（只有浏览器内 Tesseract），可复制 .env.example 为 .env 再填密钥"

    port = find_port(args.port)
    if port is None:
        print("[错误] %d~%d 之间没有空闲端口，请关掉一些程序再试" % (args.port, args.port + 59))
        return 1

    handler = partial(Handler, directory=SITE_DIR)
    try:
        httpd = Server(("127.0.0.1", port), handler)
    except OSError as e:
        print("[错误] 端口 %d 启动失败：%s" % (port, e))
        return 1

    url = "http://localhost:%d/" % port
    has_novel = os.path.isfile(os.path.join(NOVEL_DIR, "index.html"))

    print("")
    print("  ============================================")
    print("   英语工具 English Tool   本地服务已启动")
    print("  ============================================")
    print("")
    print("   首页（导航）  %s" % url)
    print("   词频背诵      %s%s" % (url, "vocab/"))
    print("   截图取词      %s%s" % (url, "shot/"))
    if has_novel:
        print("   单词小说      %s%s" % (url, "novel/"))
    print("")
    print("   云端 OCR      %s" % cloud_note)
    print("")
    if port != args.port:
        print("   注意：%d 被占用，已自动改用 %d（地址栏不用改，浏览器会自动打开）" % (args.port, port))
        print("")
    print("   关闭这个窗口即停止服务。")
    print("")

    if not args.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
