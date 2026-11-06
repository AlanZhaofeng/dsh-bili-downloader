/**
 * 冒烟测试：不经过 DSH，直接把插件入口 apply() 挂在一个假 ctx 上，
 * 然后调用真正注册出来的工具。这样测的就是线上跑的那份代码。
 *
 *   node test/smoke.mjs            # 接口 + 选流 + 小文件下载
 *   node test/smoke.mjs --full     # 再加 1080P 合流
 *   node test/smoke.mjs --4k       # 再加 4K（约 333MB，慢）
 *   node test/smoke.mjs --out=D:\x # 指定测试输出目录（默认 %DSH_HOME%\bili-downloader\test-downloads）
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { DATA_DIR, loadConfig } from '../lib/config.mjs'

const args = new Set(process.argv.slice(2))
const registered = []
const routes = []
// 假 webServer：记录注册的路由（同时验证「webServer 晚于插件就绪」那条路径）
const fakeWebServer = {
  register(route) {
    routes.push(route)
    return () => {}
  },
}
const fakeCtx = {
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  effect(fn) {
    const disposer = fn()
    return () => disposer?.()
  },
  get() {
    return undefined // 启动早期：webServer 还没就绪
  },
  inject(deps, callback) {
    if (deps.includes('webServer')) {
      callback({
        webServer: fakeWebServer,
        effect: (fn) => {
          const disposer = fn()
          return () => disposer?.()
        },
      })
    }
  },
  on() {},
}

apply(fakeCtx)
const tool = (name) => {
  const definition = registered.find((d) => d.name === name)
  if (!definition) throw new Error(`没注册出工具 ${name}`)
  return definition
}

console.log('注册的工具：', registered.map((d) => d.name).join(', '))
console.log('bili_download 参数：', Object.keys(tool('bili_download').parameters.properties).join(', '))
const routePaths = routes.map((r) => r.path).sort()
console.log(`注册的路由（${routes.length} 条）：`, routePaths.join(', '))
if (!routePaths.includes('/dsh-bili-downloader/status') || !routePaths.includes('/dsh-bili-downloader/qr.png')) {
  console.error('✗ webServer 晚就绪时没有注册出关键路由')
  process.exit(1)
}

const controller = new AbortController()
const exec = { signal: controller.signal }
// 测试产物放到数据目录里，别往用户的下载目录堆
const outArg = process.argv.find((v) => v.startsWith('--out='))?.slice(6)
const outDir = outArg || join(DATA_DIR, 'test-downloads')
const results = []
const download = (options) => tool('bili_download').execute({ outputDir: outDir, ...options }, exec)

async function step(name, fn, { expectFail = false } = {}) {
  const started = Date.now()
  process.stdout.write(`\n=== ${name} ===\n`)
  try {
    const value = await fn()
    results.push({ name, ok: true, expectedFail: expectFail && value?.ok === false, value })
    console.log(JSON.stringify(value, null, 2))
    console.log(`(${((Date.now() - started) / 1000).toFixed(1)}s)${expectFail ? ' ← 预期失败' : ''}`)
    return value
  } catch (error) {
    results.push({ name, ok: expectFail, error })
    if (expectFail) {
      console.log(`预期内失败：${error?.code || ''} ${error?.message || error}`)
    } else {
      console.error('失败：', error?.stack || error)
    }
    return null
  }
}

await step('bili_login status', () => tool('bili_login').execute({ action: 'status' }, exec))

const single = await step('720P 单文件', () => download({ url: 'BV1cgqjB3Enz', quality: '720p', mode: 'video' }))

const audio = await step('纯音频 m4a', () => download({ url: 'BV1cgqjB3Enz', mode: 'audio' }))

await step('不存在的 BV', () => download({ url: 'BV1xxxxxxxxx' }), { expectFail: true })

await step('错误参数（quality=233）', () => download({ url: 'BV1cgqjB3Enz', quality: '233' }), { expectFail: true })

if (args.has('--full')) {
  await step('1080P（wbi 签名 + ffmpeg 合流）', () => download({ url: 'BV1wp4y1s7n3', quality: '1080p', codec: 'avc' }))
}

if (args.has('--4k')) {
  await step('4K AVC（需要登录 + 大会员）', () => download({ url: 'BV1NGZtBwELa', quality: '4k', codec: 'avc' }))
}

console.log('\n=== 产物 ===')
for (const item of results) {
  if (item.ok && item.value?.path) {
    try {
      const size = statSync(item.value.path).size
      console.log(`${item.name}: ${item.value.path} (${(size / 1048576).toFixed(1)}MB)`)
    } catch {
      console.log(`${item.name}: 文件不见了（${item.value.path}）`)
    }
  }
}

const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.error(`\n${failed.length} 个测试失败`)
  process.exit(1)
}
console.log(`\n配置目录：${DATA_DIR}（默认输出目录：${loadConfig().outputDir}）`)
console.log('冒烟测试通过')
void single
void audio
