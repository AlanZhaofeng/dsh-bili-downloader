/**
 * 接口层自测（不下文件）：view / 签名 playurl / 选流。
 *   node test/api.mjs [BV号 ...]
 */
import { ensureBuvid, pickAudioStream, pickVideoStream, playurl, playurlSingleFile, qualityLabel, resolveInput, view, availableQualities } from '../lib/bili.mjs'
import { hasCookie } from '../lib/bili.mjs'

const list = process.argv.slice(2)
const targets = list.length ? list : ['BV1wp4y1s7n3', 'BV1cgqjB3Enz', 'BV1NGZtBwELa']

const jar = await ensureBuvid({})
console.log('buvid3/buvid4：', jar.buvid3 ? '有' : '没有', '/', jar.buvid4 ? '有' : '没有')
console.log('账号登录态：', hasCookie() ? '有 cookie' : '未登录')

for (const raw of targets) {
  console.log(`\n=== ${raw} ===`)
  try {
    const input = await resolveInput(raw)
    const info = await view(input)
    console.log(`标题：${info.title}（${info.duration}s，${info.pages.length} P）`)

    const data = await playurl({ bvid: info.bvid, cid: info.cid, qn: 120, fnval: 4048 })
    console.log('可用档位：', availableQualities(data.dash).map((q) => `${q.label}=${q.qn}`).join(' / '))
    const video = pickVideoStream(data.dash, { quality: 'best', codec: 'avc' })
    const audio = pickAudioStream(data.dash)
    console.log(
      `best → ${qualityLabel(video.quality)}(${video.qn}) ${video.stream.codecs} ` +
        `${video.stream.width}x${video.stream.height} ${(Number(video.stream.bandwidth) / 1000).toFixed(0)}kbps` +
        ` + 音频 ${audio.id}`,
    )

    const single = await playurlSingleFile({ bvid: info.bvid, cid: info.cid, qn: 64 })
    console.log(`单文件：${single.durl.length} 段，接口自报 ${qualityLabel(String(single.quality))}`)
  } catch (error) {
    console.log(`失败：${error.code || ''} ${error.message}`)
  }
}
