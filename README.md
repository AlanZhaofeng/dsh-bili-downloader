# dsh-bili-downloader

把 B 站视频/音频下载到本机。两个工具 + 一个左侧栏面板：

| 入口 | 干什么 |
| --- | --- |
| `bili_download`（工具） | 下载视频 / 纯音频（`audio` → `.m4a`，`audio-mp3` → `.mp3`），支持分P、清晰度、编码偏好 |
| `bili_login`（工具） | 扫码登录（`start` / `poll` / `status` / `logout`），二维码走本地页面，手机扫屏幕 |
| **左侧栏「B 站下载器」**（UI） | 账号状态 / 扫码登录 / 新建下载 / 任务进度 / 配置 / 最近日志 |

实现来自 `bili_dl/B站下载器-完整方案.md`（命令行的 `bili_api.py` / `bili_login.py` 已在本机跑通 4K）。

## 左侧栏面板

客户端半边（`lib/client.js`）在 `sidebar.panellist` 注册图标、在 `main` 注册同名面板：

- 点左侧栏的 B 站图标 → 中间列切换到「B 站下载器」页面（再点一次或选会话回到对话）
- 面板里直接粘链接就能下载，进度条实时走；任务在**宿主后台**跑，切走页面不会中断
- 二维码每 1.5 秒轮询一次状态，过期/成功自动换图；「换一张」会重新生成
- 颜色用 DSH 主题变量（`--dsw-alias-*`），浅色/深色都跟着宿主走

> 刚装完插件后，浏览器里需要**刷新一次页面**（F5）：客户端模块图是宿主启动时组装的，
> 插件会自检并把自己补进模块图（`/dsh-bili-downloader/graph` 可以看到 `hasClient: true`），
> 但已经打开的页面要重新拉一次启动清单才能看到新图标。

## 能力（本机实测）

| 场景 | 结果 |
| --- | --- |
| 未登录 | 480P 封顶（请求更高会明确报 `QUALITY_UNAVAILABLE`，不会假装成功） |
| 登录（普通） | 1080P / 1080P+ |
| 登录（大会员） | 4K / HDR / 杜比视界（`quality=4k`，`codec=avc` 会优先选 4K AVC，双击就能播） |
| 纯音频 | 不需要 ffmpeg，`.m4s` → `.m4a` 直接能播 |
| 720P 单文件 | 没装 ffmpeg 时自动走 html5 单文件（自带音轨，封顶 720P） |

## 安装

在 DSH 里用插件管理安装本目录（bundle），或手动：

```jsonc
// profiles/<profile>/package.json
"dependencies": { "dsh-bili-downloader": "link:C:/path/to/dsh-bili-downloader" },
"dsh": { "profile": { "bundles": [ ..., "dsh-bili-downloader" ] } }
```

宿主半边改完要重启 DSH（或在插件管理里关掉再打开这个条目）；客户端半边装好后刷新页面。


## 配置

`%DSH_HOME%\bili-downloader\config.json`（首次运行按默认值生成）：

```jsonc
{
  "outputDir": "C:\\Users\\<你>\\Downloads\\bili",
  "defaultQuality": "best",
  "defaultCodec": "avc",
  "concurrency": 4,            // 分片并发，1~8
  "chunkSize": 8388608,        // 8MB 一片
  "maxBytes": 8589934592,      // 单文件上限 8GB，超了直接拒绝
  "ffmpegPath": "auto",        // auto：PATH + WinGet 目录里找
  "keepSeparateStreams": false // true 时保留 video.m4s / audio.m4s
}
```

同目录还有：

- `cookies.json` —— 登录态（扫码后写入；**只给本插件用**，日志与工具返回值从不回显完整值）
- `login-qr.png` —— 没有 webServer 时的二维码兜底图片
- `diag.log` —— 每步一行（解析 / 选流 / 下载百分比 / 合流 / 校验），超过 2MB 自动轮转

## 页面

- `/dsh-bili-downloader/qr` —— 扫码页（手机扫屏幕，自动轮询状态、过期自动换码）
- `/dsh-bili-downloader/qr.png` —— 二维码 PNG
- `/dsh-bili-downloader/status` —— 登录状态 JSON
- `/dsh-bili-downloader/account` —— 账号信息（60 秒缓存）
- `/dsh-bili-downloader/log` —— 最近诊断日志
- `/dsh-bili-downloader/tasks` —— 后台下载任务
- `/dsh-bili-downloader/download` —— POST 发起下载（面板用）
- `/dsh-bili-downloader/graph` —— 客户端模块图诊断（`hasClient`）
- `/dsh-bili-downloader` —— 状态页（登录态 / 输出目录 / 配置路径 / 最近日志）

