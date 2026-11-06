/**
 * B 站接口层：cookie、wbi 签名、view / playurl / nav / 扫码登录。
 * 全部照 bili_dl/bili_api.py（已在本机跑通 4K）翻译，接口行为一项不减。
 *
 * 网络：用 Node 自带的 fetch（undici）—— 它不读 Windows 注册表代理，
 * 所以本机那个「ProxyEnable=1 但没有监听」的死代理坑对这里天然无效。
 */
import { createHash } from 'node:crypto'
import { readCookieRaw, writeCookieRaw } from './config.mjs'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
export const REFERER = 'https://www.bilibili.com/'

export const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view'
export const PLAYURL_URL = 'https://api.bilibili.com/x/player/wbi/playurl'
export const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'
export const QR_GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
export const QR_POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
export const FINGER_SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi'

export const QN_BY_QUALITY = {
  '8k': 127,
  'dolby-vision': 126,
  hdr: 125,
  '4k': 120,
  '1080p60': 116,
  '1080p+': 112,
  '1080p': 80,
  '720p60': 74,
  '720p': 64,
  '480p': 32,
  '360p': 16,
}

export const QUALITY_BY_QN = Object.fromEntries(
  Object.entries(QN_BY_QUALITY).map(([name, qn]) => [qn, name]),
)

const QUALITY_LABEL = {
  '8k': '8K',
  'dolby-vision': '杜比视界',
  hdr: 'HDR',
  '4k': '4K',
  '1080p60': '1080P 60fps',
  '1080p+': '1080P+',
  '1080p': '1080P',
  '720p60': '720P 60fps',
  '720p': '720P',
  '480p': '480P',
  '360p': '360P',
}

export const qualityLabel = (quality) => QUALITY_LABEL[quality] || quality
export const labelForQn = (qn) => QUALITY_LABEL[QUALITY_BY_QN[qn]] || `${qn}P`

/** 带错误码的失败：工具返回值里的 `code` 就是它（见方案 §6）。 */
export class BiliError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'BiliError'
    this.code = code
    Object.assign(this, extra)
  }
}

export function cookieHeader() {
  const jar = readCookieRaw()
  const fields = Object.entries(jar).filter(
    ([k, v]) => v && !['savedAt', 'loginAt', 'updatedAt'].includes(k),
  )
  return fields.map(([k, v]) => `${k}=${v}`).join('; ')
}

export function hasCookie() {
  return Boolean(readCookieRaw().SESSDATA)
}

/**
 * 匿名设备指纹 buvid3/buvid4：没有登录态也要有它。
 * 实测没有这两个值时，未登录请求高清档会被压到 480P；补上之后 1080P 能签出来。
 * 它们不是账号凭据，只是设备标识，落盘无妨。
 */
export async function ensureBuvid({ signal } = {}) {
  const jar = readCookieRaw()
  if (jar.buvid3 && jar.buvid4) return jar
  try {
    const json = await getJson(FINGER_SPI_URL, { signal })
    const data = json?.data || {}
    if (data.b_3 && !jar.buvid3) jar.buvid3 = data.b_3
    if (data.b_4 && !jar.buvid4) jar.buvid4 = data.b_4
    if (jar.buvid3) writeCookieRaw(jar)
  } catch {
    /* 拿不到就按没有走，最多降档 */
  }
  return jar
}

export function baseHeaders(extra = {}) {
  const headers = {
    'User-Agent': UA,
    Referer: REFERER,
    Accept: 'application/json, text/plain, */*',
    ...extra,
  }
  const cookie = cookieHeader()
  if (cookie) headers.Cookie = cookie
  return headers
}

// ---------- wbi 签名 ----------
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21,
  56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

let wbiCache = { key: null, at: 0 }

export function resetWbiCache() {
  wbiCache = { key: null, at: 0 }
}

function buildQuery(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
}

