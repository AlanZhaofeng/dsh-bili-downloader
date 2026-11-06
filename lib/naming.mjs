/**
 * 标题 → Windows 安全文件名。
 * 规则：去掉 < > : " / \ | ? * 和控制字符 → 收窄空格 → 截到 60 字 → 追加 [BV号]；
 * 避开 CON/PRN/AUX… 这些保留名和结尾的 . / 空格；重名加 (2)。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export function safeTitle(title, maxLength = 60) {
  let name = String(title || '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (name.length > maxLength) name = name.slice(0, maxLength).trim()
  name = name.replace(/[. ]+$/, '')
  if (!name) name = 'bilibili'
  if (RESERVED.test(name)) name = '_' + name
  return name
}

/** 最终的输出文件名（不含目录），标题 + 序号 + BV 号，重名自动加 (2)。 */
export function buildFileName({ title, bvid, page, suffix = '', ext = '.mp4', dir }) {
  const base = safeTitle(title)
  const pageTag = page && page > 1 ? ` P${page}` : ''
  const tag = ` [${bvid}${pageTag}]${suffix}`
  let name = `${base}${tag}${ext}`
  if (!dir) return name
  let candidate = name
  let n = 2
  while (existsSync(join(dir, candidate))) {
    name = `${base}${tag} (${n})${ext}`
    candidate = name
    n++
    if (n > 200) break
  }
  return candidate
}

/** 临时目录名：同一个视频、同一分P 断点续传时能复用。 */
export function tempDirName(bvid, cid) {
  return `${bvid}-${cid}`.replace(ILLEGAL, '_')
}
