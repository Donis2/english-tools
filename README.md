# 英语工具 · English Tool

把「记忆单词工具」和「截图词频标注（网页版）」合并成一个站点：主页选择进入哪个，两个页面同域，
**共用同一个浏览器的 IndexedDB（`vocab-pwa-v2`）**，所以在截图页点 ＋ 加的单词，背诵页的「实战单词」里立刻就有。

## 目录

```
english-tool/
├── site/                     ← 部署这个目录（Netlify publish = "site"）
│   ├── index.html            导航首页：三个入口 + 常用直达 + 进度数字
│   ├── vocab/                记忆单词工具（Vue3 + Dexie，PWA）
│   │   ├── index.html
│   │   ├── js/  css/  data/  assets/
│   │   └── manifest.json
│   └── shot/                 截图词频标注（单文件前端 + ocr.js + 词表）
│       ├── index.html
│       ├── ocr.js  vocab.json  eng.traineddata.gz
├── netlify/
│   └── functions/ocr.js      云端 OCR 代理（PaddleOCR / 百度 / OCR.space）
├── netlify.toml
├── start.py                  本地启动器：自动找空闲端口 + 自动开浏览器
├── 启动.bat                  双击这个（内部调用 start.py）
└── README.md
```

`单词文章记忆/html`（单词小说）不在这个目录里：本地启动时 `start.py` 会把旁边的
`../单词文章记忆/html` 挂在 `/novel/` 下，首页的「单词小说」卡片就会出现；
没有这个目录（比如线上部署）时卡片自动隐藏。

## 本地运行

双击 `启动.bat` 就行——**不用改端口，也不用自己敲网址**：

- 自动从 8090 开始找一个空闲端口（8090 被别的项目占了会自动用 8091、8092…）；
- 起好服务后自动打开浏览器到首页；
- 控制台会把首页 / 背诵 / 截图 / 小说四个地址都打出来，想手动点也可以。

| 页面 | 路径 |
|---|---|
| 导航首页 | `/` |
| 背单词 | `/vocab/`（`/vocab/#practice` 直达实战单词） |
| 截图取词 | `/shot/` |
| 单词小说 | `/novel/`（仅本地，且需要 `../单词文章记忆/html` 存在） |

不要直接双击 `site/index.html`：`file://` 下浏览器不给读词库、IndexedDB 也不稳。

本地**也能用云端 OCR**：`start.py` 启动时会读项目根目录的 `.env`，并起一个
`/.netlify/functions/ocr` 的本地代理（内部用 `tools/ocr-fn.mjs` 跑同一份 `netlify/functions/ocr.js`），
所以本地预览的判断逻辑和线上完全一致。密钥写在 `.env`：

```
PADDLE_TOKEN=...
PADDLE_MODEL=PaddleOCR-VL-1.6
BAIDU_API_KEY=...
BAIDU_SECRET_KEY=...
OCR_SPACE_KEY=...
EASYOCR_KEY=...
```

`.env` 已被 `.gitignore` 忽略，不会跟着推上 GitHub；换机器可以照 `.env.example` 重新填。
启动时控制台会打印「云端 OCR ：PaddleOCR-VL-1.6 + 百度高精度/标准 + OCR.space」或提示未配置。

## 线上地址

- 站点：<https://englishtool.netlify.app>
- 仓库：<https://github.com/Donis2/english-tools>
- 后台：<https://app.netlify.com/projects/englishtool>

## 部署到 Netlify

已在 2026-10-26 部署完成，站点 `englishtool`（ID `7974804d-e573-468f-a243-969300f0e8bd`），
环境变量六条（`PADDLE_TOKEN` / `PADDLE_MODEL` / `BAIDU_API_KEY` / `BAIDU_SECRET_KEY` /
`OCR_SPACE_KEY` / `EASYOCR_KEY`）已经配好。改完代码重新发布：

```bash
git push                                   # 先同步到 GitHub
netlify deploy --prod --dir site --functions netlify/functions
```