async function wbiKey({ signal } = {}) {
  if (wbiCache.key && Date.now() - wbiCache.at < 3600_000) return wbiCache.key
  const json = await getJson(NAV_URL, { signal })
  const img = json?.data?.wbi_img || {}
  const tail = (url) => String(url || '').split('/').pop().split('.')[0]
  const lookup = tail(img.img_url) + tail(img.sub_url)
  if (lookup.length < 64) throw new BiliError('WBI_UNAVAILABLE', '拿不到 wbi 签名密钥（nav 接口异常）')
  const key = MIXIN_TAB.map((i) => lookup[i]).join('').slice(0, 32)
  wbiCache = { key, at: Date.now() }
  return key
}

export function signedParams(params, key, now = Math.floor(Date.now() / 1000)) {
  const withTs = { ...params, wts: now }
  const filtered = Object.keys(withTs)
    .sort()
    .map((k) => [k, String(withTs[k]).replace(/[!'()*]/g, '')])
  const query = buildQuery(Object.fromEntries(filtered))
  const w_rid = createHash('md5').update(query + key).digest('hex')
  return { query, params: { ...Object.fromEntries(filtered), w_rid } }
}

// ---------- HTTP ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function request(url, { params, headers = {}, signal, timeoutMs = 20_000, redirect } = {}) {
  const target = params ? `${url}?${buildQuery(params)}` : url
  let lastError = null
  // 连不上就再试一次：本机网络偶尔会卡一下（实测 B 站偶发 fetch failed），
  // 重试一次就能过去，不必让用户重新点一遍。
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      return await fetch(target, {
        headers: baseHeaders(headers),
        signal: combined,
        redirect: redirect || 'follow',
      })
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        if (attempt === 0) continue
        throw new BiliError('NETWORK', '请求超时了（B 站或本机网络慢），请重试', { cause: error })
      }
      if (attempt === 0) {
        await sleep(700)
        continue
      }
      const cause = error?.cause?.code || error?.cause?.message || ''
      throw new BiliError(
        'NETWORK',
        `网络请求失败：${error?.message || error}${cause ? '（' + cause + '）' : ''}`,
        { cause: error },
      )
    }
  }
  throw new BiliError('NETWORK', `网络请求失败：${lastError?.message || lastError}`, { cause: lastError })
}

export async function getJson(url, { params, signed = false, signal, timeoutMs } = {}) {
  let query = params
  if (signed) {
    const key = await wbiKey({ signal })
    const signedResult = signedParams(params || {}, key)
    query = signedResult.params
  }
  const res = await request(url, { params: query, signal, timeoutMs })
  const text = await res.text()
  if (!res.ok && !text) {
    throw new BiliError('NETWORK', `接口返回 HTTP ${res.status}`)
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new BiliError('BAD_RESPONSE', `接口返回的不是 JSON（HTTP ${res.status}）`)
  }
  return json
}

/** 把 B 站业务错误码翻成方案 §6 的 code。 */
export function throwApiError(json, fallback = 'API_ERROR') {
  const code = json?.code
  const message = json?.message || ''
  const map = {
    '-404': ['NOT_FOUND', '视频不存在或已下架'],
    '-403': ['LOGIN_REQUIRED', 'B 站拒绝了这次请求（可能需要登录或触发了风控）'],
    '-352': ['LOGIN_REQUIRED', '触发了风控（-352），稍后再试或扫码登录'],
    '-10403': ['GEO_BLOCKED', '该视频在当前地区不可用'],
    '-101': ['LOGIN_REQUIRED', '登录已失效，请重新扫码'],
  }
  const [mappedCode, mappedMessage] = map[String(code)] || [fallback, message || `接口返回 code=${code}`]
  throw new BiliError(mappedCode, mappedMessage, { apiCode: code })
}

// ---------- 视频信息 ----------
export function extractBvid(text) {
  return /BV[0-9A-Za-z]{10}/.exec(String(text || ''))?.[0]
}

