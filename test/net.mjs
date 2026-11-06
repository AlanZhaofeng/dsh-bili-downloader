import dns from 'node:dns/promises'
import https from 'node:https'

const host = 'api.bilibili.com'
try {
  console.log('dns', await dns.lookup(host, { all: true }))
} catch (error) {
  console.log('dns FAILED', error.code, error.message)
}

for (const url of ['https://api.bilibili.com/x/web-interface/nav', 'https://www.bilibili.com/', 'https://api.github.com/']) {
  const started = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    console.log('fetch', url, res.status, `${Date.now() - started}ms`)
  } catch (error) {
    const cause = error.cause
    console.log('fetch FAILED', url, error.name, error.message, '| cause:', cause && (cause.code || cause.message), cause && cause.errno)
  }
}

// node:https 直连（不走 fetch/undici）
await new Promise((resolve) => {
  const req = https.get('https://api.bilibili.com/x/web-interface/nav', { timeout: 15000 }, (res) => {
    console.log('https.get status', res.statusCode)
    res.resume()
    res.on('end', resolve)
  })
  req.on('timeout', () => {
    console.log('https.get timeout')
    req.destroy()
    resolve()
  })
  req.on('error', (error) => {
    console.log('https.get FAILED', error.code, error.message)
    resolve()
  })
})