> 站点是 CLI 建的，没有绑定 GitHub 仓库，所以 `git push` 不会自动触发部署；要自动部署得在
> Netlify 后台 **Project configuration → Build & deploy → Link repository** 手动连一次。

从零部署的步骤：

1. 把本目录推到 GitHub 仓库，Netlify 新建站点指向它（`netlify.toml` 已写好 publish/functions）。
2. 在 **Site settings → Environment variables** 配这几条（云 OCR 用，缺了就只能走浏览器内 Tesseract）：
   - `PADDLE_TOKEN`、`PADDLE_MODEL`（可选，默认 `PaddleOCR-VL-1.6`）
   - `BAIDU_API_KEY`、`BAIDU_SECRET_KEY`
   - `OCR_SPACE_KEY`
   - `EASYOCR_KEY`（可选，只手动选时用）

   值与本机 `.env` 相同。**不要把 `.env` 或 `API.txt` 提交到仓库**——它们已在 `.gitignore` 里，
   Netlify 这边走后台环境变量，前端和仓库里都看不到密钥。
3. 部署完访问 `/`，两边都能进。

> 只部署一个站点就够。两个站点分别部署会让数据落进各自的域名，反而又要靠 Gist 同步来对。

## 识别引擎怎么切

截图页「识别引擎」有七个选项，选择会记在浏览器里，下次打开还是上次那个：

| 选项 | 行为 |
|---|---|
| 自动（推荐） | PaddleOCR-VL → 百度高精度 → 百度标准 → OCR.space，全失败才用本地 |
| PaddleOCR-VL · 最准 | 优先 PaddleOCR-VL，失败按上面顺序继续 |
| 百度 · 高精度版 | 优先百度 `accurate_basic`，失败按 百度标准 → OCR.space → PaddleOCR 继续 |
| OCR.space | 优先 OCR.space（免费版单图 1MB），超限会先在浏览器里压缩；失败换百度 |
| 百度 · 标准版 | 优先百度 `general_basic`，免费、长图省额度 |
| EasyOCR · 按点计费 | 只能手动选，**不在自动链里**（按像素扣点，不该被自动烧掉）；失败先退 PaddleOCR |
| 只用本地 · 不上传 | 全程浏览器内 Tesseract，图片不出本机 |

同一张 116 词英文截图实测（预热后）：

| 引擎 | 耗时 | 准确率 |
|---|---|---|
| PaddleOCR-VL | 0.15–0.4 s | 100%（逐词比对） |
| 百度高精度 | 0.4–0.6 s | 100% |
| 百度标准 | 0.36 s | 100% |
| EasyOCR | 1.1–6.3 s（首次 15 s） | 正常图 100% |
| OCR.space | 2.7–7.7 s | 100% |

**为什么 PaddleOCR-VL 排第一**：除了快，它在**单行超长的小字截图**上明显更稳。同一批测试里
`PP-OCRv6` 会把行首字母吃掉（`difficult` → `lifficult`、`remarkable` → `emarkable`），
置信度还显示 0.996、不会报错——这种错误会让单词在词频表里匹配不上，比识别失败更难发现。
VL 没有这个问题。想改用 `PP-OCRv6`（逐行 + 每行坐标，以后做「点哪行标哪行」有用）只要把
`PADDLE_MODEL` 改成 `PP-OCRv6` 即可，代码不用动。

引擎旁边的圆点表示云端状况：**绿**=云端可用（会写几个引擎可用）、**黄**=云端在但缺密钥/刚调用失败、**红**=云端函数没部署（本地预览就是这样）。没配密钥的引擎会直接标「未配置」。

每次识别结果里都有「引擎 xxx」；自动换过引擎时，结果块里会多一行说明**哪个引擎挂了、什么原因、最后用了谁**，页脚还留着「上次：… · 耗时 …」。服务端（`netlify/functions/ocr.js`）每次返回 `attempts` 数组，失败原因分 `config / size / quota / auth / image / timeout / network / empty`，前端据此翻译成人话。