/** 从 BV 号 / av 号 / 链接（含 b23.tv 短链）里认出视频与分P。 */
export async function resolveInput(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new BiliError('BAD_INPUT', '给个 BV 号或 bilibili 链接')

  let bvid = extractBvid(raw)
  let aid = /^av(\d+)$/i.exec(raw)?.[1]
  let page

  if (/^https?:\/\//i.test(raw)) {
    let finalUrl = raw
    try {
      const res = await request(raw, { redirect: 'manual', headers: { Accept: 'text/html' } })
      const location = res.headers.get('location')
      if (location) finalUrl = new URL(location, raw).href
      try {
        await res.body?.cancel()
      } catch {
        /* ignore */
      }
    } catch (error) {
      if (error instanceof BiliError && error.code === 'NETWORK') throw error
    }
    bvid = bvid || extractBvid(finalUrl)
    aid = aid || /\/(?:av|aid)(\d+)/i.exec(finalUrl)?.[1]
    try {
      page = Number(new URL(finalUrl).searchParams.get('p')) || undefined
    } catch {
      /* ignore */
    }
  }

  if (!bvid && !aid) {
    throw new BiliError('BAD_INPUT', '认不出这个链接或 BV 号。支持 BV 号、av 号、bilibili.com 视频链接、b23.tv 短链')
  }
  if (/\/bangumi\/|\/cheese\//.test(raw)) {
    throw new BiliError('NOT_SUPPORTED', '番剧/课程地址暂时不支持，只做普通视频（video/BV…）')
  }
  return { bvid, aid, page }
}

function normalizePages(data) {
  const pages = Array.isArray(data?.pages) ? data.pages : []
  return pages.map((p) => ({
    page: Number(p.page),
    cid: Number(p.cid),
    part: String(p.part || ''),
    duration: Number(p.duration) || 0,
  }))
}

export async function view({ bvid, aid, signal }) {
  const params = bvid ? { bvid } : { aid }
  const json = await getJson(VIEW_URL, { params, signal })
  if (json.code !== 0) throwApiError(json)
  const data = json.data || {}
  const pages = normalizePages(data)
  return {
    bvid: data.bvid,
    aid: data.aid,
    title: String(data.title || ''),
    duration: Number(data.duration) || 0,
    owner: String(data?.owner?.name || ''),
    pages,
    cid: Number(data.cid) || pages[0]?.cid,
    pic: String(data.pic || ''),
  }
}

/** 取指定分P 的 cid（默认第 1P）。 */
export function pageCid(info, page) {
  const wanted = Number(page) || 1
  const hit = info.pages.find((p) => p.page === wanted)
  if (hit) return hit
  if (wanted === 1 && info.cid) return { page: 1, cid: info.cid, part: '', duration: info.duration }
  throw new BiliError('BAD_INPUT', `这个视频没有第 ${wanted} P（共 ${info.pages.length || 1} P）`)
}

// ---------- playurl ----------
export async function playurl({ bvid, cid, qn = 120, fnval = 4048, signed = true, signal }) {
  const params = { bvid, cid, qn, fnval, fourk: 1, platform: 'pc' }
  const json = await getJson(PLAYURL_URL, { params, signed, signal })
  if (json.code !== 0) throwApiError(json)
  const data = json.data || {}
  if (!data.dash && !(data.durl && data.durl.length)) {
    throw new BiliError('VIP_REQUIRED', '这个视频拿不到可下载的流（付费内容需要大会员帐号）')
  }
  return data
}

/** 免 ffmpeg 的单文件（自带音轨，封顶 720P）。 */
export async function playurlSingleFile({ bvid, cid, qn = 64, signal }) {
  const json = await getJson(PLAYURL_URL, {
    params: { bvid, cid, qn, fnval: 0, platform: 'html5', high_quality: 1 },
    signal,
  })
  if (json.code !== 0) throwApiError(json)
  const durl = json?.data?.durl
  if (!Array.isArray(durl) || !durl.length) throw new BiliError('NO_STREAM', '这个视频没有单文件流')
  return { durl, quality: Number(json.data.quality) || qn }
}

// ---------- 选流 ----------
export function codecClass(codecs) {
  const value = String(codecs || '')
  if (value.startsWith('avc')) return 'avc'
  if (value.startsWith('hev') || value.startsWith('hvc')) return 'hevc'
  if (value.startsWith('av01')) return 'av1'
  return 'other'
}

const CODEC_LABEL = { avc: 'AVC/H.264', hevc: 'HEVC/H.265', av1: 'AV1', other: '其它编码' }
export const codecLabel = (name) => CODEC_LABEL[name] || name

