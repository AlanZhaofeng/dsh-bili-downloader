/**
 * dsh-bili-downloader —— B 站视频/音频下载器（宿主半边）。
 *
 * 工具：
 *   bili_download  下载视频 / 音频（720P 单文件走 html5 接口，不碰 ffmpeg；
 *                  1080P+ 走 wbi 签名的 DASH + ffmpeg 合流）
 *   bili_login     扫码登录（start / poll / status / logout），二维码走本地路由
 * 路由：
 *   /dsh-bili-downloader/qr        扫码页面（手机扫屏幕）
 *   /dsh-bili-downloader/qr.png    二维码 PNG
 *   /dsh-bili-downloader/status    JSON 状态
 *   /dsh-bili-downloader           状态页（输出目录 / 配置 / 最近日志）
 *
 * 设计约束（方案 §4、§5）：
 *   - 不 import @deepseek-ai/*：桌面版 profile 里它们是 optional peer，裸 import 会让整条插件不激活。
 *   - ctx.tools.register / webServer.register 返回的是 **disposer 函数**，不是 { off() }。
 *   - output.schema 里每个 object 都写 additionalProperties。
 *   - cookie 只落 %DSH_HOME%\bili-downloader\，日志与返回值永不回显完整值。
 */
import { renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BiliError, QN_BY_QUALITY, codecLabel, ensureBuvid, nav, pageCid, pickAudioStream, pickVideoStream, playurl, playurlSingleFile, qualityLabel, resolveInput, view } from './bili.mjs'
import { CONFIG_PATH, COOKIE_PATH, DATA_DIR, ensureDir, loadConfig, diag, logTail, resolvePath } from './config.mjs'
import { cleanupPartials, downloadSegments, downloadStream, freeBytes } from './download.mjs'
import { defineTool } from './define-tool.mjs'
import { createLoginManager } from './login.mjs'
import { ffmpegHint, locateFfmpeg, mergeStreams, probe, toMp3 } from './merge.mjs'
import { buildFileName, tempDirName } from './naming.mjs'

export const name = 'bili-downloader'
export const inject = ['tools']

const PACKAGE_NAME = 'dsh-bili-downloader'
const MB = 1024 * 1024

function mediaHeaders() {
  // 每个请求都要 Referer —— 少它视频流 403（方案坑 #7）
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Referer: 'https://www.bilibili.com/',
    Accept: '*/*',
  }
  return headers
}

function normalizeQuality(value, fallback = 'best') {
  const raw = String(value || fallback).trim().toLowerCase()
  const alias = {
    '': fallback,
    best: 'best',
    '8k': '8k',
    '4k': '4k',
    '2160p': '4k',
    '1080p+': '1080p+',
    '1080+': '1080p+',
    '1080p': '1080p',
    1080: '1080p',
    '1080p60': '1080p60',
    '720p': '720p',
    720: '720p',
    '720p60': '720p60',
    '480p': '480p',
    480: '480p',
    '360p': '360p',
    360: '360p',
  }
  const mapped = alias[raw] || raw
  if (mapped !== 'best' && !QN_BY_QUALITY[mapped]) {
    throw new BiliError('BAD_INPUT', `不认识的清晰度「${value}」；可用：best / 4k / 1080p+ / 1080p / 720p / 480p`)
  }
  return mapped
}

function normalizeCodec(value, fallback = 'avc') {
  const raw = String(value || fallback).trim().toLowerCase()
  const alias = { h264: 'avc', avc1: 'avc', h265: 'hevc', hev1: 'hevc', hvc1: 'hevc', av01: 'av1' }
  const mapped = alias[raw] || raw || fallback
  if (!['avc', 'hevc', 'av1'].includes(mapped)) {
    throw new BiliError('BAD_INPUT', `不认识的编码「${value}」；可用：avc / hevc / av1`)
  }
  return mapped
}

function estimateBytes(stream, durationSec) {
  const seconds = Number(durationSec) || 0
  if (!seconds || !stream) return 0
  return (Number(stream.bandwidth || 0) / 8) * seconds
}

function errorResult(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORTED') {
    return { ok: false, code: 'ABORTED', message: '下载被取消了（已下好的分片留着，下次可以续传）' }
  }
  const code = error?.code || 'INTERNAL'
  const message = error?.message || String(error)
  diag(`失败 ${code}：${message}`)
  return { ok: false, code, message }
}

function okMessage({ quality, codec, bytes, merged, singleFile }) {
  const parts = []
  if (quality) parts.push(qualityLabel(quality))
  if (codec) parts.push(codecLabel(codec))
  if (bytes) parts.push(`${(bytes / MB).toFixed(0)}MB`)
  const how = singleFile ? '单文件' : merged ? '已合流' : ''
  return `${parts.join(' ')}${how ? ' · ' + how : ''}`
}

