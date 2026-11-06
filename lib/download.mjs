/**
 * 下载：Range 分片 + 4 并发 + 断点续传 + 尺寸校验。
 *
 * 落盘策略（方案 §3.1）：
 *   <dest>.part       正在写的文件（预分配后按偏移写，不在内存里堆整个视频）
 *   <dest>.part.json  已完成的分片号 + 总大小 + 分片大小
 * 流地址约 2 小时过期且绑 IP —— 每片失败会先用 backupUrl 重试，403 直接报 STREAM_EXPIRED，
 * 让上层重新拿一次 playurl 再续传（已下好的分片不会白下）。
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BiliError } from './bili.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 目录所在磁盘的可用字节数。 */
export function freeBytes(dir) {
  try {
    const stat = statfsSync(dir)
    return Number(stat.bavail) * Number(stat.bsize)
  } catch {
    return null
  }
}

function statePath(dest) {
  return dest + '.part.json'
}

function readState(dest) {
  try {
    return JSON.parse(readFileSync(statePath(dest), 'utf8'))
  } catch {
    return null
  }
}

function saveState(dest, state) {
  try {
    writeFileSync(statePath(dest), JSON.stringify(state), 'utf8')
  } catch {
    /* 状态写不进去最多续传失效，不影响下载本身 */
  }
}

/** 探测资源大小（HEAD，失败再 Range 0-0）。 */
async function probeSize(url, headers, signal) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers, signal })
    const length = Number(res.headers.get('content-length') || 0)
    if (res.ok && length > 0) return { size: length, ranges: res.headers.get('accept-ranges') !== 'none' }
  } catch {
    /* HEAD 不被支持时走 Range */
  }
  try {
    const res = await fetch(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal })
    const range = res.headers.get('content-range') || ''
    const total = Number(/\/(\d+)$/.exec(range)?.[1] || 0)
    try {
      await res.body?.cancel()
    } catch {
      /* ignore */
    }
    if (res.status === 206 && total > 0) return { size: total, ranges: true }
  } catch {
    /* ignore */
  }
  return { size: 0, ranges: false }
}

function pickUrl(primary, backups, attempt) {
  const list = [primary, ...backups].filter(Boolean)
  return list[attempt % list.length]
}

function headersFor(url, headers, offset, end) {
  return { ...headers, Range: `bytes=${offset}-${end}`, Accept: '*/*' }
}

/**
 * 下载一个 DASH 流到 dest。
 * @param {object} options
 * @param {string} options.url 主地址（baseUrl）
 * @param {string[]} [options.backupUrls]
 * @param {string} options.dest 最终文件路径（写入 dest.part，完成后改名）
 * @param {number} [options.expectedBytes] 已知大小（dash 流没给，一般是 0）
 * @param {object} options.headers 必须带 Referer/UA/Cookie
 * @param {number} [options.chunkSize]
 * @param {number} [options.concurrency]
 * @param {AbortSignal} [options.signal]
 * @param {(progress: object) => void} [options.onProgress]
 * @param {string} [options.label]
 */
