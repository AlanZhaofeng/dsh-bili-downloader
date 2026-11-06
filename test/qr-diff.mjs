import { readFileSync } from 'node:fs'
import { qrMatrixForTest } from '../lib/qr.mjs'

const oracle = JSON.parse(readFileSync(new URL('qr-oracle.json', import.meta.url), 'utf8'))
const version = Number(process.argv[2] || 7)
const mask = Number(process.argv[3] || 0)

const sample = oracle.samples.find((s) => s.version === version)
if (!sample) throw new Error('no sample for version ' + version)
const mine = qrMatrixForTest(sample.text, version, mask)
const size = mine.size
const rows = []
for (let r = 0; r < size; r++) {
  let line = ''
  for (let c = 0; c < size; c++) line += mine.modules[r * size + c] ? '1' : '0'
  rows.push(line)
}
const expected = sample.masks[mask]
const diff = []
for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (rows[r][c] !== expected[r][c]) diff.push([r, c])
console.log('size', size, 'diff', diff.length)
if (diff.length) {
  const rs = diff.map((d) => d[0])
  const cs = diff.map((d) => d[1])
  console.log('rows', Math.min(...rs), '..', Math.max(...rs), 'cols', Math.min(...cs), '..', Math.max(...cs))
  const perRow = {}
  for (const [r] of diff) perRow[r] = (perRow[r] || 0) + 1
  console.log('perRow', Object.entries(perRow).map(([r, n]) => `${r}:${n}`).join(' '))
  console.log('first 12 diff coords', diff.slice(0, 12).map((d) => d.join(',')).join(' '))
}
