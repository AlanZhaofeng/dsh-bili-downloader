/**
 * 配置 / 路径 / 诊断日志。
 *
 * 数据目录：%DSH_HOME%\bili-downloader\
 *   config.json   用户配置（缺失时按默认值创建）
 *   cookies.json  登录态（只给本插件用，绝不回显）
 *   diag.log      每一步一行，cookie 只留前 6 位
 *   downloads\    默认下载目录（如果系统有「下载」目录就放那里）
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const DATA_DIR = join(DSH_HOME, 'bili-downloader')
export const CONFIG_PATH = join(DATA_DIR, 'config.json')
export const COOKIE_PATH = join(DATA_DIR, 'cookies.json')
export const DIAG_PATH = join(DATA_DIR, 'diag.log')

export const DEFAULTS = {
  outputDir: '',
  defaultQuality: 'best',
  defaultCodec: 'avc',
  concurrency: 4,
  chunkSize: 8 * 1024 * 1024,
  maxBytes: 8 * 1024 * 1024 * 1024,
  ffmpegPath: 'auto',
  keepSeparateStreams: false,
}

function systemDownloads() {
  const dir = join(homedir(), 'Downloads')
  return existsSync(dir) ? join(dir, 'bili') : join(DATA_DIR, 'downloads')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function loadConfig() {
  ensureDir(DATA_DIR)
  let saved = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    } catch (error) {
      diag(`config.json 解析失败，用默认值：${error.message}`)
    }
  }
  const config = { ...DEFAULTS, ...saved }
  if (!config.outputDir) config.outputDir = systemDownloads()
  config.concurrency = Math.min(Math.max(Number(config.concurrency) || 4, 1), 8)
  config.chunkSize = Math.max(Number(config.chunkSize) || DEFAULTS.chunkSize, 1024 * 1024)
  config.maxBytes = Number(config.maxBytes) || DEFAULTS.maxBytes
  if (!existsSync(CONFIG_PATH)) {
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8')
    } catch (error) {
      diag(`写默认 config.json 失败：${error.message}`)
    }
  }
  return config
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch }
  ensureDir(DATA_DIR)
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

// ---------- 诊断日志 ----------
const SECRET_KEYS = ['SESSDATA', 'bili_jct', 'buvid3', 'buvid4', 'sid', 'DedeUserID__ckMd5']

/** 把已知的 cookie 值从任意文本里抹掉（只留前 6 位 + 长度）。 */
export function redact(text) {
  let out = String(text)
  try {
    const jar = readCookieRaw()
    for (const key of SECRET_KEYS) {
      const value = jar[key]
      if (!value || String(value).length < 8) continue
      const short = `${String(value).slice(0, 6)}…(${String(value).length})`
      out = out.split(String(value)).join(short)
    }
  } catch {
    /* 没有 cookie 就算了 */
  }
  return out
}

export function readCookieRaw() {
  if (!existsSync(COOKIE_PATH)) return {}
  try {
    return JSON.parse(readFileSync(COOKIE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

export function writeCookieRaw(jar) {
  ensureDir(DATA_DIR)
  const tmp = COOKIE_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(jar, null, 2) + '\n', 'utf8')
  renameSync(tmp, COOKIE_PATH)
}

export function clearCookies() {
  if (existsSync(COOKIE_PATH)) {
    try {
      renameSync(COOKIE_PATH, COOKIE_PATH + '.deleted-' + Date.now())
    } catch {
      /* ignore */
    }
  }
}

export function diag(message) {
  try {
    ensureDir(DATA_DIR)
    if (existsSync(DIAG_PATH) && statSync(DIAG_PATH).size > 2 * 1024 * 1024) {
      try {
        renameSync(DIAG_PATH, DIAG_PATH + '.1')
      } catch {
        /* ignore */
      }
    }
    appendFileSync(DIAG_PATH, `[${new Date().toISOString()}] ${redact(message)}\n`, 'utf8')
  } catch {
    /* 日志写不进去不能影响下载 */
  }
}

/** 相对路径按工作目录解析，绝对路径原样返回。 */
export function resolvePath(p) {
  return resolve(p)
}

export function logTail(lines = 40) {
  try {
    const text = readFileSync(DIAG_PATH, 'utf8')
    return text.trimEnd().split('\n').slice(-lines)
  } catch {
    return []
  }
}