## 错误码

`NOT_FOUND` · `LOGIN_REQUIRED` · `GEO_BLOCKED` · `VIP_REQUIRED` · `QUALITY_UNAVAILABLE` ·
`NO_FFMPEG` · `NO_SPACE` · `MAX_BYTES` · `NETWORK` · `STREAM_EXPIRED` · `ABORTED` · `BAD_INPUT`

原则：**宁可明确失败，也不要「下了一半的 480P 却报成功」。**

## 自测

```bash
node test/client.test.mjs  # 客户端半边：侧栏/面板注册、图标与页面骨架（假 React 渲染）
node test/qr.test.mjs      # 二维码编码与 Python 参考实现逐位对比（7 段文本 × 8 掩码）
node test/api.mjs          # view / 签名 playurl / 选流（不落盘）
node test/smoke.mjs        # 720P、纯音频、错误路径（经过真实工具注册）
node test/smoke.mjs --full # 再加 1080P 合流
node test/smoke.mjs --4k   # 再加 4K（约 333MB）
node test/resume.mjs       # 断点续传：下 1.5 秒掐断，再续传校验大小
```

本机实测结果（2026-11-03，这台机器）：

| 测试 | 结果 |
| --- | --- |
| `qr.test.mjs` | 7 段文本 × 8 种掩码，与参考实现**逐位一致** |
| `smoke.mjs` | 720P 5.2MB / m4a 0.8MB / 不存在 BV → `NOT_FOUND` / 非法参数 → `INVALID_ARGS` |
| `smoke.mjs --full` | 1080P 40.4MB，`ffprobe: 1920x1080 h264/aac 121.4s` |
| `smoke.mjs --4k` | 4K 333.4MB，`ffprobe: 3840x2160 h264/aac 218.6s`（16.3s 下完） |
| `resume.mjs` | 中断时 4/5 片，续传 0.8s 完成，尺寸一致 |
| `bili_login status` | 已登录：账号（大会员），等级 Lv5 |
| 二维码路由 | `/dsh-bili-downloader/qr` 200，PNG 456×456 |
| `client.test.mjs` | 侧栏 `sidebar.panellist` id/order/label、主面板 `main` key、图标与页面骨架全部通过 |
| 宿主路由 | `/status` `/account` `/log` `/tasks` `/download` 全 200；后台任务音频下载完成 0.8MB |
| 模块图 | `/dsh-bili-downloader/graph` → `hasClient: true`，bundle 200 / 24.6KB |

`test/qr-oracle.py` / `test/qr-layout.py` 是给二维码测试生成参考数据的（用 `bili_dl/pylib` 里
现成的 Python `qrcode` 包），平时不需要跑。

## 故障排查

**面板一直停在「二维码准备中」/「正在连接宿主…」**

先看宿主路由通不通：

```powershell
Invoke-WebRequest http://127.0.0.1:<端口>/dsh-bili-downloader/status
```

- 返回 JSON → 宿主正常，刷新页面即可；仍不动就看浏览器控制台。
- 返回 404 → 宿主路由没注册。0.2.0 及以前的老毛病：插件在 DSH 启动过程中可能比 `webServer`
  先激活，`ctx.get('webServer')` 拿到 undefined，整块路由就被跳过了。0.2.1 起改成
  `ctx.inject(['webServer'], …)` 等它就绪（已在 `test/smoke.mjs` 里用假 ctx 覆盖这条路径）。
  升级后如果还 404，在插件管理里把这个插件关掉再打开一次即可。

**工具报 `NETWORK：网络请求失败：fetch failed`**

本机到 B 站的连接偶尔会瞬断（实测过一次）。0.2.1 起 `request()` 会自动重试一次；
仍然失败再重试工具调用。DNS 同时返回 IPv6/IPv4，网络栈坏掉时也会表现成这样。

## 已知边界

- 只做普通视频（`/video/BV…`）；番剧、课程、直播地址不支持。
- 不绕会员/地区限制：拿不到就明确报错。
- 流地址约 2 小时过期且绑 IP；下载中断后重新调用会接着 `.part` 续传，前提是分片大小没变。
- 二维码有效期约 3 分钟，过期后页面会自动换一张。
- 侧栏面板的文字目前是中文硬编码（没有接 Client locale 字典）。
