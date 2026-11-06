/**
 * 扫码登录：generate → 后台每 2 秒 poll → 成功后把 cookie 落到
 * %DSH_HOME%\bili-downloader\cookies.json。
 *
 * 真实状态在外层 json.data.code 里（外层 code 永远是 0）：
 *   86101 未扫码 · 86090 已扫码待确认 · 86038/86039 过期 · 0 成功
 * 二维码 180 秒过期 —— 过期就换一张，别让用户对着死码扫。
 */
import {
  FINGER_SPI_URL,
  BiliError,
  QR_GENERATE_URL,
  QR_POLL_URL,
  nav,
  resetWbiCache,
  throwApiError,
} from './bili.mjs'
import { clearCookies, diag, readCookieRaw, writeCookieRaw } from './config.mjs'
import { qrPng } from './qr.mjs'

const WANT = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4']
const QR_TTL_MS = 170_000
const POLL_INTERVAL_MS = 2000

function parseCookies(setCookies) {
  const out = {}
  for (const raw of setCookies || []) {
    const first = String(raw).split(';', 1)[0]
    const index = first.indexOf('=')
    if (index <= 0) continue
    const key = first.slice(0, index).trim()
    const value = first.slice(index + 1).trim()
    if (WANT.includes(key) && value) out[key] = value
  }
  return out
}

export function createLoginManager({ log = diag } = {}) {
  /** @type {null | {url:string,key:string,at:number,png:Buffer,status:string,message:string,expiresAt:number,uname:string}} */
  let session = null
  let timer = null
  let polling = false
  let consecutiveErrors = 0

  function clearTimer() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function snapshot() {
    if (!session) return { state: 'idle', message: '还没有开始扫码', hasCookie: Boolean(readCookieRaw().SESSDATA) }
    const expired = (session.status === 'waiting' || session.status === 'scanned') && Date.now() > session.expiresAt
    if (expired) {
      session.status = 'expired'
      session.message = '二维码过期了，点「换一张」重新生成'
    }
    return {
      state: session.status,
      message: session.message,
      uname: session.uname,
      qrUrl: session.url,
      expiresInSec: Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)),
      hasCookie: Boolean(readCookieRaw().SESSDATA),
    }
  }

  async function applyLoginCookies(res) {
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    return parseCookies(setCookies)
  }

  async function finish(json, res) {
    let cookies = await applyLoginCookies(res)
    const url = String(json?.data?.url || '')
    if (url) {
      try {
        const query = new URL(url).searchParams
        for (const key of WANT) {
          if (!cookies[key] && query.get(key)) cookies[key] = query.get(key)
        }
      } catch {
        /* ignore */
      }
    }
    if (!cookies.SESSDATA) {
      session.status = 'error'
      session.message = '登录成功但没拿到 SESSDATA（B 站接口变了），请重试'
      log('登录：成功回调里没有 SESSDATA')
      return
    }
    // buvid3/buvid4：降低风控概率（不是登录态本身）
    try {
      const spi = await fetch(FINGER_SPI_URL, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' } })
      const json2 = await spi.json()
      const data = json2?.data || {}
      if (data.b_3 && !cookies.buvid3) cookies.buvid3 = data.b_3
      if (data.b_4 && !cookies.buvid4) cookies.buvid4 = data.b_4
    } catch {
      /* 拿不到也能登录 */
    }
    cookies.savedAt = new Date().toISOString()
    writeCookieRaw(cookies)
    resetWbiCache()
    session.status = 'success'
    session.message = '登录成功'
    try {
      const info = await nav()
      session.uname = info.uname
      session.message = info.uname ? `已登录：${info.uname}` : '登录成功'
    } catch {
      /* ignore */
    }
    log(`登录成功（字段：${Object.keys(cookies).filter((k) => WANT.includes(k)).join(',')}）`)
  }

  async function pollOnce() {
    if (!session || polling) return
    if (session.status !== 'waiting' && session.status !== 'scanned') return
    if (Date.now() > session.expiresAt) {
      session.status = 'expired'
      session.message = '二维码过期了，点「换一张」重新生成'
      return
    }
    polling = true
    try {
      const res = await fetch(`${QR_POLL_URL}?qrcode_key=${encodeURIComponent(session.key)}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Referer: 'https://www.bilibili.com/',
        },
        signal: AbortSignal.timeout(15_000),
      })
      const json = await res.json().catch(() => ({}))
      const code = json?.data?.code
      consecutiveErrors = 0
      if (code === 0) {
        await finish(json, res)
        return
      }
      if (code === 86090) {
        session.status = 'scanned'
        session.message = '扫到了，等手机上点「确认登录」'
        return
      }
      if (code === 86038 || code === 86039) {
        session.status = 'expired'
        session.message = '二维码过期了，点「换一张」重新生成'
        return
      }
      session.status = 'waiting'
      session.message = '用手机 B 站扫码（有效期约 3 分钟）'
    } catch (error) {
      consecutiveErrors++
      log(`登录 poll 失败（第 ${consecutiveErrors} 次）：${error?.message || error}`)
      if (consecutiveErrors >= 5) {
        session.status = 'error'
        session.message = '轮询登录状态连续失败，检查一下网络再重试'
      }
    } finally {
      polling = false
    }
  }

  function schedule() {
    clearTimer()
    if (!session || (session.status !== 'waiting' && session.status !== 'scanned')) return
    timer = setTimeout(async () => {
      await pollOnce()
      schedule()
    }, POLL_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async function start() {
    // 还有效的二维码直接复用，避免页面和工具各生成一张、互相抢轮询
    if (session && (session.status === 'waiting' || session.status === 'scanned') && Date.now() < session.expiresAt) {
      return session
    }
    clearTimer()
    const res = await fetch(QR_GENERATE_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Referer: 'https://www.bilibili.com/',
      },
      signal: AbortSignal.timeout(20_000),
    }).catch((error) => {
      throw new BiliError('NETWORK', `拿二维码失败：${error?.message || error}`)
    })
    const json = await res.json().catch(() => ({}))
    if (json.code !== 0) throwApiError(json, 'QR_FAILED')
    const data = json.data || {}
    if (!data.url || !data.qrcode_key) throw new BiliError('QR_FAILED', 'B 站没有返回二维码内容')
    session = {
      url: data.url,
      key: data.qrcode_key,
      at: Date.now(),
      png: qrPng(data.url, { scale: 8, border: 4 }),
      status: 'waiting',
      message: '用手机 B 站扫码（有效期约 3 分钟）',
      expiresAt: Date.now() + QR_TTL_MS,
      uname: '',
    }
    consecutiveErrors = 0
    log(`登录：生成二维码（内容长度 ${data.url.length}，有效期 ${Math.round(QR_TTL_MS / 1000)} 秒）`)
    schedule()
    return session
  }

  /** 最多等 timeoutMs，直到状态离开 waiting/scanned 或超时。 */
  async function waitFor(timeoutMs = 25_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = snapshot()
      if (state.state === 'success' || state.state === 'expired' || state.state === 'error' || state.state === 'idle') {
        return state
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return snapshot()
  }

  function stop() {
    clearTimer()
    session = null
  }

  function logout() {
    clearTimer()
    session = null
    clearCookies()
    resetWbiCache()
    log('登录：已退出（cookie 文件已移除）')
    return { state: 'idle', message: '已退出登录', hasCookie: false }
  }

  return {
    start,
    waitFor,
    stop,
    logout,
    snapshot,
    pollOnce,
    png() {
      return session?.png || null
    },
  }
}