export async function downloadStream({
  url,
  backupUrls = [],
  dest,
  expectedBytes = 0,
  headers,
  chunkSize = 8 * 1024 * 1024,
  concurrency = 4,
  signal,
  onProgress,
  label = 'stream',
}) {
  mkdirSync(dirname(dest), { recursive: true })
  const partPath = dest + '.part'

  const probe = await probeSize(url, headers, signal)
  const total = probe.size || Number(expectedBytes) || 0
  if (!total) {
    // 拿不到长度：退回整文件流式下载（没有断点续传）
    return downloadWhole({ url, backupUrls, dest, headers, signal, onProgress, label })
  }

  let state = readState(dest)
  if (!state || state.total !== total || state.chunkSize !== chunkSize) {
    state = { total, chunkSize, done: [], label, startedAt: Date.now() }
  }
  const totalChunks = Math.ceil(total / chunkSize)
  const done = new Set(state.done.filter((i) => Number.isInteger(i) && i < totalChunks))
  const resumed = done.size > 0
  const inFlight = new Set()
  let written = 0
  for (const index of done) written += chunkLength(index, total, chunkSize)

  const fh = await open(partPath, 'r+').catch(async (error) => {
    if (error.code !== 'ENOENT') throw error
    const created = await open(partPath, 'w+')
    await created.truncate(total)
    return created
  })
  try {
    const sizeNow = statSync(partPath).size
    if (sizeNow !== total) await fh.truncate(total)
  } catch {
    /* ignore */
  }

  const startedAt = Date.now()
  let lastReport = 0
  const report = (force = false) => {
    const now = Date.now()
    if (!force && now - lastReport < 500) return
    lastReport = now
    const elapsed = Math.max((now - startedAt) / 1000, 0.1)
    onProgress?.({
      label,
      bytes: written,
      total,
      percent: total ? (written / total) * 100 : 0,
      speed: written / elapsed,
      chunks: done.size,
      totalChunks,
    })
  }

  const nextIndex = () => {
    for (let i = 0; i < totalChunks; i++) {
      if (!done.has(i) && !inFlight.has(i)) return i
    }
    return -1
  }

  const fetchChunk = async (index) => {
    const start = index * chunkSize
    const end = Math.min(start + chunkSize, total) - 1
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) throw new BiliError('ABORTED', '已取消')
      const target = pickUrl(url, backupUrls, attempt)
      try {
        const res = await fetch(target, { headers: headersFor(target, headers, start, end), signal })
        if (res.status === 206) {
          const buffer = Buffer.from(await res.arrayBuffer())
          await fh.write(buffer, 0, buffer.length, start)
          return buffer.length
        }
        if (res.status === 416) throw new BiliError('STREAM_EXPIRED', '分片请求越界，流地址可能已失效')
        if (res.status === 403) throw new BiliError('STREAM_EXPIRED', '视频流 403（地址过期或换了 IP），需要重新取流')
        lastError = new BiliError('NETWORK', `分片 ${index} 下载失败（HTTP ${res.status}）`)
      } catch (error) {
        if (error instanceof BiliError && error.code === 'STREAM_EXPIRED') throw error
        if (signal?.aborted) throw error
        lastError = error
      }
      await sleep(500 * (attempt + 1))
    }
    throw lastError || new BiliError('NETWORK', `分片 ${index} 下载失败`)
  }

  const worker = async () => {
    for (;;) {
      const index = nextIndex()
      if (index < 0) return
      inFlight.add(index)
      try {
        const bytes = await fetchChunk(index)
        done.add(index)
        written += bytes
        state.done = [...done]
        saveState(dest, state)
        report()
      } finally {
        inFlight.delete(index)
      }
    }
  }

  report(true)
  try {
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, totalChunks)) }, () => worker())
    await Promise.all(workers)
  } finally {
    try {
      await fh.close()
    } catch {
      /* ignore */
    }
  }

  if (signal?.aborted) throw new BiliError('ABORTED', '已取消')
  const size = statSync(partPath).size
  if (size !== total) {
    // 尺寸不对就丢掉状态，下次重新下（宁可重下，也不交付坏文件）
    rmSync(statePath(dest), { force: true })
    throw new BiliError('SIZE_MISMATCH', `下载完成但大小不对：${size} != ${total}`)
  }
  renameSync(partPath, dest)
  rmSync(statePath(dest), { force: true })
  report(true)
  return { bytes: total, path: dest, resumed }
}

function chunkLength(index, total, chunkSize) {
  return Math.min(chunkSize, total - index * chunkSize)
}

/** 拿不到长度时的兜底：整文件流式写。 */
async function downloadWhole({ url, backupUrls, dest, headers, signal, onProgress, label }) {
  const partPath = dest + '.part'
  const out = createWriteStream(partPath)
  let bytes = 0
  try {
    const res = await fetch(url, { headers, signal })
    if (!res.ok) {
      throw res.status === 403
        ? new BiliError('STREAM_EXPIRED', '视频流 403（地址过期或换了 IP）')
        : new BiliError('NETWORK', `下载失败（HTTP ${res.status}）`)
    }
    const total = Number(res.headers.get('content-length') || 0)
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r))
      onProgress?.({ label, bytes, total, percent: total ? (bytes / total) * 100 : 0, speed: 0 })
    }
  } finally {
    await new Promise((r) => out.end(r))
  }
  renameSync(partPath, dest)
  return { bytes, path: dest, resumed: false }
}

/**
 * 单文件 mp4（durl 可能分成多段）：按顺序拼接，一段一段落盘。
 */
export async function downloadSegments({ segments, dest, headers, signal, onProgress, label = 'file' }) {
  mkdirSync(dirname(dest), { recursive: true })
  const partPath = dest + '.part'
  rmSync(partPath, { force: true })
  const out = createWriteStream(partPath)
  let bytes = 0
  const total = segments.reduce((n, s) => n + (Number(s.size) || 0), 0)
  try {
    for (const segment of segments) {
      const res = await fetch(segment.url, { headers, signal })
      if (!res.ok) {
        throw res.status === 403
          ? new BiliError('STREAM_EXPIRED', '视频流 403（地址过期或换了 IP）')
          : new BiliError('NETWORK', `下载失败（HTTP ${res.status}）`)
      }
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.length
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r))
        onProgress?.({ label, bytes, total, percent: total ? (bytes / total) * 100 : 0, speed: 0 })
      }
    }
  } finally {
    await new Promise((r) => out.end(r))
  }
  renameSync(partPath, dest)
  return { bytes, path: dest }
}

/** 删掉残留的 .part / 状态文件（失败清理用）。 */
export function cleanupPartials(dest) {
  for (const suffix of ['.part', '.part.json']) {
    try {
      rmSync(dest + suffix, { force: true })
    } catch {
      /* ignore */
    }
  }
}

export function existsFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}