export function apply(ctx) {
  const login = createLoginManager({ log: diag })

  /** 工具/页面共用的进度回调（页面用它画进度条，工具用它写日志）。 */
  const report = (exec, progress) => {
    try {
      exec?.onProgress?.(progress)
    } catch {
      /* 页面的回调不能影响下载 */
    }
  }
  const phase = (exec, name, extra) => {
    try {
      exec?.onPhase?.(name, extra)
    } catch {
      /* ignore */
    }
  }

  // ---------- 下载核心 ----------
  async function runDownload(args, exec) {
    const signal = exec?.signal
    const settings = loadConfig()
    const mode = args.mode || 'video'
    const quality = normalizeQuality(args.quality || settings.defaultQuality, settings.defaultQuality)
    const codec = normalizeCodec(args.codec || settings.defaultCodec, settings.defaultCodec)
    const outputDir = resolvePath(args.outputDir || settings.outputDir)

    try {
      ensureDir(outputDir)
      await ensureBuvid({ signal })

      const input = await resolveInput(args.url)
      const pageArg = Number(args.page) || input.page || 1
      diag(`开始：${args.url} → ${input.bvid || 'av' + input.aid} P${pageArg} mode=${mode} quality=${quality} codec=${codec}`)

      const info = await view({ ...input, signal })
      const page = pageCid(info, pageArg)
      const cid = page.cid
      const title = page.part ? `${info.title} - ${page.part}` : info.title
      const durationSec = page.duration || info.duration
      diag(`解析：${info.bvid}《${title}》${durationSec}s，可用 ${info.pages.length || 1} P`)
      phase(exec, 'downloading', { title, durationSec })

      // ---------- 纯音频 ----------
      if (mode === 'audio' || mode === 'audio-mp3') {
        const data = await playurl({ bvid: info.bvid, cid, qn: 120, fnval: 4048, signal })
        const audio = pickAudioStream(data.dash)
        const tmpDir = ensureDir(join(ensureDir(join(outputDir, '.bili-tmp')), tempDirName(info.bvid, cid)))
        const rawPath = join(tmpDir, 'audio.m4s')
        diag(`音频流：id=${audio.id} ${(Number(audio.stream.bandwidth) / 1000).toFixed(0)}kbps`)
        await downloadStream({
          url: audio.stream.baseUrl,
          backupUrls: audio.stream.backupUrl,
          dest: rawPath,
          headers: mediaHeaders(),
          chunkSize: settings.chunkSize,
          concurrency: settings.concurrency,
          signal,
          label: 'audio',
          onProgress: (p) => {
            report(exec, p)
            if (p.percent > 0 && Math.round(p.percent) % 25 === 0) diag(`音频 ${p.percent.toFixed(0)}% ${(p.speed / MB).toFixed(1)}MB/s`)
          },
        })
        const ext = mode === 'audio-mp3' ? '.mp3' : '.m4a'
        const finalPath = join(outputDir, buildFileName({ title, bvid: info.bvid, page: page.page, ext, dir: outputDir }))
        if (mode === 'audio-mp3') {
          const ff = locateFfmpeg(settings.ffmpegPath)
          if (!ff.ffmpeg) throw new BiliError('NO_FFMPEG', `转 mp3 需要 ffmpeg。${ffmpegHint()}`)
          await toMp3({ inputPath: rawPath, outPath: finalPath, ffmpeg: ff.ffmpeg, signal })
        } else {
          renameSync(rawPath, finalPath)
        }
        if (!settings.keepSeparateStreams) {
          try {
            rmSync(tmpDir, { recursive: true, force: true })
          } catch {
            /* ignore */
          }
        }
        const bytes = statSync(finalPath).size
        diag(`完成：${finalPath} ${(bytes / MB).toFixed(1)}MB`)
        return {
          ok: true,
          path: finalPath,
          title,
          durationSec,
          quality: 'audio',
          codec: 'aac',
          bytes,
          message: `${mode === 'audio-mp3' ? 'mp3' : 'm4a'} · ${(bytes / MB).toFixed(1)}MB`,
        }
      }

      // ---------- 视频：没有 ffmpeg 时 720P 及以下走单文件 ----------
      const targetQn = quality === 'best' ? 120 : QN_BY_QUALITY[quality]
      const ff = locateFfmpeg(settings.ffmpegPath)
      if (targetQn <= 64 && !ff.ffmpeg) {
        const single = await playurlSingleFile({ bvid: info.bvid, cid, qn: targetQn, signal })
        const actualQn = Number(single.quality)
        if (actualQn && actualQn < targetQn) {
          throw new BiliError('QUALITY_UNAVAILABLE', `这个视频没有 ${qualityLabel(quality)}，接口只给到 ${qualityLabel(Object.keys(QN_BY_QUALITY).find((k) => QN_BY_QUALITY[k] === actualQn) || String(actualQn))}`)
        }
        const finalPath = join(outputDir, buildFileName({ title, bvid: info.bvid, page: page.page, ext: '.mp4', dir: outputDir }))
        await downloadSegments({
          segments: single.durl,
          dest: finalPath,
          headers: mediaHeaders(),
          signal,
          onProgress: (p) => {
            report(exec, p)
            if (p.total && p.percent > 0 && Math.round(p.percent) % 25 === 0) diag(`单文件 ${p.percent.toFixed(0)}%`)
          },
        })
        const bytes = statSync(finalPath).size
        const qualityName = Object.keys(QN_BY_QUALITY).find((k) => QN_BY_QUALITY[k] === actualQn) || quality
        diag(`完成（单文件）：${finalPath} ${(bytes / MB).toFixed(1)}MB`)
        return {
          ok: true,
          path: finalPath,
          title,
          durationSec,
          quality: qualityName,
          codec: 'avc',
          bytes,
          message: okMessage({ quality: qualityName, codec: 'avc', bytes, singleFile: true }),
        }
      }

      // ---------- 视频：DASH + ffmpeg ----------
      if (!ff.ffmpeg) {
        throw new BiliError(
          'NO_FFMPEG',
          `下载 ${qualityLabel(quality)} 需要 ffmpeg 合流，但没找到它。${ffmpegHint()}`,
        )
      }

      let data = await playurl({ bvid: info.bvid, cid, qn: targetQn, fnval: 4048, signal })
      let video = pickVideoStream(data.dash, { quality, codec })
      const audio = pickAudioStream(data.dash)
      diag(
        `选流：视频 id=${video.qn} ${video.stream.width}x${video.stream.height} ${video.stream.codecs} ` +
          `${(Number(video.stream.bandwidth) / 1000).toFixed(0)}kbps；音频 id=${audio.id}`,
      )

      const estimate = estimateBytes(video.stream, durationSec) + estimateBytes(audio.stream, durationSec)
      const free = freeBytes(outputDir)
      if (free !== null && estimate && free < estimate * 1.15 + 64 * MB) {
        throw new BiliError(
          'NO_SPACE',
          `磁盘不够：预计需要 ${(estimate / 1024 ** 3).toFixed(1)}GB，${outputDir} 所在盘只剩 ${(free / 1024 ** 3).toFixed(1)}GB。换个 outputDir 或清一下盘`,
        )
      }
      if (estimate && estimate > settings.maxBytes) {
        throw new BiliError(
          'MAX_BYTES',
          `预计 ${(estimate / 1024 ** 3).toFixed(1)}GB，超过上限 ${(settings.maxBytes / 1024 ** 3).toFixed(1)}GB。确实要下就改 ${CONFIG_PATH} 里的 maxBytes`,
        )
      }

      const tmpDir = ensureDir(join(ensureDir(join(outputDir, '.bili-tmp')), tempDirName(info.bvid, cid)))
      const videoPath = join(tmpDir, 'video.m4s')
      const audioPath = join(tmpDir, 'audio.m4s')

      const fetchStream = async (kind, pickStream) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const chosen = pickStream()
            await downloadStream({
              url: chosen.stream.baseUrl,
              backupUrls: chosen.stream.backupUrl,
              dest: kind === 'video' ? videoPath : audioPath,
              headers: mediaHeaders(),
              chunkSize: settings.chunkSize,
              concurrency: settings.concurrency,
              signal,
              label: kind,
              onProgress: (p) => {
                report(exec, p)
                if (p.total && Math.round(p.percent) % 25 === 0) {
                  diag(`${kind} ${p.percent.toFixed(0)}% ${(p.bytes / MB).toFixed(0)}/${(p.total / MB).toFixed(0)}MB ${(p.speed / MB).toFixed(1)}MB/s`)
                }
              },
            })
            return chosen
          } catch (error) {
            // 流地址过期：重新 playurl 再续传一次（已下好的分片不重下）
            if (error?.code === 'STREAM_EXPIRED' && attempt === 0 && !signal?.aborted) {
              diag(`${kind} 流地址过期，重新取流后续传`)
              data = await playurl({ bvid: info.bvid, cid, qn: targetQn, fnval: 4048, signal })
              if (kind === 'video') video = pickVideoStream(data.dash, { quality, codec })
              continue
            }
            throw error
          }
        }
        throw new BiliError('NETWORK', `${kind} 下载失败`)
      }

      const chosenVideo = await fetchStream('video', () => video)
      const chosenAudio = await fetchStream('audio', () => pickAudioStream(data.dash))

      const finalPath = join(outputDir, buildFileName({ title, bvid: info.bvid, page: page.page, ext: '.mp4', dir: outputDir }))
      phase(exec, 'merging')
      await mergeStreams({ videoPath, audioPath, outPath: finalPath, ffmpeg: ff.ffmpeg, signal })
      const meta = await probe({ path: finalPath, ffprobe: ff.ffprobe })
      const bytes = statSync(finalPath).size
      diag(
        `完成：${finalPath} ${(bytes / MB).toFixed(1)}MB` +
          (meta ? `（ffprobe: ${meta.width}x${meta.height} ${meta.videoCodec}/${meta.audioCodec} ${meta.durationSec.toFixed(1)}s）` : '（没有 ffprobe，未校验）'),
      )

      if (!settings.keepSeparateStreams) {
        cleanupPartials(videoPath)
        cleanupPartials(audioPath)
        try {
          rmSync(tmpDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }

      return {
        ok: true,
        path: finalPath,
        title,
        durationSec: meta?.durationSec || durationSec,
        quality: video.quality,
        codec: chosenVideo.codec,
        width: meta?.width || Number(chosenVideo.stream.width) || 0,
        height: meta?.height || Number(chosenVideo.stream.height) || 0,
        bytes,
        message:
          okMessage({ quality: video.quality, codec: chosenVideo.codec, bytes, merged: true }) +
          (meta && meta.width ? ` · ${meta.width}×${meta.height}` : '') +
          (chosenVideo.fallbackCodec ? `（没有 ${codecLabel(codec)} 流，用了 ${codecLabel(chosenVideo.codec)}）` : ''),
      }
    } catch (error) {
      return errorResult(error)
    }
  }

  // ---------- 二维码地址 ----------
  function origin() {
    try {
      return ctx.get('webServer')?.getOrigin?.() || ''
    } catch {
      return ''
    }
  }

  function qrPageUrl() {
    const base = origin()
    return base ? `${base}/dsh-bili-downloader/qr` : ''
  }

  /** 没有 webServer 时把二维码写成 PNG 落盘，至少还能让用户打开看。 */
  function qrFallbackPath() {
    try {
      const png = login.png()
      if (!png) return ''
      ensureDir(DATA_DIR)
      const file = join(DATA_DIR, 'login-qr.png')
      writeFileSync(file, png)
      return file
    } catch {
      return ''
    }
  }

  async function startLogin() {
    await login.start()
    const page = qrPageUrl()
    return { page, file: page ? '' : qrFallbackPath() }
  }

  // ---------- 页面用的下载任务 ----------
  // 工具调用是同步等结果；侧栏页面不能一直挂着，所以任务在后台跑，页面轮询 /tasks。
  const tasks = new Map()
  let taskSeq = 0
  let accountCache = { at: 0, value: null }

  function createTask(args) {
    const task = {
      id: `bili-${Date.now().toString(36)}-${++taskSeq}`,
      url: String(args.url || ''),
      mode: args.mode || 'video',
      quality: args.quality || 'best',
      codec: args.codec || 'avc',
      state: 'queued',
      stage: '',
      title: '',
      percent: 0,
      bytes: 0,
      total: 0,
      speed: 0,
      path: '',
      error: '',
      startedAt: Date.now(),
      finishedAt: 0,
    }
    tasks.set(task.id, task)
    // 只留最近 30 条
    const ordered = [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt)
    for (const old of ordered.slice(30)) tasks.delete(old.id)

    const exec = {
      signal: new AbortController().signal,
      onProgress: (p) => {
        task.stage = p.label || task.stage
        task.percent = Number(p.percent) || 0
        task.bytes = Number(p.bytes) || 0
        task.total = Number(p.total) || 0
        task.speed = Number(p.speed) || 0
      },
      onPhase: (name, extra) => {
        task.state = name
        if (extra?.title) task.title = String(extra.title)
      },
    }
    runDownload({ ...args, outputDir: args.outputDir }, exec)
      .then((result) => {
        task.finishedAt = Date.now()
        if (result?.ok) {
          task.state = 'done'
          task.percent = 100
          task.path = result.path || ''
          task.title = result.title || task.title
          task.bytes = result.bytes || task.bytes
          task.total = task.bytes
        } else {
          task.state = 'failed'
          task.error = `${result?.code || 'ERROR'}：${result?.message || '失败'}`
        }
      })
      .catch((error) => {
        task.finishedAt = Date.now()
        task.state = 'failed'
        task.error = String(error?.message || error)
      })
    return task
  }

  async function accountInfo() {
    if (accountCache.value && Date.now() - accountCache.at < 60_000) return accountCache.value
    try {
      const info = await nav()
      accountCache = {
        at: Date.now(),
        value: { ok: true, loggedIn: info.isLogin, uname: info.uname, vip: info.vip, level: info.level },
      }
    } catch (error) {
      accountCache = { at: Date.now(), value: { ok: false, loggedIn: false, message: error?.message || String(error) } }
    }
    return accountCache.value
  }

  // ---------- 工具 ----------
  const downloadTool = defineTool({
    name: 'bili_download',
    description:
      '下载 B 站（bilibili）视频或音频到本地磁盘。用户给 bilibili.com 链接、b23.tv 短链、BV 号或 av 号时用这个工具。' +
      '只要音频就用 mode="audio"（m4a）或 mode="audio-mp3"。' +
      '清晰度：quality 默认 best（会优先挑你要的编码里最高的档，best+avc 通常就是 4K AVC，双击就能播）；' +
      '1080P 及以上需要 ffmpeg 合流，4K/HDR 还需要先用 bili_login 扫码登录并有大会员；' +
      '没装 ffmpeg 时 720p 及以下会自动走单文件（自带音轨，不需要合流）。' +
      '下载完成后必须把返回的 path 原样告诉用户（不要改写、不要编造）；失败时把 code 和 message 一起说明。' +
      '大文件会下载较久，工具会等待；不要因为慢就重复调用。',
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: '视频链接（bilibili.com / b23.tv）或 BV 号 / av 号',
      },
      mode: {
        type: 'string',
        enum: ['video', 'audio', 'audio-mp3'],
        description: '默认 video（带画面）；audio 只要音轨（.m4a，不转码）；audio-mp3 转成 mp3',
      },
      quality: {
        type: 'string',
        enum: ['best', '8k', '4k', '1080p+', '1080p', '720p', '480p', '360p'],
        description: '默认 best。要 4K/1080P+ 需要登录（bili_login）且视频本身有这一档',
      },
      codec: {
        type: 'string',
        enum: ['avc', 'hevc', 'av1'],
        description: '默认 avc（兼容性最好，Windows 自带解码）；hevc/av1 体积小但要装解码扩展',
      },
      page: {
        type: 'number',
        description: '分P 序号，从 1 开始；不给就按链接里的 ?p= 或第 1P',
      },
      outputDir: {
        type: 'string',
        description: '可选，输出目录；默认用配置里的 outputDir',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string' },
          path: { type: 'string' },
          title: { type: 'string' },
          durationSec: { type: 'number' },
          quality: { type: 'string' },
          codec: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          bytes: { type: 'number' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        if (!value || value.ok === false) {
          return [{ type: 'text', text: `✗ ${value?.code ? value.code + ' · ' : ''}${(value && value.message) || '失败'}` }]
        }
        const name = String(value.path || '').split(/[\\/]/).pop()
        return [{ type: 'text', text: `✓ ${value.message || '完成'} · ${name}` }]
      },
    },
    timeoutMs: 30 * 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return runDownload(args, exec)
    },
  })

  const loginTool = defineTool({
    name: 'bili_login',
    description:
      'B 站扫码登录管理。action="start"：生成二维码并返回一个本地页面地址，让用户在浏览器里打开（用手机 B 站扫屏幕）；' +
      'action="poll"：等用户扫完，最多等 timeoutSec 秒；action="status"：查当前登录状态与昵称；action="logout"：退出登录并删除本地 cookie。' +
      '下载 1080P+ / 4K / HDR 需要先登录；登录态过期（接口回 -101）时也要重新 start。' +
      '会话 cookie 只存在本机配置目录里，不要向用户复述 cookie 内容。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['start', 'poll', 'status', 'logout'],
        description: 'start 生成二维码 / poll 等扫码结果 / status 查状态 / logout 退出',
      },
      timeoutSec: {
        type: 'number',
        description: 'poll 时最多等多少秒，默认 25；一般 20~60',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string' },
          state: { type: 'string' },
          message: { type: 'string' },
          qrUrl: { type: 'string' },
          qrFile: { type: 'string' },
          expiresInSec: { type: 'number' },
          loggedIn: { type: 'boolean' },
          uname: { type: 'string' },
        },
      },
      render(_args, value) {
        if (!value || value.ok === false) return [{ type: 'text', text: `✗ ${(value && value.message) || '失败'}` }]
        if (value.qrUrl) return [{ type: 'text', text: `⌛ ${value.message || '等扫码'}` }]
        return [{ type: 'text', text: `✓ ${value.message || value.state || '好'}` }]
      },
    },
    timeoutMs: 5 * 60_000,
    async execute(args) {
      try {
        if (args.action === 'start') {
          const { page, file } = await startLogin()
          const state = login.snapshot()
          return {
            ok: true,
            state: state.state,
            message: page
              ? `用手机 B 站扫这个页面里的二维码（约 3 分钟有效）：${page}`
              : `二维码已保存成图片：${file}`,
            ...(page ? { qrUrl: page } : {}),
            ...(file ? { qrFile: file } : {}),
            expiresInSec: state.expiresInSec,
          }
        }
        if (args.action === 'poll') {
          const seconds = Math.min(Math.max(Number(args.timeoutSec) || 25, 3), 120)
          const state = login.snapshot()
          if (state.state === 'idle') {
            const { page, file } = await startLogin()
            return {
              ok: true,
              state: 'waiting',
              message: `还没有二维码，已经生成了一张：${page || file}`,
              ...(page ? { qrUrl: page } : {}),
              ...(file ? { qrFile: file } : {}),
            }
          }
          const result = await login.waitFor(seconds * 1000)
          const page = qrPageUrl()
          if (result.state === 'success') {
            return { ok: true, state: 'success', loggedIn: true, uname: result.uname, message: result.message || '登录成功' }
          }
          if (result.state === 'expired' || result.state === 'error') {
            return {
              ok: false,
              code: result.state === 'expired' ? 'QR_EXPIRED' : 'LOGIN_ERROR',
              state: result.state,
              message: `${result.message}${page ? '（' + page + '）' : ''}`,
              ...(page ? { qrUrl: page } : {}),
            }
          }
          return {
            ok: true,
            state: result.state,
            message: `${result.message}${page ? '，二维码页面：' + page : ''}`,
            ...(page ? { qrUrl: page } : {}),
            expiresInSec: result.expiresInSec,
          }
        }
        if (args.action === 'status') {
          const info = await nav()
          if (!info.isLogin) {
            return { ok: true, state: 'anonymous', loggedIn: false, message: '当前未登录（只能下 1080P 及以下）' }
          }
          return {
            ok: true,
            state: 'logged-in',
            loggedIn: true,
            uname: info.uname,
            message: `已登录：${info.uname}${info.vip ? '（大会员）' : ''}，等级 Lv${info.level}`,
          }
        }
        // logout
        const result = login.logout()
        return { ok: true, state: 'anonymous', loggedIn: false, message: result.message }
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  // ---------- 注册 ----------
  ctx.effect(() => ctx.tools.register(downloadTool))
  ctx.effect(() => ctx.tools.register(loginTool))

  // ---------- 二维码 / 状态页 ----------
  // ⚠ 不要在 apply 里直接 ctx.get('webServer')：DSH 启动时插件可能比 webServer 先激活，
  // 那时拿到 undefined，所有路由就永远注册不上 —— 页面表现就是一直「二维码准备中」、/status 404。
  // 用 ctx.inject 等它就绪；已经在的话立即注册（跟 dsh-client-modules 同一个写法）。
  const installWebRoutes = (webCtx, webServerService) => {
    // 注意：不能直接写 webCtx.webServer —— 没有 inject 'webServer' 的上下文这样取会抛
    // "cannot get property webServer without inject"。已经在的话由外面把服务对象传进来。
    const webServer = webServerService || webCtx.webServer
    const route = (path, handler) =>
      webCtx.effect(() =>
        webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            try {
              await handler(req, res)
            } catch (error) {
              diag(`路由 ${path} 出错：${error?.message || error}`)
              try {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }))
              } catch {
                /* ignore */
              }
            }
          },
        }),
      )

    route('/dsh-bili-downloader/qr.png', async (req, res) => {
      let png = login.png()
      const state = login.snapshot()
      if (!png || state.state === 'expired' || state.state === 'error') {
        try {
          await login.start()
          png = login.png()
        } catch (error) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`二维码生成失败：${error?.message || error}`)
          return
        }
      }
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-length': png.length,
      })
      res.end(png)
    })

    route('/dsh-bili-downloader/qr', async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(qrPageHtml())
    })

    route('/dsh-bili-downloader/status', async (req, res) => {
      const state = login.snapshot()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, ...state, outputDir: loadConfig().outputDir }))
    })

    const sendJson = (res, payload, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    const readBody = async (req) => {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 1_000_000) throw new Error('请求体太大')
      }
      try {
        return body ? JSON.parse(body) : {}
      } catch {
        throw new Error('请求体不是合法 JSON')
      }
    }

    // 最近日志（页面用）
    route('/dsh-bili-downloader/log', async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const lines = Math.min(Math.max(Number(url.searchParams.get('lines')) || 60, 1), 300)
      sendJson(res, { ok: true, lines: logTail(lines) })
    })

    // 账号信息（带 60 秒缓存，避免每次轮询都打 B 站）
    route('/dsh-bili-downloader/account', async (req, res) => {
      sendJson(res, await accountInfo())
    })

    // 换一张二维码
    route('/dsh-bili-downloader/qr/refresh', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只支持 POST' }, 405)
      login.stop()
      try {
        await login.start()
      } catch (error) {
        return sendJson(res, { ok: false, error: String(error?.message || error) }, 502)
      }
      sendJson(res, { ok: true, ...login.snapshot() })
    })

    // 退出登录
    route('/dsh-bili-downloader/logout', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只支持 POST' }, 405)
      login.logout()
      accountCache = { at: 0, value: null }
      sendJson(res, { ok: true, state: 'anonymous', hasCookie: false })
    })

    // 页面发起下载（后台任务）
    route('/dsh-bili-downloader/download', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { ok: false, error: '只支持 POST' }, 405)
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        return sendJson(res, { ok: false, error: String(error?.message || error) }, 400)
      }
      const url = String(body.url || '').trim()
      if (!url) return sendJson(res, { ok: false, error: '先填一个链接或 BV 号' }, 400)
      const mode = ['video', 'audio', 'audio-mp3'].includes(body.mode) ? body.mode : 'video'
      const quality = typeof body.quality === 'string' ? body.quality : undefined
      const codec = typeof body.codec === 'string' ? body.codec : undefined
      const task = createTask({ url, mode, quality, codec, page: body.page })
      sendJson(res, { ok: true, task })
    })

    // 任务列表
    route('/dsh-bili-downloader/tasks', async (req, res) => {
      const list = [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt)
      sendJson(res, { ok: true, tasks: list })
    })

    // 客户端模块图诊断（侧栏图标没出现时先看这里）
    route('/dsh-bili-downloader/graph', async (req, res) => {
      let entries = []
      try {
        entries = (ctx.get('clientModules')?.graph()?.entries || []).map((entry) => ({
          id: entry.id,
          url: entry.url,
          rev: entry.rev,
        }))
      } catch {
        /* ignore */
      }
      sendJson(res, {
        ok: true,
        packageName: PACKAGE_NAME,
        hasClient: entries.some((entry) => entry.id === PACKAGE_NAME),
        entries,
      })
    })


    route('/dsh-bili-downloader', async (req, res) => {
      const settings = loadConfig()
      const state = login.snapshot()
      const lines = logTail(30).map((line) => `<li>${escapeHtml(line)}</li>`).join('')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>B 站下载器</title>
<style>${BASE_CSS}</style></head>
<body><main class="card">
  <h1>B 站下载器</h1>
  <p class="sub">dsh-bili-downloader · 宿主插件</p>
  <dl>
    <dt>登录</dt><dd>${state.state === 'success' || state.hasCookie ? '已登录' : '未登录'}${state.uname ? '：' + escapeHtml(state.uname) : ''}</dd>
    <dt>输出目录</dt><dd><code>${escapeHtml(settings.outputDir)}</code></dd>
    <dt>配置</dt><dd><code>${escapeHtml(CONFIG_PATH)}</code></dd>
    <dt>cookie</dt><dd><code>${escapeHtml(COOKIE_PATH)}</code></dd>
  </dl>
  <p><a class="primary" href="/dsh-bili-downloader/qr">扫码登录</a></p>
  <h2>最近日志</h2>
  <ul class="log">${lines || '<li>（空）</li>'}</ul>
</main></body></html>`)
    })
  }

  const existingWebServer = ctx.get('webServer')
  if (existingWebServer !== undefined) installWebRoutes(ctx, existingWebServer)
  else ctx.inject(['webServer'], (webCtx) => installWebRoutes(webCtx, webCtx.webServer))

  // 卸载时清掉登录轮询
  ctx.effect(() => () => login.stop())

  // ---------- 客户端半边自检 ----------
  // 宿主启动时会把「这个包是不是客户端包」的结论缓存住；如果插件是在 DSH 跑起来之后才装上的，
  // 这个缓存里记的还是「不是」，于是 dsh.client 永远不会进模块图（侧栏图标不出现）。
  // 这里只在「我们声明了客户端半边、但模块图里没有我们」时清掉那一条缓存再扫一次。
  // 内部字段变了也没关系：try/catch 吞掉，最坏情况跟以前一样需要重启一次 DSH。
  ensureClientHalf()

  function ensureClientHalf() {
    try {
      const cm = ctx.get('clientModules')
      if (!cm || typeof cm.graph !== 'function') return
      const entries = cm.graph()?.entries || []
      if (entries.some((entry) => entry && entry.id === PACKAGE_NAME)) return
      if (!(cm.pkgMeta instanceof Map) || !(cm.dirty instanceof Set) || typeof cm.flush !== 'function') return
      let cleared = false
      for (const key of [...cm.pkgMeta.keys()]) {
        const value = cm.pkgMeta.get(key)
        const ours = value && value.packageName === PACKAGE_NAME
        const oursNegative = value === null && String(key).endsWith('\0' + PACKAGE_NAME)
        if (ours || oursNegative) {
          cm.pkgMeta.delete(key)
          cleared = true
        }
      }
      if (!cleared) return
      cm.dirty.add(PACKAGE_NAME)
      cm.flush((error) => diag(`客户端半边重新扫描失败：${error?.message || error}`))
      const now = (cm.graph()?.entries || []).some((entry) => entry && entry.id === PACKAGE_NAME)
      diag(`客户端半边：清理元数据缓存后重新扫描 → ${now ? '已进入模块图（刷新页面即可看到侧栏入口）' : '仍未进入模块图'}`)
    } catch (error) {
      diag(`客户端半边自检失败（不影响宿主功能）：${error?.message || error}`)
    }
  }
}

// ---------- 页面 ----------
const BASE_CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1b1f24;--muted:#6b7280;--line:#e5e7eb;--accent:#00a1d6;--ok:#16a34a;--err:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--fg:#e6e8eb;--muted:#9aa3ad;--line:#262b35;--accent:#28b8e8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;display:flex;justify-content:center;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px;max-width:560px;width:100%;box-shadow:0 10px 30px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px;color:var(--muted);font-weight:600}
.sub{color:var(--muted);margin:0 0 18px;font-size:13px}
.qr{display:flex;justify-content:center;margin:18px 0}
.qr img{width:280px;height:280px;background:#fff;border-radius:12px;padding:10px;border:1px solid var(--line)}
.state{display:flex;gap:8px;align-items:center;justify-content:center;font-weight:600;margin:8px 0 4px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--muted)}
.dot.ok{background:var(--ok)}.dot.err{background:var(--err)}.dot.wait{background:var(--accent)}
.hint{color:var(--muted);font-size:13px;text-align:center;margin:0}
.row{display:flex;gap:10px;justify-content:center;margin-top:18px;flex-wrap:wrap}
a.primary,button{appearance:none;border:0;border-radius:10px;background:var(--accent);color:#fff;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
dl{display:grid;grid-template-columns:88px 1fr;gap:8px 12px;margin:16px 0 0;font-size:14px}
dt{color:var(--muted)}dd{margin:0;word-break:break-all}
code{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
ul.log{list-style:none;padding:0;margin:0;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--muted);max-height:240px;overflow:auto}
ul.log li{padding:2px 0;border-bottom:1px dashed var(--line);white-space:pre-wrap;word-break:break-all}
`

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function qrPageHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>B 站扫码登录</title>
<style>${BASE_CSS}</style></head>
<body><main class="card">
  <h1>扫码登录 B 站</h1>
  <p class="sub">手机 B 站 →「我的」→ 扫一扫。登录后可以下 1080P+ / 4K / HDR。</p>
  <div class="qr"><img id="qr" alt="登录二维码" src="/dsh-bili-downloader/qr.png?t=0"></div>
  <div class="state"><span class="dot wait" id="dot"></span><span id="state">等待扫码…</span></div>
  <p class="hint" id="hint">二维码约 3 分钟有效，过期会自动换一张</p>
  <div class="row">
    <button class="ghost" id="refresh">换一张</button>
    <a class="primary" href="/dsh-bili-downloader" target="_blank" rel="noreferrer">状态页</a>
  </div>
</main>
<script>
(function(){
  var dot=document.getElementById('dot'),stateEl=document.getElementById('state'),hint=document.getElementById('hint'),img=document.getElementById('qr');
  var last={};
  function setState(text,kind){stateEl.textContent=text;dot.className='dot '+(kind||'');}
  async function tick(){
    try{
      var r=await fetch('/dsh-bili-downloader/status',{cache:'no-store'});
      var s=await r.json();
      if(s.state==='success'){setState('登录成功'+(s.uname?'：'+s.uname:''),'ok');hint.textContent='可以关掉这个页面了';}
      else if(s.state==='scanned'){setState('已扫码，等手机上确认','wait');hint.textContent='在手机上点「确认登录」';}
      else if(s.state==='expired'){setState('二维码过期了','err');hint.textContent='点「换一张」重新生成';}
      else if(s.state==='error'){setState('出错了','err');hint.textContent=s.message||'重试一下';}
      else if(s.state==='waiting'){setState('等待扫码…','wait');hint.textContent='有效期还剩 '+Math.max(0,s.expiresInSec|0)+' 秒';}
      else {setState('还没有二维码','wait');}
      if(s.state!==last.state || s.expiresInSec!==last.expiresInSec){ last=s; if(s.state==='success'||s.state==='expired') img.src='/dsh-bili-downloader/qr.png?t='+Date.now(); }
    }catch(e){setState('连不上宿主','err');}
    setTimeout(tick,1200);
  }
  document.getElementById('refresh').addEventListener('click',function(){img.src='/dsh-bili-downloader/qr.png?t='+Date.now();hint.textContent='已换一张，重新扫';});
  img.addEventListener('load',function(){});
  tick();
})();
</script></body></html>`
}
