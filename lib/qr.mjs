/**
 * 纯 JS 二维码编码（byte 模式 / 纠错等级 M）+ PNG 输出。
 *
 * 为什么自己写：插件要离线可用，不能依赖 npm 包，也不能调用宿主机上的 Python。
 * 正确性由 test/qr.test.mjs 对照 Python `qrcode` 8.2 的模块矩阵逐位验证
 * （同一段文本、同一版本、同一掩码 → 矩阵完全一致）。
 *
 * 结构参考 ISO/IEC 18004，分块表来自参考实现（版本 1..20，等级 M）。
 */
import { deflateSync } from 'node:zlib'

/** 版本 1..20、纠错等级 M 的 RS 分块表：[总码字数, 数据码字数]，按块顺序排列。 */
const BLOCKS_M = {
  1: [[26,16]],
  2: [[44,28]],
  3: [[70,44]],
  4: [[50,32], [50,32]],
  5: [[67,43], [67,43]],
  6: [[43,27], [43,27], [43,27], [43,27]],
  7: [[49,31], [49,31], [49,31], [49,31]],
  8: [[60,38], [60,38], [61,39], [61,39]],
  9: [[58,36], [58,36], [58,36], [59,37], [59,37]],
  10: [[69,43], [69,43], [69,43], [69,43], [70,44]],
  11: [[80,50], [81,51], [81,51], [81,51], [81,51]],
  12: [[58,36], [58,36], [58,36], [58,36], [58,36], [58,36], [59,37], [59,37]],
  13: [[59,37], [59,37], [59,37], [59,37], [59,37], [59,37], [59,37], [59,37], [60,38]],
  14: [[64,40], [64,40], [64,40], [64,40], [65,41], [65,41], [65,41], [65,41], [65,41]],
  15: [[65,41], [65,41], [65,41], [65,41], [65,41], [66,42], [66,42], [66,42], [66,42], [66,42]],
  16: [[73,45], [73,45], [73,45], [73,45], [73,45], [73,45], [73,45], [74,46], [74,46], [74,46]],
  17: [[74,46], [74,46], [74,46], [74,46], [74,46], [74,46], [74,46], [74,46], [74,46], [74,46], [75,47]],
  18: [[69,43], [69,43], [69,43], [69,43], [69,43], [69,43], [69,43], [69,43], [69,43], [70,44], [70,44], [70,44], [70,44]],
  19: [[70,44], [70,44], [70,44], [71,45], [71,45], [71,45], [71,45], [71,45], [71,45], [71,45], [71,45], [71,45], [71,45], [71,45]],
  20: [[67,41], [67,41], [67,41], [68,42], [68,42], [68,42], [68,42], [68,42], [68,42], [68,42], [68,42], [68,42], [68,42], [68,42], [68,42], [68,42]],
}

/** 版本 1..20 的对齐图案中心坐标（标准表）。 */
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
  15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78],
  18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90],
}

// ---------- GF(256) ----------
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
})()

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** 生成多项式 ∏(x - α^i)，系数按降幂排列（首项 1）。 */
function rsGenerator(degree) {
  let gen = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(gen.length + 1).fill(0)
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j]
      next[j + 1] ^= gfMul(gen[j], EXP[i])
    }
    gen = next
  }
  return gen
}

/** 一个数据块的 RS 纠错字节。 */
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen)
  const buf = new Uint8Array(data.length + ecLen)
  buf.set(data)
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i]
    if (!factor) continue
    for (let j = 1; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], factor)
  }
  return buf.subarray(data.length)
}

// ---------- 码字 ----------
function utf8(text) {
  return new TextEncoder().encode(text)
}

function lengthBits(version) {
  return version <= 9 ? 8 : 16
}

function dataCapacityBytes(version) {
  const blocks = BLOCKS_M[version]
  if (!blocks) throw new Error(`不支持的二维码版本 ${version}`)
  return blocks.reduce((n, [, dataCount]) => n + dataCount, 0)
}

function pickVersion(byteLength) {
  for (let v = 1; v <= 20; v++) {
    const capBits = dataCapacityBytes(v) * 8
    const needed = 4 + lengthBits(v) + byteLength * 8
    if (needed <= capBits) return v
  }
  throw new Error(`内容太长，放不进二维码（${byteLength} 字节）`)
}

