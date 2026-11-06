/**
 * 二维码编码自测：跟 Python `qrcode` 8.2 逐位对比。
 *   node test/qr.test.mjs
 * 生成 oracle：python test/qr-oracle.py | Set-Content test/qr-oracle.json -Encoding utf8
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { qrMatrix, qrMatrixForTest, qrPng } from '../lib/qr.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const oracle = JSON.parse(readFileSync(join(here, 'qr-oracle.json'), 'utf8').replace(/^\uFEFF/, ''))

const toRows = ({ size, modules }) => {
  const rows = []
  for (let r = 0; r < size; r++) {
    let line = ''
    for (let c = 0; c < size; c++) line += modules[r * size + c] ? '1' : '0'
    rows.push(line)
  }
  return rows
}

let failures = 0
const fail = (msg) => {
  failures++
  console.error('✗ ' + msg)
}

for (const sample of oracle.samples) {
  const version = sample.version
  for (let mask = 0; mask < 8; mask++) {
    const ours = toRows(qrMatrixForTest(sample.text, version, mask))
    const expected = sample.masks[mask]
    if (ours.length !== expected.length) {
      fail(`v${version} mask${mask} 尺寸 ${ours.length} != ${expected.length}`)
      continue
    }
    let diff = 0
    const spots = []
    for (let r = 0; r < ours.length; r++) {
      if (ours[r] === expected[r]) continue
      for (let c = 0; c < ours[r].length; c++) {
        if (ours[r][c] !== expected[r][c]) {
          diff++
          if (spots.length < 8) spots.push(`(${r},${c})`)
        }
      }
    }
    if (diff) fail(`v${version} mask${mask} 有 ${diff} 个模块不同：${spots.join(' ')}`)
  }

  const auto = qrMatrix(sample.text, { border: 4 })
  const chosen = sample.masks[auto.mask]
  const rows = []
  for (let r = 0; r < auto.moduleSize; r++) {
    let line = ''
    for (let c = 0; c < auto.moduleSize; c++) line += auto.grid[r + 4][c + 4] ? '1' : '0'
    rows.push(line)
  }
  if (auto.version !== version) fail(`自动选版本 ${auto.version} != ${version}`)
  if (rows.join() !== chosen.join()) fail(`自动掩码 v${version} 选出的矩阵与参考不一致（mask ${auto.mask}）`)
}

const png = qrPng('https://www.bilibili.com/video/BV1NGZtBwELa', { scale: 6, border: 4 })
if (png.subarray(1, 4).toString('ascii') !== 'PNG') fail('PNG 签名不对')
if (png.length < 200) fail('PNG 太小了')

// 边界：短文本 / 长文本都能编码
for (const text of ['a', 'x'.repeat(200), '中文标题也能编']) {
  try {
    qrMatrix(text)
  } catch (error) {
    fail(`编码「${text.slice(0, 12)}…」失败：${error.message}`)
  }
}

if (failures) {
  console.error(`\n${failures} 处不一致`)
  process.exit(1)
}
console.log(`✓ 二维码编码与参考实现逐位一致（${oracle.samples.length} 段文本 × 8 种掩码）；PNG ${png.length} 字节`)
