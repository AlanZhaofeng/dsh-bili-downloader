/**
 * dsh-bili-downloader —— 浏览器半边。
 *
 * 在左侧栏注册一个图标（sidebar.panellist）＋一个主面板（main）；
 * 面板里做：登录状态 / 扫码 / 新建下载 / 任务进度 / 配置 / 最近日志。
 * 所有数据来自宿主半边的本地路由 /dsh-bili-downloader/*。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-downloader',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const BASE = '/dsh-bili-downloader'

    // ---------- 请求 ----------
    const getJson = async (path) => {
      const res = await fetch(BASE + path, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }
    const postJson = async (path, body) => {
      const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      return json
    }
    const mb = (bytes) => (Number(bytes) / 1048576).toFixed(1)
    const speedText = (bytesPerSec) => {
      const value = Number(bytesPerSec) || 0
      if (value >= 1048576) return `${(value / 1048576).toFixed(1)}MB/s`
      if (value >= 1024) return `${(value / 1024).toFixed(0)}KB/s`
      return value > 0 ? `${value.toFixed(0)}B/s` : ''
    }

    // ---------- 侧栏图标 ----------
    function BiliIcon(props) {
      const size = props && props.size ? props.size : 18
      const active = Boolean(props && props.active)
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.86 },
        },
        h('rect', { x: 2.5, y: 4.5, width: 19, height: 14.5, rx: 3.2 }),
        h('path', { d: 'M8 9.6v4.8l4.2-2.4z', fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M15.2 10.2h2.2M15.2 13.2h2.2' }),
      )
    }

    // ---------- 样式（组件内渲染，卸载即移除） ----------
    const CSS = `
.bili-page{height:100%;min-height:0;overflow:auto;padding:26px 28px 40px;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:13.5px/1.62 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.bili-page *{box-sizing:border-box}
.bili-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:18px}
.bili-title{font-size:20px;font-weight:650;letter-spacing:.2px;margin:0}
.bili-sub{color:var(--dsw-alias-label-secondary);font-size:12.5px;margin:2px 0 0}
.bili-grid{display:grid;grid-template-columns:minmax(300px,360px) minmax(0,1fr);gap:16px;align-items:start}
@media (max-width:980px){.bili-grid{grid-template-columns:minmax(0,1fr)}}
.bili-col{display:flex;flex-direction:column;gap:16px;min-width:0}
.bili-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:16px}
.bili-card h2{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:0 0 12px;letter-spacing:.3px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.bili-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bili-muted{color:var(--dsw-alias-label-secondary)}
.bili-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}
.bili-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.bili-dot.ok{background:var(--dsw-alias-state-success-primary)}
.bili-dot.wait{background:var(--dsw-alias-brand-primary)}
.bili-dot.err{background:var(--dsw-alias-state-error-primary)}
.bili-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.bili-badge.vip{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.bili-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:9px;padding:6px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}
.bili-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.bili-btn:disabled{opacity:.5;cursor:default}
.bili-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.bili-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.bili-qr{display:flex;justify-content:center;margin:4px 0 10px}
.bili-qr img{width:228px;height:228px;background:#fff;border-radius:12px;padding:8px;border:1px solid var(--dsw-alias-border-l1)}
.bili-qr-empty{width:228px;height:228px;border-radius:12px;border:1px dashed var(--dsw-alias-border-l2);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.bili-state{text-align:center;font-weight:600;font-size:13px}
.bili-hint{text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;margin:4px 0 0}
.bili-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}
.bili-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.bili-input{width:100%;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:9px;padding:8px 10px;font:inherit;font-size:13px;outline:none}
.bili-input:focus{border-color:var(--dsw-alias-brand-primary)}
.bili-inline{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.bili-task{border-top:1px solid var(--dsw-alias-border-l1);padding:10px 0 4px}
.bili-task:first-of-type{border-top:0;padding-top:0}
.bili-task-head{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.bili-task-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bili-task-meta{color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap}
.bili-bar{height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin:7px 0 4px}
.bili-bar i{display:block;height:100%;background:var(--dsw-alias-brand-primary);border-radius:999px;transition:width .3s}
.bili-task-foot{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.bili-err{color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-all}
.bili-empty{color:var(--dsw-alias-label-secondary);font-size:12.5px;padding:6px 0}
.bili-log{max-height:190px;overflow:auto;margin:0;padding:0;list-style:none;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.bili-log li{padding:2px 0;border-bottom:1px dashed var(--dsw-alias-border-l1);white-space:pre-wrap;word-break:break-all}
.bili-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:6px 10px;font-size:12.5px}
.bili-kv dt{color:var(--dsw-alias-label-secondary)}
.bili-kv dd{margin:0;min-width:0}
`

    function Style() {
      return h('style', { 'data-bili': 'styles' }, CSS)
    }

    // ---------- 主面板 ----------
    function Panel() {
      const [status, setStatus] = useState(null)
      const [account, setAccount] = useState(null)
      const [tasks, setTasks] = useState([])
      const [logs, setLogs] = useState([])
      const [form, setForm] = useState({ url: '', mode: 'video', quality: 'best' })
      const [busy, setBusy] = useState('')
      const [flash, setFlash] = useState('')
      const [qrKey, setQrKey] = useState(0)
      const [statusError, setStatusError] = useState('')
      const failCount = useRef(0)
      const mounted = useRef(true)
      const accountRef = useRef(0)

      const loadStatus = useCallback(async () => {
        try {
          const json = await getJson('/status')
          if (!mounted.current) return
          failCount.current = 0
          setStatusError('')
          setStatus(json)
        } catch (error) {
          // 宿主路由没注册 / 服务没起来时 /status 会 404：不要一直停在「二维码准备中」
          failCount.current += 1
          if (mounted.current && failCount.current >= 2) setStatusError(String(error.message || error))
        }
      }, [])

      const loadAccount = useCallback(async () => {
        try {
          const json = await getJson('/account')
          if (!mounted.current) return
          setAccount(json)
          accountRef.current = Date.now()
        } catch {
          /* ignore */
        }
      }, [])

      const loadTasks = useCallback(async () => {
        try {
          const json = await getJson('/tasks')
          if (!mounted.current) return
          setTasks(json.tasks || [])
        } catch {
          /* ignore */
        }
      }, [])

      const loadLogs = useCallback(async () => {
        try {
          const json = await getJson('/log?lines=60')
          if (mounted.current) setLogs(json.lines || [])
        } catch {
          /* ignore */
        }
      }, [])

      const refreshAll = useCallback(() => {
        loadStatus()
        loadAccount()
        loadTasks()
      }, [loadStatus, loadAccount, loadTasks])

      useEffect(() => {
        mounted.current = true
        refreshAll()
        loadLogs()
        const fast = setInterval(() => {
          loadStatus()
          loadTasks()
        }, 1500)
        const slow = setInterval(() => {
          if (Date.now() - accountRef.current > 5000) loadAccount()
          loadLogs()
        }, 5000)
        return () => {
          mounted.current = false
          clearInterval(fast)
          clearInterval(slow)
        }
      }, [refreshAll, loadLogs, loadStatus, loadTasks, loadAccount])

      // 二维码状态变化时换图（成功/过期）
      const statusState = status && status.state
      useEffect(() => {
        if (statusState === 'success' || statusState === 'expired' || statusState === 'error') {
          setQrKey((k) => k + 1)
        }
        if (statusState === 'success') loadAccount()
      }, [statusState, loadAccount])

      const startQr = async () => {
        setBusy('qr')
        setFlash('')
        try {
          await postJson('/qr/refresh')
          setQrKey((k) => k + 1)
          await loadStatus()
          setFlash('已换一张二维码')
        } catch (error) {
          setFlash(`换码失败：${error.message}`)
        } finally {
          setBusy('')
        }
      }

      const logout = async () => {
        if (!window.confirm('退出登录会删掉本机的 B 站 cookie（需要时再扫码即可）。确定退出？')) return
        setBusy('logout')
        try {
          await postJson('/logout')
          setAccount({ loggedIn: false })
          setQrKey((k) => k + 1)
          await loadStatus()
          setFlash('已退出登录')
        } catch (error) {
          setFlash(`退出失败：${error.message}`)
        } finally {
          setBusy('')
        }
      }

      const submit = async (event) => {
        event.preventDefault()
        const url = form.url.trim()
        if (!url) return
        setBusy('download')
        setFlash('')
        try {
          const json = await postJson('/download', {
            url,
            mode: form.mode,
            quality: form.quality,
          })
          setTasks((list) => [json.task, ...list])
          setForm((f) => ({ ...f, url: '' }))
          setFlash('已开始下载')
        } catch (error) {
          setFlash(`下载失败：${error.message}`)
        } finally {
          setBusy('')
        }
      }

      const copy = (text) => {
        try {
          window.navigator.clipboard.writeText(text)
          setFlash('已复制')
        } catch {
          setFlash(text)
        }
      }

      const stateText = useMemo(() => {
        if (statusError) return { text: '未连接到宿主', cls: 'err' }
        const state = status && status.state
        if (state === 'success') return { text: '登录成功', cls: 'ok' }
        if (state === 'scanned') return { text: '已扫码，等手机上确认', cls: 'wait' }
        if (state === 'expired') return { text: '二维码过期了', cls: 'err' }
        if (state === 'error') return { text: '登录出错了', cls: 'err' }
        if (state === 'waiting') return { text: '等待扫码…', cls: 'wait' }
        if (!status) return { text: '正在连接宿主…', cls: 'wait' }
        return { text: '还没有二维码', cls: '' }
      }, [status, statusError])

      const loggedIn = Boolean(account && account.loggedIn) || Boolean(status && status.hasCookie)
      const running = tasks.filter((t) => ['queued', 'downloading', 'merging'].includes(t.state))

      return h(
        'div',
        { className: 'bili-page' },
        h(Style),
        h(
          'header',
          { className: 'bili-head' },
          h('div', null, h('h1', { className: 'bili-title' }, 'B 站下载器'), h('p', { className: 'bili-sub' }, '下载视频 / 音频，扫码登录后可下 1080P+ 与 4K')),
          h(
            'div',
            { className: 'bili-row' },
            h('button', { className: 'bili-btn', onClick: refreshAll, type: 'button' }, '刷新'),
          ),
        ),
        flash
          ? h('div', { className: 'bili-hint', style: { textAlign: 'left', marginBottom: 10 } }, flash)
          : null,
        h(
          'div',
          { className: 'bili-grid' },
          // 左列：账号 + 二维码
          h(
            'div',
            { className: 'bili-col' },
            h(
              'section',
              { className: 'bili-card' },
              h('h2', null, '账号'),
              h(
                'div',
                { className: 'bili-row', style: { marginBottom: 12 } },
                h('span', { className: 'bili-dot ' + (loggedIn ? 'ok' : '') }),
                h('span', { style: { fontWeight: 600 } }, account && account.uname ? account.uname : loggedIn ? '已登录' : '未登录'),
                account && account.vip ? h('span', { className: 'bili-badge vip' }, '大会员') : null,
                account && account.level ? h('span', { className: 'bili-badge' }, 'Lv' + account.level) : null,
              ),
              h('p', { className: 'bili-hint', style: { textAlign: 'left', margin: '0 0 12px' } },
                loggedIn ? '登录态已保存在本机，1080P+/4K 可用。' : '扫码登录后才能下 1080P+ / 4K / HDR。'),
              h(
                'div',
                { className: 'bili-row' },
                h('button', { className: 'bili-btn', type: 'button', disabled: busy === 'qr', onClick: startQr }, busy === 'qr' ? '生成中…' : '换一张二维码'),
                loggedIn
                  ? h('button', { className: 'bili-btn danger', type: 'button', disabled: busy === 'logout', onClick: logout }, '退出登录')
                  : null,
              ),
            ),
            h(
              'section',
              { className: 'bili-card' },
              h('h2', null, '扫码登录', h('span', { className: 'bili-muted', style: { fontWeight: 400 } }, '手机 B 站 → 扫一扫')),
              h(
                'div',
                { className: 'bili-qr' },
                statusError
                  ? h(
                      'div',
                      { className: 'bili-qr-empty', style: { flexDirection: 'column', gap: 6, textAlign: 'center', padding: 16 } },
                      h('span', { style: { color: 'var(--dsw-alias-state-error-primary)', fontWeight: 600 } }, '连不上宿主路由'),
                      h('span', { style: { fontSize: 11.5, wordBreak: 'break-all' } }, statusError),
                      h('span', { style: { fontSize: 11.5 } }, '点右上「刷新」重试；一直 404 的话到插件管理里把这个插件关掉再打开'),
                    )
                  : !status
                    ? h('div', { className: 'bili-qr-empty' }, '正在连接宿主…')
                    : status.state === 'success'
                      ? h('div', { className: 'bili-qr-empty' }, loggedIn ? '已登录，无需扫码' : '登录成功')
                      : h('img', {
                          key: qrKey,
                          src: BASE + '/qr.png?t=' + qrKey,
                          alt: 'B 站登录二维码',
                          onError: (e) => {
                            e.currentTarget.style.display = 'none'
                          },
                        }),
              ),
              h(
                'div',
                { className: 'bili-state' },
                h('span', { className: 'bili-dot ' + stateText.cls, style: { display: 'inline-block', marginRight: 7 } }),
                stateText.text,
              ),
              h(
                'p',
                { className: 'bili-hint' },
                statusError
                  ? '宿主半边可能还没注册路由'
                  : status && status.state === 'waiting'
                    ? `有效期还剩 ${Math.max(0, status.expiresInSec | 0)} 秒`
                    : status && status.state === 'success'
                      ? '登录状态已写入本机 cookie'
                      : '二维码约 3 分钟有效',
              ),
            ),
          ),
          // 右列：下载 + 任务 + 配置 + 日志
          h(
            'div',
            { className: 'bili-col' },
            h(
              'section',
              { className: 'bili-card' },
              h('h2', null, '新建下载'),
              h(
                'form',
                { onSubmit: submit },
                h(
                  'div',
                  { className: 'bili-field' },
                  h('label', { htmlFor: 'bili-url' }, '链接 / BV 号'),
                  h('input', {
                    id: 'bili-url',
                    className: 'bili-input',
                    placeholder: 'https://www.bilibili.com/video/BV… 或 BV1…',
                    value: form.url,
                    onChange: (e) => setForm((f) => ({ ...f, url: e.target.value })),
                  }),
                ),
                h(
                  'div',
                  { className: 'bili-inline' },
                  h(
                    'div',
                    { className: 'bili-field' },
                    h('label', { htmlFor: 'bili-quality' }, '清晰度'),
                    h(
                      'select',
                      {
                        id: 'bili-quality',
                        className: 'bili-input',
                        value: form.quality,
                        onChange: (e) => setForm((f) => ({ ...f, quality: e.target.value })),
                      },
                      h('option', { value: 'best' }, '最高（best）'),
                      h('option', { value: '4k' }, '4K'),
                      h('option', { value: '1080p+' }, '1080P+'),
                      h('option', { value: '1080p' }, '1080P'),
                      h('option', { value: '720p' }, '720P'),
                      h('option', { value: '480p' }, '480P'),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'bili-field' },
                    h('label', { htmlFor: 'bili-mode' }, '类型'),
                    h(
                      'select',
                      {
                        id: 'bili-mode',
                        className: 'bili-input',
                        value: form.mode,
                        onChange: (e) => setForm((f) => ({ ...f, mode: e.target.value })),
                      },
                      h('option', { value: 'video' }, '视频'),
                      h('option', { value: 'audio' }, '只要音频（m4a）'),
                      h('option', { value: 'audio-mp3' }, '只要音频（mp3）'),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'bili-row', style: { justifyContent: 'space-between', marginTop: 4 } },
                  h('span', { className: 'bili-muted', style: { fontSize: 12 } },
                    form.mode === 'video' ? '4K/HDR 需要登录；1080P 起需要 ffmpeg' : '音频不需要 ffmpeg'),
                  h('button', { className: 'bili-btn primary', type: 'submit', disabled: busy === 'download' || !form.url.trim() },
                    busy === 'download' ? '提交中…' : '开始下载'),
                ),
              ),
            ),
            h(
              'section',
              { className: 'bili-card' },
              h('h2', null, '任务', running.length ? h('span', { className: 'bili-muted', style: { fontWeight: 400 } }, `${running.length} 个进行中`) : null),
              tasks.length === 0
                ? h('div', { className: 'bili-empty' }, '还没有任务。在上面粘一个链接就能开始。')
                : tasks.slice(0, 8).map((task) => h(TaskRow, { key: task.id, task, onCopy: copy })),
            ),
            h(
              'section',
              { className: 'bili-card' },
              h('h2', null, '配置'),
              h(
                'dl',
                { className: 'bili-kv' },
                h('dt', null, '输出目录'),
                h('dd', null,
                  h('span', { className: 'bili-mono' }, (status && status.outputDir) || '…'),
                  h('button', {
                    className: 'bili-btn',
                    type: 'button',
                    style: { marginLeft: 8, padding: '2px 8px', fontSize: 11 },
                    onClick: () => status && copy(status.outputDir || ''),
                  }, '复制'),
                ),
                h('dt', null, '配置文件'),
                h('dd', { className: 'bili-mono' }, '%DSH_HOME%\\bili-downloader\\config.json'),
                h('dt', null, 'cookie'),
                h('dd', { className: 'bili-mono' }, '%DSH_HOME%\\bili-downloader\\cookies.json'),
              ),
            ),
            h(
              'section',
              { className: 'bili-card' },
              h(
                'h2',
                null,
                '最近日志',
                h('button', { className: 'bili-btn', type: 'button', style: { padding: '2px 8px', fontSize: 11 }, onClick: loadLogs }, '刷新'),
              ),
              logs.length === 0
                ? h('div', { className: 'bili-empty' }, '（空）')
                : h('ul', { className: 'bili-log' }, logs.slice().reverse().map((line, i) => h('li', { key: i }, line))),
            ),
          ),
        ),
      )
    }

    function TaskRow({ task, onCopy }) {
      const stateLabel = {
        queued: '排队中',
        downloading: '下载中',
        merging: '合流中',
        done: '完成',
        failed: '失败',
      }[task.state] || task.state
      const percent = task.state === 'done' ? 100 : Math.max(0, Math.min(100, task.percent || 0))
      const title = task.title || task.url
      return h(
        'div',
        { className: 'bili-task' },
        h(
          'div',
          { className: 'bili-task-head' },
          h('span', { className: 'bili-task-title', title }, title),
          h('span', { className: 'bili-task-meta' }, `${stateLabel}${task.mode !== 'video' ? ' · 音频' : ''}`),
        ),
        ['downloading', 'merging', 'queued'].includes(task.state)
          ? h('div', { className: 'bili-bar' }, h('i', { style: { width: `${percent}%` } }))
          : null,
        task.state === 'failed'
          ? h('div', { className: 'bili-err' }, task.error)
          : h(
              'div',
              { className: 'bili-task-foot' },
              h('span', null,
                task.state === 'done'
                  ? `${mb(task.bytes)}MB`
                  : task.total
                    ? `${mb(task.bytes)} / ${mb(task.total)}MB`
                    : task.bytes
                      ? `${mb(task.bytes)}MB`
                      : '',
                task.state === 'downloading' && task.speed ? ` · ${speedText(task.speed)}` : '',
              ),
              task.state === 'done' && task.path
                ? h('button', {
                    className: 'bili-btn',
                    type: 'button',
                    style: { padding: '2px 8px', fontSize: 11 },
                    onClick: () => onCopy(task.path),
                  }, '复制路径')
                : h('span', null, task.stage || ''),
            ),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const offIcon = slots.inject('sidebar.panellist', () =>
        slots.register(
          { name: 'sidebar.panellist', id: 'bili-downloader', order: 20, label: () => 'B 站下载器' },
          BiliIcon,
        ),
      )
      const offPanel = slots.inject('main', () =>
        slots.register({ name: 'main', key: 'bili-downloader' }, Panel),
      )
      // slots.inject 已把注册挂在调用方 fiber 上；这里再兜一层，方便手动卸载
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          try {
            offIcon?.()
            offPanel?.()
          } catch {
            /* ignore */
          }
        })
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