/** 数据位流 → 补齐填充 → 分块 → 纠错 → 交织，返回最终码字序列。 */
function makeCodewords(bytes, version) {
  const blocks = BLOCKS_M[version]
  const capBits = dataCapacityBytes(version) * 8
  const bits = []
  const put = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }
  put(0b0100, 4) // byte 模式
  put(bytes.length, lengthBits(version))
  for (const b of bytes) put(b, 8)

  const remain = capBits - bits.length
  put(0, Math.min(4, remain))
  while (bits.length % 8 !== 0) bits.push(0)
  const padBytes = [0xec, 0x11]
  let padIndex = 0
  while (bits.length < capBits) {
    const p = padBytes[padIndex++ % 2]
    for (let i = 7; i >= 0; i--) bits.push((p >> i) & 1)
  }

  const dataBytes = new Uint8Array(capBits / 8)
  for (let i = 0; i < dataBytes.length; i++) {
    let v = 0
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b]
    dataBytes[i] = v
  }

  const dataBlocks = []
  const ecBlocks = []
  let offset = 0
  let maxData = 0
  let maxEc = 0
  for (const [total, dataCount] of blocks) {
    const chunk = dataBytes.subarray(offset, offset + dataCount)
    offset += dataCount
    const ec = rsEncode(chunk, total - dataCount)
    dataBlocks.push(chunk)
    ecBlocks.push(ec)
    maxData = Math.max(maxData, chunk.length)
    maxEc = Math.max(maxEc, ec.length)
  }

  const out = []
  for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i])
  for (let i = 0; i < maxEc; i++) for (const b of ecBlocks) if (i < b.length) out.push(b[i])
  return Uint8Array.from(out)
}

// ---------- 矩阵 ----------
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

const bchDigit = (data) => {
  let digit = 0
  while (data !== 0) {
    digit++
    data >>>= 1
  }
  return digit
}

function bchTypeInfo(data) {
  const G15 = 0b10100110111
  const G15_MASK = 0b101010000010010
  const d0 = data << 10
  let d = d0
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15))
  return ((d0 | d) ^ G15_MASK) & 0x7fff
}

function bchTypeNumber(version) {
  const G18 = 0b1111100100101
  const d0 = version << 12
  let d = d0
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18))
  return (d0 | d) & 0x3ffff
}

function buildMatrix(codewords, version, maskPattern) {
  const size = version * 4 + 17
  const modules = new Uint8Array(size * size) // 0 = 浅，1 = 深
  const reserved = new Uint8Array(size * size)
  const set = (r, c, dark, reserve = true) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return
    modules[r * size + c] = dark ? 1 : 0
    if (reserve) reserved[r * size + c] = 1
  }

  // 定位图案 + 分隔符
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r
        const cc = col + c
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        set(rr, cc, dark)
      }
    }
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)

  // 对齐图案（必须画在定位线之前：v7 起 (6,22)/(22,6) 这类中心正落在定位线上，
  // 参考实现让对齐图案覆盖定位线，反过来的顺序会少画两个图案）
  const positions = ALIGN[version] || []
  for (const row of positions) {
    for (const col of positions) {
      if (reserved[row * size + col]) continue // 与定位图案重叠的三个角跳过
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          set(row + r, col + c, Math.max(Math.abs(r), Math.abs(c)) !== 1)
        }
      }
    }
  }

  // 定位线（不覆盖已有图案）
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0
    if (!reserved[6 * size + i]) set(6, i, dark)
    if (!reserved[i * size + 6]) set(i, 6, dark)
  }

  // 预留格式信息区 + 固定深色模块
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      set(8, i, false)
      set(i, 8, false)
    }
  }
  set(8, 8, false)
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, false)
    set(size - 1 - i, 8, false)
  }
  set(size - 8, 8, true)

  // 版本信息（版本 ≥ 7）
  if (version >= 7) {
    const bits = bchTypeNumber(version)
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) === 1
      const r = Math.floor(i / 3)
      const c = (i % 3) + size - 8 - 3
      set(r, c, dark)
      set(c, r, dark)
    }
  }

  // 数据区（之字形，从右下开始向上，逐列对推进；跳过第 6 列定位线）
  const maskFn = MASKS[maskPattern]
  let row = size - 1
  let inc = -1
  let bitIndex = 7
  let byteIndex = 0
  for (let col = size - 1; col > 0; col -= 2) {
    const pairCol = col <= 6 ? col - 1 : col // 第 6 列是定位线，整对左移一列（不能改循环变量）
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const cc = pairCol - c
        const idx = row * size + cc
        if (row < 0 || row >= size || reserved[idx]) continue
        let dark = false
        if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >> bitIndex) & 1) === 1
        if (maskFn(row, cc)) dark = !dark
        modules[idx] = dark ? 1 : 0
        bitIndex -= 1
        if (bitIndex === -1) {
          byteIndex += 1
          bitIndex = 7
        }
      }
      row += inc
      if (row < 0 || row >= size) {
        row -= inc
        inc = -inc
        break
      }
    }
  }

  // 格式信息（等级 M = 0b00）；两处副本的位置与参考实现一致
  const typeInfo = bchTypeInfo((0b00 << 3) | maskPattern)
  for (let i = 0; i < 15; i++) {
    const dark = ((typeInfo >> i) & 1) === 1
    // 竖排：左上角向下，然后转到左下
    const row = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i
    set(row, 8, dark)
    // 横排：右上（i<8），然后 (8,7)，再左上角剩余位
    const col = i < 8 ? size - 1 - i : i === 8 ? 7 : 14 - i
    set(8, col, dark)
  }

  return { size, modules, version, mask: maskPattern }
}

