/**
 * ffmpeg：探测、合流（-c copy 不转码）、音频转 mp3、ffprobe 校验。
 *
 * 找不到 ffmpeg 时**绝不偷偷降档**：上层拿到 NO_FFMPEG 后给用户两个选择
 * （装 ffmpeg / 改 720P 单文件）。
 */
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { BiliError } from './bili.mjs'

let cache = { key: null, ffmpeg: null, ffprobe: null }

function run(file, args, { timeoutMs = 600_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout, stderr) => {
        if (error) {
          const err = new BiliError(
            'FFMPEG_FAILED',
            `ffmpeg 执行失败：${String(stderr || error.message).trim().slice(0, 400)}`,
          )
          err.cause = error
          reject(err)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

function searchWinGet() {
  const base = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Packages')
  if (!existsSync(base)) return []
  const hits = []
  try {
    for (const pkg of readdirSync(base)) {
      if (!/ffmpeg/i.test(pkg)) continue
      const walk = (dir, depth) => {
        if (depth > 4) return
        let entries = []
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full, depth + 1)
          else if (/^ffmpeg\.exe$/i.test(entry.name)) hits.push(full)
        }
      }
      walk(join(base, pkg), 0)
    }
  } catch {
    /* ignore */
  }
  return hits
}

function alive(candidate) {
  try {
    const probe = spawnSync(candidate, ['-version'], { timeout: 8000, windowsHide: true })
    return probe.status === 0
  } catch {
    return false
  }
}

/** 找 ffmpeg / ffprobe；返回 { ffmpeg, ffprobe }（可能是 null）。 */
export function locateFfmpeg(configured = 'auto') {
  const key = String(configured || 'auto')
  if (cache.key === key) return { ffmpeg: cache.ffmpeg, ffprobe: cache.ffprobe }

  const candidates = []
  if (key !== 'auto') candidates.push(key)
  candidates.push('ffmpeg')
  for (const hit of searchWinGet()) candidates.push(hit)

  let ffmpeg = null
  for (const candidate of candidates) {
    if (candidate !== 'ffmpeg' && !existsSync(candidate)) continue
    if (alive(candidate)) {
      ffmpeg = candidate
      break
    }
  }

  let ffprobe = null
  if (ffmpeg) {
    const dir = ffmpeg === 'ffmpeg' ? '' : dirname(ffmpeg)
    const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
    const siblings = [dir ? join(dir, name) : 'ffprobe', dir ? join(dir, 'ffprobe') : 'ffprobe']
    for (const sibling of siblings) {
      if (sibling !== 'ffprobe' && !existsSync(sibling)) continue
      if (alive(sibling)) {
        ffprobe = sibling
        break
      }
    }
  }

  cache = { key, ffmpeg, ffprobe }
  return { ffmpeg, ffprobe }
}

export function haveFfmpeg(configured = 'auto') {
  return Boolean(locateFfmpeg(configured).ffmpeg)
}

/** 合流：视频 + 音频 → 一个 mp4（-c copy，秒级）。 */
export async function mergeStreams({ videoPath, audioPath, outPath, ffmpeg, signal }) {
  if (!ffmpeg) throw new BiliError('NO_FFMPEG', '需要 ffmpeg 才能合流，但没找到它')
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outPath,
  ]
  await run(ffmpeg, args, { signal })
  try {
    if (statSync(outPath).size === 0) throw new Error('empty')
  } catch {
    throw new BiliError('FFMPEG_FAILED', '合流出来是空文件（0 字节）')
  }
  return outPath
}

/** 音轨转 mp3（只有这一步需要转码）。 */
export async function toMp3({ inputPath, outPath, ffmpeg, signal }) {
  if (!ffmpeg) throw new BiliError('NO_FFMPEG', '需要 ffmpeg 才能转 mp3')
  await run(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-c:a', 'libmp3lame', '-b:a', '128k', outPath],
    { signal },
  )
  return outPath
}

/** ffprobe 校验：宽高 / 编码 / 时长。没有 ffprobe 就返回 null（不假装校验过）。 */
export async function probe({ path, ffprobe }) {
  if (!ffprobe) return null
  try {
    const { stdout } = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], {
      timeoutMs: 60_000,
    })
    const json = JSON.parse(stdout)
    const video = (json.streams || []).find((s) => s.codec_type === 'video')
    const audio = (json.streams || []).find((s) => s.codec_type === 'audio')
    return {
      width: Number(video?.width) || 0,
      height: Number(video?.height) || 0,
      videoCodec: String(video?.codec_name || ''),
      audioCodec: String(audio?.codec_name || ''),
      durationSec: Number(json?.format?.duration) || 0,
      bytes: Number(json?.format?.size) || 0,
    }
  } catch {
    return null
  }
}

export function ffmpegHint() {
  return '装 ffmpeg（winget install Gyan.FFmpeg）后再试；或者把 quality 改成 720p 用单文件（不需要 ffmpeg）'
}