export function availableQualities(dash) {
  const ids = [...new Set((dash?.video || []).map((s) => Number(s.id)).filter(Boolean))]
  return ids.sort((a, b) => b - a).map((qn) => ({ qn, quality: QUALITY_BY_QN[qn] || String(qn), label: labelForQn(qn) }))
}

/**
 * 选视频流：目标是 `(qn, 编码)` 复合键，不是「按 id 取第一个」。
 * 返回 { stream, qn, quality, codec, fallbackCodec } 或抛出带 code 的错误。
 */
export function pickVideoStream(dash, { quality = 'best', codec = 'avc' } = {}) {
  const streams = (dash?.video || []).filter((s) => s && s.baseUrl)
  if (!streams.length) throw new BiliError('NO_STREAM', '这个视频没有 DASH 视频流')
  const available = availableQualities(dash)
  const maxQn = available[0]?.qn
  const wanted = codecClass(codec) === 'other' ? 'avc' : codec

  let targetQn
  if (quality === 'best') {
    // best 的语义是「最高档里优先要的编码」：4K 常常同时有 126(杜比视界/HEVC) 和 120(AVC/HEVC/AV1)，
    // 只按 qn 取最大会拿到 HEVC，Windows 上双击可能黑屏（方案 §2.7）。
    const withWanted = streams.filter((s) => codecClass(s.codecs) === wanted)
    targetQn = withWanted.length ? Math.max(...withWanted.map((s) => Number(s.id))) : maxQn
  } else {
    targetQn = QN_BY_QUALITY[quality]
    if (!targetQn) throw new BiliError('BAD_INPUT', `不认识的清晰度「${quality}」`)
  }

  if (!available.some((q) => q.qn === targetQn)) {
    throw new BiliError(
      'QUALITY_UNAVAILABLE',
      `这个视频没有 ${qualityLabel(quality)}，最高只有 ${labelForQn(maxQn)}`,
      { available: available.map((q) => q.quality), maxQuality: QUALITY_BY_QN[maxQn] || String(maxQn) },
    )
  }

  const candidates = streams.filter((s) => Number(s.id) === targetQn)
  const byClass = new Map()
  for (const stream of candidates) {
    const cls = codecClass(stream.codecs)
    const prev = byClass.get(cls)
    if (!prev || Number(stream.bandwidth) > Number(prev.bandwidth)) byClass.set(cls, stream)
  }
  const order = ['avc', 'hevc', 'av1', 'other']
  const preferred = byClass.get(wanted) || order.map((c) => byClass.get(c)).find(Boolean)
  if (!preferred) throw new BiliError('NO_STREAM', '这个清晰度下没有可用的视频流')

  return {
    stream: preferred,
    qn: targetQn,
    quality: QUALITY_BY_QN[targetQn] || String(targetQn),
    codec: codecClass(preferred.codecs),
    fallbackCodec: codecClass(preferred.codecs) !== wanted ? wanted : undefined,
    available: available.map((q) => q.quality),
  }
}

/** 音频：固定优先 30280（约 192k），再 30232，再按码率取最大。 */
export function pickAudioStream(dash) {
  const audios = (dash?.audio || []).filter((s) => s && s.baseUrl)
  if (!audios.length) throw new BiliError('NO_STREAM', '这个视频没有音频流')
  const byId = (id) => audios.find((a) => Number(a.id) === id)
  const chosen =
    byId(30280) ||
    byId(30232) ||
    [...audios].sort((a, b) => Number(b.bandwidth) - Number(a.bandwidth))[0]
  return { stream: chosen, codec: 'aac', id: Number(chosen.id) }
}

// ---------- 登录状态 ----------
export async function nav({ signal } = {}) {
  const json = await getJson(NAV_URL, { signal })
  const data = json?.data || {}
  return {
    code: json.code,
    isLogin: Boolean(data.isLogin),
    uname: String(data.uname || ''),
    vip: Boolean(data?.vipStatus || data?.vip_type),
    vipLabel: data?.vip_label?.text || '',
    level: Number(data?.level_info?.current_level) || 0,
  }
}
