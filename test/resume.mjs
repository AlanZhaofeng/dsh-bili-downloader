/**
 * 断点续传自测：先下 1.5 秒然后掐断，再用同一目标续传。
 *   node test/resume.mjs
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pickAudioStream, pickVideoStream, playurl, view } from '../lib/bili.mjs'
import { downloadStream } from '../lib/download.mjs'
import { ensureDir, loadConfig } from '../lib/config.mjs'
import { DATA_DIR } from '../lib/config.mjs'

const config = loadConfig()
const workDir = ensureDir(join(DATA_DIR, 'test-resume'))
const dest = join(workDir, 'resume-test.m4s')
for (const suffix of ['', '.part', '.part.json']) rmSync(dest + suffix, { force: true })

const info = await view(await (async () => ({ bvid: 'BV1wp4y1s7n3' }))())
const data = await playurl({ bvid: info.bvid, cid: info.cid, qn: 80, fnval: 4048 })
const video = pickVideoStream(data.dash, { quality: '1080p', codec: 'avc' })
const headers = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
}
const common = {
  url: video.stream.baseUrl,
  backupUrls: video.stream.backupUrl,
  headers,
  chunkSize: config.chunkSize,
  concurrency: config.concurrency,
  label: 'resume',
}

console.log('第一段：下 1.5 秒后 abort')
const controller = new AbortController()
setTimeout(() => controller.abort(), 1500)
let aborted = false
try {
  await downloadStream({ ...common, dest, signal: controller.signal })
} catch (error) {
  aborted = true
  console.log('如预期中断：', error.code || error.name, error.message)
}
const stateFile = dest + '.part.json'
if (!existsSync(stateFile)) {
  console.error('✗ 没有留下 .part.json，续传信息丢了')
  process.exit(1)
}
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
console.log(`中断后：已完成 ${state.done.length} 片 / 共 ${Math.ceil(state.total / state.chunkSize)} 片，` +
  `.part 大小 ${(statSync(dest + '.part').size / 1048576).toFixed(1)}MB`)

console.log('\n第二段：续传')
const started = Date.now()
const result = await downloadStream({ ...common, dest })
const seconds = ((Date.now() - started) / 1000).toFixed(1)
const size = statSync(dest).size
console.log(`完成：${(size / 1048576).toFixed(1)}MB，用时 ${seconds}s，resumed=${result.resumed}`)
console.log(`正确性：大小一致？ ${size === state.total}`)

const ok = aborted && result.resumed && size === state.total
rmSync(dest, { force: true })
rmSync(workDir, { recursive: true, force: true })
console.log(ok ? '✓ 断点续传通过' : '✗ 断点续传有问题')
process.exit(ok ? 0 : 1)
