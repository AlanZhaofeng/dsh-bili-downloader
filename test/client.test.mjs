/**
 * 客户端半边自测（不需要浏览器）：
 *   node test/client.test.mjs
 *
 * 用最小 React 桩把 client.js 里的 Panel / BiliIcon 渲染成元素树，
 * 检查①侧栏图标与主面板有没有注册到正确的 slot/键；②面板骨架能不能画出来；
 * ③渲染阶段会不会误发请求。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let failures = 0
const check = (ok, label, detail) => {
  if (ok) {
    console.log('✓ ' + label)
  } else {
    failures++
    console.error('✗ ' + label + (detail ? '：' + detail : ''))
  }
}

// ---------- 最小 React ----------
const makeReact = () => {
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() })
  return {
    createElement,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }
}

// ---------- 载入客户端模块 ----------
let definition = null
const sandboxWindow = {
  __ModuleLoader__: {
    load(loaded) {
      definition = loaded
    },
  },
}
const context = vm.createContext({
  window: sandboxWindow,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  JSON,
  String,
  Number,
  Array,
  Object,
  Promise,
  Error,
  URL,
  fetch: () => {
    throw new Error('渲染阶段不应该发请求')
  },
  navigator: { clipboard: { writeText() {} } },
})
vm.runInContext(source, context, { filename: 'client.js' })

check(definition !== null, 'client.js 通过 window.__ModuleLoader__.load 注册了工厂')
check(definition && definition.id === pkg.name, '模块 id 与包名一致', definition && definition.id)

const react = makeReact()
const mod = definition.factory((name) => {
  if (name === 'react') return react
  throw new Error('unexpected require: ' + name)
})

check(typeof mod.apply === 'function', '导出 apply')
check(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'inject 声明包含 slots')

// ---------- 假 ctx 与 slots ----------
const registrations = []
const slots = {
  inject(slotName, callback) {
    const disposer = callback()
    return () => disposer?.()
  },
  register(options, component) {
    registrations.push({ options, component })
    return () => {}
  },
}
const ctx = {
  get(name) {
    return name === 'slots' ? slots : undefined
  },
  effect(fn) {
    const disposer = fn()
    return () => disposer?.()
  },
}
mod.apply(ctx)

const icon = registrations.find((r) => r.options.name === 'sidebar.panellist')
const panel = registrations.find((r) => r.options.name === 'main')

check(Boolean(icon), '注册了 sidebar.panellist（左侧栏入口）')
check(icon && icon.options.id === 'bili-downloader', '侧栏 id 是 bili-downloader', icon && icon.options.id)
check(icon && icon.options.order === 20, '侧栏 order = 20')
check(typeof icon.options.label === 'function' && icon.options.label() === 'B 站下载器', '侧栏 label 是「B 站下载器」')
check(Boolean(panel), '注册了 main 面板')
check(panel && panel.options.key === 'bili-downloader', '主面板 key 与侧栏 id 相同', panel && panel.options.key)

// ---------- 图标 ----------
const iconTree = icon.component({ size: 18, active: false })
const iconSvg = iconTree.type === 'svg' ? iconTree : null
check(iconSvg !== null, '图标渲染成 svg')
check(iconSvg && iconSvg.props.width === 18 && iconSvg.props.height === 18, '图标使用 owner 给的 size')
check(iconSvg && iconSvg.props['aria-hidden'] === true, '图标 aria-hidden')

// ---------- 面板 ----------
const panelTree = panel.component({})
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return (node.children || []).map(textOf).join(' ')
}
const text = textOf(panelTree)
for (const expected of ['B 站下载器', '账号', '扫码登录', '新建下载', '任务', '配置', '最近日志']) {
  check(text.includes(expected), `面板包含「${expected}」`)
}
check(text.length > 200, '面板内容非空', String(text.length))

// 面板根节点应该是 flex/grid 容器而不是裸文本
check(panelTree && panelTree.type === 'div', '面板根节点是 div')
check(textOf(panelTree).includes('还没有任务'), '空任务时有提示文案')

// ---------- 清单 ----------
check(Boolean(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web'), 'package.json 声明 dsh.client.platform = web')
check(pkg.dsh.client.immediately === true, '客户端模块 immediately = true')
check(pkg.exports && pkg.exports['./client'] === './lib/client.js', 'exports 暴露 ./client')

if (failures) {
  console.error(`\n${failures} 项不通过`)
  process.exit(1)
}
console.log('\n客户端半边自测通过')