后端要点：
- 单次请求 8.2s 预算，避免一个卡住的引擎拖死整批；
- PaddleOCR 是「提交任务 → 轮询 → 下载结果」三段式，给它独立 6s 预算，并给后面的百度留 1.2s，
  一个慢任务也不会把整批时间吃光（超时就自动换百度，结果块会写「PaddleOCR-VL（超时）→ 本次用 百度高精度版」）；
- 没配密钥、图片超出该引擎体积上限（OCR.space 1MB，百度约 3MB 原始字节，PaddleOCR 20MB）会直接跳过，不浪费一次请求；
- 百度 token 过期自动刷新重试一次，不再把一次鉴权抖动记成「引擎坏了」；
- 送 PaddleOCR 前会先缩到长边 1800px：它内部本来就把长边缩到 960，传原图只是白等（实测 2600px 要 6s+，缩完 2.5s）；
- 云端整体不可用时前端有 60s 冷却，一批多张图不会每张都白等。

## 「实战单词」怎么工作

- 截图页每次点 ＋ 调一次 `../vocab/js/db.js` 里的 `DB.addPracticeWord()`，直接写 IndexedDB。
- 同一个词重复添加只累计 `addCount`，列表里只显示一条（`×6`），详情里显示「累计加入 6 次 / 首次 / 最近 / 来源」。
- 在实战单词里点 6 档熟练度是**复制语义**：词留在实战单词，同时写进对应的熟练度分类（和「临时」一致，不是剪贴）。
- 移除单个词 / 清空全部都在实战单词页顶部；这些操作不会影响已记入的熟练度。

## 数据在哪

| 数据 | 位置 |
|---|---|
| 词库（5463 词） | `site/vocab/data/netem_full_list.json`，首次打开导入 IndexedDB |
| 学习进度 (cards / reviews) | 浏览器 IndexedDB + 可选 GitHub Gist 同步 |
| 实战单词 | 浏览器 IndexedDB 的 `practiceWords` 表 |
| 截图词表 | `site/shot/vocab.json`（5463 条，紧凑字段） |

词库和 `vocab.json` 是同源的，改词表要两边一起重新生成。

## 已知限制

- 本地 Tesseract 的脚本/worker/wasm 核心按 `jsdelivr → unpkg → npmmirror` 自动换源（这台机器连不上 jsdelivr，
  但 npmmirror 能通，所以本地引擎实测可用）。想彻底离线：把 `tesseract.min.js`、`worker.min.js`、
  `tesseract-core-*.wasm.js` 放进 `site/shot/vendor/tesseract/`，加载器最后一项就是它。
- 两个页面同域，所以清理浏览器的「站点数据」会同时清掉背诵进度和实战单词，重要进度记得导出 JSON 备份。
- PaddleOCR 是异步任务（提交 → 轮询 → 下载），只能走服务端代理——浏览器直连会被 CORS 挡掉。
  本地预览由 `start.py` 代理，线上由 Netlify Function 代理，两处跑的是同一份 `netlify/functions/ocr.js`。
- Netlify 同步函数上限 10s，所以 PaddleOCR 只给 6s；服务端冷启动偶尔要 4~7s，那一刻会自动退回百度，
  下一次就快了（实测热身后 0.15s）。这不是出错，页脚会写「途中换过 1 次引擎」。
- AI Studio 的 PaddleOCR token 目前没测到调用次数上限（连测 30+ 次无异常），但官方若调整配额，
  表现会是 `auth`/`quota` 失败并自动退回百度，不影响出结果。
- EasyOCR 按图片长边像素扣点：≤600px 收 10 点、601–1980px 收 20 点、1981–2980px 收 63 点，
  额度用完返回 402 并自动退回 PaddleOCR。它有个明确的弱点：**长边不到 400px 的小图会把双写字母吞掉一个**
  （`pollution` → `polution`，置信度仍显示 0.975，三次全错）。正常截图尺寸不会触发；
  另外这个接口偶发直接断连（同网络下 curl 也见过），代码里做了单次重试。
- `site/` 是从原来两个项目复制出来的运行文件；原目录（`记忆单词工具/`、`截图词频标注/`）保留作源/存档，
  以后改动以本目录为准，避免两边改出分叉。