/** 掩码惩罚分（与参考实现同规则，保证选中同一个掩码）。 */
function penalty({ size, modules }) {
  const at = (r, c) => modules[r * size + c]
  let score = 0
  // 规则 1：同色连续 ≥5
  for (let r = 0; r < size; r++) {
    let run = 1
    for (let c = 1; c < size; c++) {
      if (at(r, c) === at(r, c - 1)) run++
      else {
        if (run >= 5) score += run - 2
        run = 1
      }
    }
    if (run >= 5) score += run - 2
  }
  for (let c = 0; c < size; c++) {
    let run = 1
    for (let r = 1; r < size; r++) {
      if (at(r, c) === at(r - 1, c)) run++
      else {
        if (run >= 5) score += run - 2
        run = 1
      }
    }
    if (run >= 5) score += run - 2
  }
  // 规则 2：2×2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c)
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3
    }
  }
  // 规则 3：1:1:3:1:1 且一侧有 4 个浅色
  const dark = (r, c) => at(r, c) === 1
  const light = (r, c) => at(r, c) === 0
  const patternA = (r, c, horizontal) => {
    const g = (k) => (horizontal ? at(r, c + k) : at(r + k, c))
    return (
      !g(1) && g(4) && !g(5) && g(6) && !g(9) &&
      ((g(0) && g(2) && g(3) && !g(7) && !g(8) && !g(10)) ||
        (!g(0) && !g(2) && !g(3) && g(7) && g(8) && g(10)))
    )
  }
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size - 10; c++) if (patternA(r, c, true)) score += 40
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r < size - 10; r++) if (patternA(r, c, false)) score += 40
  }
  // 规则 4：深色比例偏离 50%
  let darkCount = 0
  for (let i = 0; i < modules.length; i++) darkCount += modules[i]
  const percent = darkCount / (size * size)
  score += Math.trunc(Math.abs(percent * 100 - 50) / 5) * 10
  return score
}

/**
 * 编码成模块矩阵（true = 深色），自动选版本与掩码。
 * @param {string} text 待编码内容
 * @param {{border?: number}} [options]
 */
export function qrMatrix(text, options = {}) {
  const border = options.border ?? 0
  const bytes = utf8(text)
  const version = pickVersion(bytes.length)
  const codewords = makeCodewords(bytes, version)
  let best = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const candidate = buildMatrix(codewords, version, mask)
    const score = penalty(candidate)
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  const { size, modules } = best
  const full = size + border * 2
  const grid = []
  for (let r = 0; r < full; r++) {
    const row = []
    for (let c = 0; c < full; c++) {
      const inner = r - border >= 0 && c - border >= 0 && r - border < size && c - border < size
      row.push(inner ? modules[(r - border) * size + (c - border)] === 1 : false)
    }
    grid.push(row)
  }
  return { size: full, moduleSize: size, border, version, mask: best.mask, grid }
}

export function qrMatrixForTest(text, version, mask) {
  const bytes = utf8(text)
  const codewords = makeCodewords(bytes, version)
  return buildMatrix(codewords, version, mask)
}

/** 测试用：只画功能图案，返回占位图与空闲格数（用来对照参考实现）。 */
export function qrLayoutForTest(version) {
  const size = version * 4 + 17
  const reserved = new Uint8Array(size * size)
  const set = (r, c) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return
    reserved[r * size + c] = 1
  }
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) set(row + r, col + c)
    }
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)
  const positions = ALIGN[version] || []
  for (const row of positions) {
    for (const col of positions) {
      if (reserved[row * size + col]) continue
      for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) set(row + r, col + c)
    }
  }
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6 * size + i]) set(6, i)
    if (!reserved[i * size + 6]) set(i, 6)
  }
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      set(8, i)
      set(i, 8)
    }
  }
  set(8, 8)
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i)
    set(size - 1 - i, 8)
  }
  set(size - 8, 8)
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3)
      const c = (i % 3) + size - 8 - 3
      set(r, c)
      set(c, r)
    }
  }
  let free = 0
  for (let i = 0; i < reserved.length; i++) if (!reserved[i]) free++
  return { reserved, free }
}

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

/** 8 位灰度 PNG：每个模块 scale×scale 像素，白底黑块。 */
export function qrPng(text, { scale = 8, border = 4 } = {}) {
  const { grid, size } = qrMatrix(text, { border })
  const dim = size * scale
  const raw = Buffer.alloc((dim + 1) * dim)
  for (let y = 0; y < dim; y++) {
    const rowStart = y * (dim + 1)
    raw[rowStart] = 0 // filter: none
    const gy = Math.floor(y / scale)
    for (let x = 0; x < dim; x++) {
      const gx = Math.floor(x / scale)
      raw[rowStart + 1 + x] = grid[gy][gx] ? 0 : 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(dim, 0)
  ihdr.writeUInt32BE(dim, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
