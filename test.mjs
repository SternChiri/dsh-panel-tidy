// 离线验证：桩 DOM + 极简 React，跑 apply()、DOM 上色和菜单行渲染。
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply, createRouteHandler, createStateStore, parseState, stateFile } from './index.js'

const failures = []
const checks = []
function check(name, ok, extra) {
  checks.push({ name, ok })
  if (!ok) failures.push(name + (extra ? ' -> ' + extra : ''))
}

// ---------------------------------------------------------------- 元素桩
function matches(el, sel) {
  if (!el || el.nodeType !== 1) return false
  let m = /^button\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel)
  if (m) {
    if (el.tagName !== 'BUTTON') return false
    const v = el.getAttribute(m[1])
    return m[2] === undefined ? v !== null : v === m[2]
  }
  m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel)
  if (m) {
    const v = el.getAttribute(m[1])
    return m[2] === undefined ? v !== null : v === m[2]
  }
  if (sel.charAt(0) === '.') return el.classList.contains(sel.slice(1))
  if (/^[a-zA-Z]+$/.test(sel)) return el.tagName === sel.toUpperCase()
  return false
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.nodeType = 1
    this.children = []
    this.parentNode = null
    this.style = {}
    this.attributes = {}
    this.isConnected = true
    const set = new Set()
    this.classList = {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      contains: (c) => set.has(c)
    }
  }
  setAttribute(k, v) { this.attributes[k] = String(v) }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null }
  hasAttribute(k) { return k in this.attributes }
  removeAttribute(k) { delete this.attributes[k] }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this) }
  addEventListener() {}
  removeEventListener() {}
  click() {}
  getBoundingClientRect() { return this.rect || { top: 0, left: 0, width: 10, height: 20 } }
  closest(sel) {
    let node = this
    while (node !== null) {
      if (matches(node, sel)) return node
      node = node.parentNode
    }
    return null
  }
  matches(sel) { return matches(this, sel) }
  querySelector(sel) {
    for (const child of this.children) {
      if (child.nodeType !== 1) continue
      if (matches(child, sel)) return child
      const deep = child.querySelector(sel)
      if (deep !== null) return deep
    }
    return null
  }
  querySelectorAll(sel) {
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child.nodeType !== 1) continue
        if (matches(child, sel)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
  contains(node) {
    let cur = node
    while (cur !== null) {
      if (cur === this) return true
      cur = cur.parentNode
    }
    return false
  }
}

const html = new El('html')
const head = html.appendChild(new El('head'))
const body = html.appendChild(new El('body'))
const docListeners = new Map()
let elementFromPointImpl = () => null
// 浏览器桩：cookie 用一条字符串模拟（只按名字覆盖，不区分端口，跟真实行为一致）
let cookieJar = ''
function applyCookieLine(line) {
  const semi = line.indexOf(';')
  const pair = (semi < 0 ? line : line.slice(0, semi)).trim()
  if (pair === '') return
  const at = pair.indexOf('=')
  if (at < 0) return
  const name = pair.slice(0, at).trim()
  const value = pair.slice(at + 1).trim()
  const keep = cookieJar
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part.slice(0, part.indexOf('=')).trim() !== name)
  if (/max-age=0/i.test(line)) {
    cookieJar = keep.join('; ')
    return
  }
  keep.push(name + '=' + value)
  cookieJar = keep.join('; ')
}
globalThis.document = {
  documentElement: html,
  body,
  head,
  createElement: (tag) => new El(tag),
  querySelectorAll: (sel) => html.querySelectorAll(sel),
  elementFromPoint: (x, y) => elementFromPointImpl(x, y),
  get cookie() {
    return cookieJar
  },
  set cookie(value) {
    applyCookieLine(String(value))
  },
  addEventListener(type, fn) {
    docListeners.set(type, fn)
  },
  removeEventListener(type) {
    docListeners.delete(type)
  }
}
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
const storage = new Map()
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k)
}
// 宿主状态路由的桩：hostState 是「服务端那份」，hostRequests 记录请求
let hostState = null
let hostDown = false
let hostRequests = []
globalThis.fetch = (url, init) => {
  const method = (init && init.method) || 'GET'
  hostRequests.push({ url, method, body: init ? init.body : undefined })
  // 网络层失败（路由不存在 / 连接被拒），而不是一个 404 响应
  if (hostDown) return Promise.reject(new Error('host unreachable'))
  if (method === 'POST') {
    hostState = JSON.parse(String(init.body))
    return Promise.resolve({ ok: true, status: 204, text: () => Promise.resolve('') })
  }
  return Promise.resolve({
    ok: hostState !== null,
    status: hostState === null ? 204 : 200,
    text: () => Promise.resolve(hostState === null ? '' : JSON.stringify(hostState))
  })
}
const STORE_KEY = 'dsh.panel-tidy.v1'
/** 清空 cookie 与同端口备份，可选地种一份旧格式（localStorage）数据。 */
function resetStore(legacy) {
  storage.clear()
  cookieJar = ''
  hostState = null
  hostDown = false
  hostRequests = []
  if (legacy !== undefined) storage.set(STORE_KEY, JSON.stringify(legacy))
}

// ---------------------------------------------------------------- React 桩
const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}
}
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
function renderNode(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(renderNode).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const { type, props, children } = node
  const given = children && children.length ? children : props && props.children !== undefined ? [props.children] : []
  const kids = given.flat()
  if (type === React.Fragment) return renderNode(kids)
  if (typeof type === 'function') return renderNode(type({ ...(props || {}), children: kids.length === 1 ? kids[0] : kids }))
  const attrs = []
  for (const [key, value] of Object.entries(props || {})) {
    if (key === 'children' || key === 'dangerouslySetInnerHTML' || value === undefined || value === null || value === false) continue
    attrs.push(key + '="' + esc(value) + '"')
  }
  const raw = props && props.dangerouslySetInnerHTML && typeof props.dangerouslySetInnerHTML.__html === 'string' ? props.dangerouslySetInnerHTML.__html : null
  return '<' + type + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + (raw === null ? renderNode(kids) : raw) + '</' + type + '>'
}
// ---------------------------------------------------------------- 插件加载
function loadPlugin() {
  let api = null
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        check('loader id', id === 'dsh-panel-tidy', id)
        api = factory((name) => {
          if (name === 'react') return React
          throw new Error('MODULE_NOT_FOUND ' + name)
        })
      }
    }
  }
  const source = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')
  new Function('window', 'localStorage', source)(globalThis.window, globalThis.localStorage)
  return api
}

const PANELS = [
  { options: { id: 'plugins', order: 0, label: () => '插件' } },
  { options: { id: 'guizang-design', order: 6, label: () => '歸藏设计' } },
  { options: { id: 'schedules', order: 10, label: () => '自动化任务' } },
  { options: { id: 'dsh-mneme', order: 20, label: () => '记忆' } }
]

function buildNav() {
  const nav = new El('nav')
  nav.rect = { top: 0, left: 0, width: 220, height: 400 }
  const row = (label) => {
    const btn = new El('button')
    btn.setAttribute('aria-label', label)
    const glyph = btn.appendChild(new El('svg'))
    glyph.outerHTML = '<svg class="glyph-for-' + label + '"></svg>'
    return nav.appendChild(btn)
  }
  const rows = {
    plugins: row('插件'),
    guizang: row('歸藏设计'),
    schedules: row('自动化任务'),
    mneme: row('记忆')
  }
  const moreWrap = nav.appendChild(new El('span'))
  const moreBtn = new El('button')
  moreBtn.setAttribute('aria-label', '更多')
  moreBtn.setAttribute('aria-haspopup', 'menu')
  moreWrap.appendChild(moreBtn)
  return { nav, rows, moreWrap }
}

function mountCtx(api) {
  let actions = null
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      check('effect 返回清理函数', typeof cleanup === 'function')
      return cleanup
    },
    slots: {
      entriesOfSlot: () => PANELS,
      inject(name, cb) {
        check('注册进 actions 槽', name === 'sidebar.panellist.actions', name)
        cb()
      },
      register(options, component) {
        actions = { options, component }
        return () => {}
      }
    }
  }
  api.apply(ctx)
  return actions
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ================================================================ 场景一：默认全部收纳
{
  html.children = html.children.filter((c) => c.tagName === 'HEAD' || c.tagName === 'BODY')
  body.children = []
  head.children = []
  const api = loadPlugin()
  check('factory 已执行', api !== null)
  check('导出 inject/apply', Array.isArray(api.inject) && typeof api.apply === 'function')
  const actions = mountCtx(api)
  check('菜单组件已注册', actions !== null)
  check('order = -1（排在官方两条之前）', actions !== null && actions.options.order === -1)

  const { nav, rows, moreWrap } = buildNav()
  body.appendChild(nav)
  await sleep(80)

  check('本体 plugins 仍在主列表', rows.plugins.style.display !== 'none', JSON.stringify(rows.plugins.style))
  check('本体 schedules 仍在主列表', rows.schedules.style.display !== 'none', JSON.stringify(rows.schedules.style))
  check('歸藏设计 已被收纳（隐藏）', rows.guizang.style.display === 'none', JSON.stringify(rows.guizang.style))
  check('记忆 已被收纳（隐藏）', rows.mneme.style.display === 'none', JSON.stringify(rows.mneme.style))
  check('主列表顺序按注册 order', [rows.plugins, rows.guizang, rows.schedules, rows.mneme].map((r) => r.style.order).join(',') === '0,1,2,3', [rows.plugins, rows.guizang, rows.schedules, rows.mneme].map((r) => r.style.order).join(','))
  check('「更多」永远排最后', moreWrap.style.order === '9000', String(moreWrap.style.order))
  check('行上不挂原生 draggable', rows.guizang.getAttribute('draggable') === null)
  const css = head.children.length > 0 ? head.children[0].textContent || '' : ''
  check('拖动时光标变抓', /cursor:\s*grabbing/.test(css))
  check('悬停不出现抓手光标', !/cursor:\s*grab\s*[;!}]/.test(css), css)
  check('落点提示用 2px 圆角线', css.includes('.dsh-tidy-drop-before::before') && css.includes('.dsh-tidy-drop-after::after'))
  check('落点提示不用内阴影', !css.includes('inset 0 2px 0'))
  check('拖动抬起用官方圆角 token', css.includes('--dsw-radius-md'))
  check('按住/落位有克制的动效', css.includes('dsh-tidy-arm') && css.includes('dsh-tidy-settle'))
  check('尊重 prefers-reduced-motion', css.includes('prefers-reduced-motion'))

  const markup = renderNode(
    React.createElement(actions.component, {
      entries: PANELS.slice(1).map((p) => ({ id: p.options.id, label: p.options.label(), pinned: true, active: p.options.id === 'dsh-mneme' })),
      onOpen() {},
      onDismiss() {}
    })
  )
  check('菜单渲染出歸藏设计', markup.includes('歸藏设计'))
  check('菜单渲染出记忆', markup.includes('记忆'))
  check('本体 schedules 没被收进菜单', !markup.includes('自动化任务'))
  check('没有分隔线', !markup.includes('dsh-tidy-sep') && !markup.includes('separator'))
  check('两行都在', (markup.match(/data-dsh-tidy-menu-row/g) || []).length === 2, String((markup.match(/data-dsh-tidy-menu-row/g) || []).length))
  check('没有六点手柄', !markup.includes('dsh-tidy-grip'))
  check('每行都带图标', (markup.match(/dsh-tidy-icon/g) || []).length === 2, String((markup.match(/dsh-tidy-icon/g) || []).length))
  check('图标是从主列表行克隆的 svg', markup.includes('glyph-for-歸藏设计'), markup)
  check('当前面板带 aria-current', markup.includes('aria-current="page"'))

  const empty = renderNode(React.createElement(actions.component, { entries: [{ id: 'plugins', label: '插件' }], onOpen() {}, onDismiss() {} }))
  check('没有可收纳项时什么都不渲染', empty === '')

  const saved = JSON.parse(storage.get('dsh.panel-tidy.v1') || '{}')
  check('落盘顺序按注册 order', (saved.order || []).join(',') === 'plugins,guizang-design,schedules,dsh-mneme', (saved.order || []).join(','))
  const fromCookie = JSON.parse(decodeURIComponent((cookieJar.match(/(?:^|; )dsh\.panel-tidy=([^;]*)/) || [])[1] || 'null') || '{}')
  check('状态同时写进 cookie（cookie 不随端口隔离）', (fromCookie.order || []).join(',') === 'plugins,guizang-design,schedules,dsh-mneme', cookieJar)
}

// ================================================================ 场景二：预设「歸藏设计」放出来 + 自定义顺序
{
  body.children = []
  head.children = []
  resetStore({ folded: { 'guizang-design': false, 'dsh-mneme': true }, order: ['schedules', 'guizang-design', 'plugins', 'dsh-mneme'] })
  const api = loadPlugin()
  mountCtx(api)
  const { nav, rows } = buildNav()
  body.appendChild(nav)
  await sleep(80)
  check('显式放出来的面板不隐藏', rows.guizang.style.display !== 'none', JSON.stringify(rows.guizang.style))
  check('仍然收纳的记忆保持隐藏', rows.mneme.style.display === 'none')
  check('自定义顺序生效（schedules 第一）', rows.schedules.style.order === '0', String(rows.schedules.style.order))
  check('自定义顺序生效（plugins 第三）', rows.plugins.style.order === '2', String(rows.plugins.style.order))
}

// ================================================================ 场景三：新插件自动收纳
{
  body.children = []
  head.children = []
  resetStore()
  const api = loadPlugin()
  mountCtx(api)
  const { nav, rows } = buildNav()
  const extra = new El('button')
  extra.setAttribute('aria-label', '新插件')
  nav.appendChild(extra)
  PANELS.push({ options: { id: 'brand-new', order: 99, label: () => '新插件' } })
  body.appendChild(nav)
  await sleep(80)
  check('后来注册的插件默认被收纳', extra.style.display === 'none', JSON.stringify(extra.style))
  PANELS.pop()
}

// ================================================================ 场景四：长按 500ms 才进入拖动
{
  body.children = []
  head.children = []
  resetStore({ folded: { 'guizang-design': false, 'dsh-mneme': false }, order: [] })
  const api = loadPlugin()
  mountCtx(api)
  const { nav, rows, moreWrap } = buildNav()
  body.appendChild(nav)
  await sleep(80)
  check('预设放出的行可见', rows.guizang.style.display !== 'none')

  const down = docListeners.get('pointerdown')
  const move = docListeners.get('pointermove')
  const up = docListeners.get('pointerup')
  check('指针事件已挂上', [down, move, up].every((fn) => typeof fn === 'function'))
  check('不注册原生拖放事件', !docListeners.has('dragstart') && !docListeners.has('drop'))

  const ev = (target, x, y) => ({ target, clientX: x, clientY: y })
  check('空闲行上没有 draggable（悬停不会变抓手）', !rows.guizang.hasAttribute('draggable'))

  // 短按：当普通点击处理
  down(ev(rows.guizang, 10, 10))
  check('按住期间有 pending 提示', rows.guizang.classList.contains('dsh-tidy-pending'))
  await sleep(150)
  check('短按不进入拖动', !body.classList.contains('dsh-tidy-drag-active'))
  up(ev(rows.guizang, 10, 10))
  check('短按后行上没有拖动位移', !rows.guizang.style.transform)
  check('短按后 pending 提示已收掉', !rows.guizang.classList.contains('dsh-tidy-pending'))

  // 按下就移动：视为误触，取消
  down(ev(rows.guizang, 10, 10))
  move(ev(rows.guizang, 40, 10))
  await sleep(600)
  check('按下即移动不进入拖动', !body.classList.contains('dsh-tidy-drag-active'))
  check('误触取消后 pending 提示已收掉', !rows.guizang.classList.contains('dsh-tidy-pending'))
  up(ev(rows.guizang, 40, 10))

  // 按满 500ms：进入拖动，行跟着指针走
  down(ev(rows.guizang, 10, 10))
  await sleep(560)
  check('长按 500ms 后进入拖动', body.classList.contains('dsh-tidy-drag-active'))
  check('拖动行加了 dragging 类', rows.guizang.classList.contains('dsh-tidy-dragging'))
  check('进入拖动后 pending 提示已换成抬起态', !rows.guizang.classList.contains('dsh-tidy-pending'))
  check('拖动行自己跟手（位移由 transform 表示）', rows.guizang.style.transform === 'translate(0px, 0px)')
  check('拖动行不吞指针事件（便于 elementFromPoint 落到下面一行）', rows.guizang.style.pointerEvents === 'none')

  move(ev(rows.guizang, 10, 26))
  check('位移随指针变化', rows.guizang.style.transform === 'translate(0px, 16px)', String(rows.guizang.style.transform))

  // 落到「记忆」那一行：调序，且不留落点高亮
  elementFromPointImpl = () => rows.mneme
  move(ev(rows.mneme, 10, 60))
  check('悬停目标有落点标记', rows.mneme.classList.contains('dsh-tidy-drop-after') || rows.mneme.classList.contains('dsh-tidy-drop-before'))
  up(ev(rows.mneme, 10, 60))
  await sleep(80)
  check('拖完清掉光标态', !body.classList.contains('dsh-tidy-drag-active'))
  check('拖完源行不再半透明', !rows.guizang.classList.contains('dsh-tidy-dragging'))
  check('拖完清掉位移', !rows.guizang.style.transform && !rows.guizang.style.pointerEvents)
  check('落位后有一次 settle 提示', rows.guizang.classList.contains('dsh-tidy-settled'))
  check(
    '拖完不留落点高亮（没有黑边）',
    !rows.mneme.classList.contains('dsh-tidy-drop-after') && !rows.mneme.classList.contains('dsh-tidy-drop-before'),
    'after=' + rows.mneme.classList.contains('dsh-tidy-drop-after') + ' before=' + rows.mneme.classList.contains('dsh-tidy-drop-before')
  )
  const saved = JSON.parse(storage.get('dsh.panel-tidy.v1') || '{}')
  check('顺序已落盘', Array.isArray(saved.order) && saved.order.includes('dsh-mneme') && saved.order.includes('guizang-design'))

  // 再拖到「更多」上：收纳
  const moreButton = moreWrap.querySelector('button')
  elementFromPointImpl = () => moreButton
  down(ev(rows.mneme, 10, 60))
  await sleep(560)
  move(ev(rows.mneme, 10, 100))
  up(ev(rows.mneme, 10, 100))
  await sleep(80)
  check('拖到「更多」后被收纳', rows.mneme.style.display === 'none', JSON.stringify(rows.mneme.style))
  check('收纳后不留落点高亮', !rows.mneme.classList.contains('dsh-tidy-drop-more'))
}

// ================================================================ 场景五：拖到第一行上方（指针落在 nav 空白处）也能排到最上面
{
  body.children = []
  head.children = []
  resetStore({ folded: { 'guizang-design': false, 'dsh-mneme': false }, order: [] })
  const api = loadPlugin()
  mountCtx(api)
  const { nav, rows } = buildNav()
  body.appendChild(nav)
  await sleep(80)

  const down = docListeners.get('pointerdown')
  const move = docListeners.get('pointermove')
  const up = docListeners.get('pointerup')
  const ev = (target, x, y) => ({ target, clientX: x, clientY: y })

  // 指针落在 nav 本身（第一行上方的空白），elementFromPoint 给不到任何行
  elementFromPointImpl = () => nav
  down(ev(rows.guizang, 10, 40))
  await sleep(560)
  move(ev(rows.guizang, 10, 4))
  up(ev(rows.guizang, 10, 4))
  await sleep(80)
  const saved = JSON.parse(storage.get('dsh.panel-tidy.v1') || '{}')
  check('落在侧栏空白处按最近行结算，能排到最上面', (saved.order || [])[0] === 'guizang-design', JSON.stringify(saved.order))
}

// ================================================================ 场景六：重启换了端口（同端口备份为空）配置依然在
{
  body.children = []
  head.children = []
  resetStore({ folded: { 'guizang-design': false }, order: ['dsh-mneme', 'plugins', 'guizang-design', 'schedules'] })
  const first = loadPlugin()
  mountCtx(first)
  const one = buildNav()
  body.appendChild(one.nav)
  await sleep(80)
  check('旧备份已迁到 cookie', /(?:^|; )dsh\.panel-tidy=/.test(cookieJar), cookieJar)

  // 换端口：localStorage 是另一份空库，只剩下 cookie
  storage.clear()
  body.children = []
  head.children = []
  const second = loadPlugin()
  mountCtx(second)
  const two = buildNav()
  body.appendChild(two.nav)
  await sleep(80)
  check('换端口后顺序仍在（记忆排在第一位）', two.rows.mneme.style.order === '0', String(two.rows.mneme.style.order))
  check('换端口后收纳状态仍在（歸藏设计已放出）', two.rows.guizang.style.display !== 'none', JSON.stringify(two.rows.guizang.style))
  check('换端口后依然从头读 cookie（备份没写回也不算失效）', two.rows.plugins.style.order === '1', String(two.rows.plugins.style.order))
}

// ================================================================ 宿主半边：状态文件与路由
const sandbox = mkdtempSync(join(tmpdir(), 'panel-tidy-'))
check('状态文件在 DSH 主目录下', /panel-tidy[\\/]state\.json$/.test(stateFile()), stateFile())
check('非法 JSON 被拒', parseState('{') === null)
check('数组被拒', parseState('[]') === null)
check('数字被拒', parseState(42) === null)
{
  const parsed = parseState('{"folded":{"a":true,"b":"x"},"order":["a",1],"savedAt":"x"}')
  check('归一化只留合法字段', parsed.folded.a === true && parsed.folded.b === undefined, JSON.stringify(parsed))
  check('顺序只留字符串', parsed.order.length === 1 && parsed.order[0] === 'a', JSON.stringify(parsed.order))
  check('时间戳非法归零', parsed.savedAt === 0)
}
{
  const store = createStateStore(join(sandbox, 'nested', 'state.json'))
  check('文件不存在时读回 null', (await store.read()) === null)
  await store.write({ folded: { 'guizang-design': false }, order: ['plugins'], savedAt: 7 })
  const back = await store.read()
  check('写入后能读回', back.order[0] === 'plugins' && back.folded['guizang-design'] === false, JSON.stringify(back))
  check('写入保留时间戳', back.savedAt === 7)
  let rejected = false
  try {
    await store.write({ folded: 'nope', order: 'nope' })
  } catch {
    rejected = true
  }
  check('坏状态写不进去', rejected)
}
function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(body) {
      this.body = body
    }
  }
}
function fakeReq(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(String(body))])
  req.method = method
  return req
}
{
  const store = createStateStore(join(sandbox, 'route', 'state.json'))
  const handle = createRouteHandler(store)
  let res = fakeRes()
  await handle(fakeReq('GET'), res)
  check('没有状态时回 204', res.status === 204, String(res.status))

  res = fakeRes()
  await handle(fakeReq('POST', '{"folded":{},"order":["dsh-mneme"],"savedAt":5}'), res)
  check('写入成功回 204', res.status === 204, String(res.status))

  res = fakeRes()
  await handle(fakeReq('GET'), res)
  const payload = JSON.parse(String(res.body))
  check('读回刚写的内容', payload.order[0] === 'dsh-mneme' && res.status === 200, String(res.body))
  check('读接口不缓存', String(res.headers['cache-control']) === 'no-store')

  res = fakeRes()
  await handle(fakeReq('POST', 'oops'), res)
  check('坏 body 回 400', res.status === 400, String(res.status))

  res = fakeRes()
  await handle(fakeReq('DELETE'), res)
  check('其他方法回 405', res.status === 405, String(res.status))
}

// ================================================================ 场景七：浏览器存储被清空，从宿主文件恢复
{
  body.children = []
  head.children = []
  resetStore()
  hostState = {
    folded: { 'guizang-design': true },
    order: ['dsh-mneme', 'plugins', 'guizang-design', 'schedules'],
    savedAt: 1000
  }
  const api = loadPlugin()
  mountCtx(api)
  const nav = buildNav()
  body.appendChild(nav.nav)
  await sleep(80)
  check('存储全空时从宿主恢复顺序', nav.rows.mneme.style.order === '0', String(nav.rows.mneme.style.order))
  check('存储全空时从宿主恢复收纳', nav.rows.guizang.style.display === 'none', JSON.stringify(nav.rows.guizang.style))
  check('恢复后写回 cookie', /(?:^|; )dsh\.panel-tidy=/.test(cookieJar), cookieJar)
}

// ================================================================ 场景八：浏览器这边更新，推给宿主
{
  body.children = []
  head.children = []
  resetStore({ folded: {}, order: ['plugins', 'schedules', 'dsh-mneme', 'guizang-design'], savedAt: 99 })
  hostState = { folded: {}, order: ['dsh-mneme', 'plugins'], savedAt: 50 }
  const api = loadPlugin()
  mountCtx(api)
  const nav = buildNav()
  body.appendChild(nav.nav)
  await sleep(80)
  const writes = hostRequests.filter((r) => r.method === 'POST')
  check('本地更新时向宿主写一次', writes.length >= 1, JSON.stringify(hostRequests.map((r) => r.method)))
  const pushed = JSON.parse(String(writes[writes.length - 1].body))
  check('推的是本地顺序', pushed.order[0] === 'plugins', JSON.stringify(pushed.order))
  check('推的是本地时间戳', pushed.savedAt === 99, String(pushed.savedAt))
}

// ================================================================ 场景九：宿主路由不存在时静默退回浏览器存储
{
  body.children = []
  head.children = []
  resetStore({ folded: { 'guizang-design': false }, order: ['dsh-mneme', 'plugins', 'guizang-design', 'schedules'], savedAt: 5 })
  hostDown = true
  const api = loadPlugin()
  mountCtx(api)
  const nav = buildNav()
  body.appendChild(nav.nav)
  // 立即回写路径是同步触发，这里趁防抖（250ms）还没到就看一眼
  await sleep(20)
  check('宿主不可用时不写宿主', hostRequests.filter((r) => r.method === 'POST').length === 0)
  await sleep(60)
  check('宿主不可用仍按浏览器存储排布', nav.rows.mneme.style.order === '0', String(nav.rows.mneme.style.order))
  check('宿主不可用仍按浏览器存储收纳', nav.rows.guizang.style.display !== 'none', JSON.stringify(nav.rows.guizang.style))
}

// ================================================================ 场景十：老 cookie 没有时间戳，首次加载就把宿主那份建起来
{
  body.children = []
  head.children = []
  resetStore({ folded: { 'guizang-design': false }, order: ['dsh-mneme', 'plugins', 'guizang-design', 'schedules'] })
  const api = loadPlugin()
  mountCtx(api)
  const nav = buildNav()
  body.appendChild(nav.nav)
  await sleep(80)
  const writes = hostRequests.filter((r) => r.method === 'POST')
  check('老 cookie 首次加载也写宿主', writes.length >= 1, JSON.stringify(hostRequests.map((r) => r.method)))
  const pushed = writes.length > 0 ? JSON.parse(String(writes[writes.length - 1].body)) : {}
  check('补上了时间戳', typeof pushed.savedAt === 'number' && pushed.savedAt > 0, String(pushed.savedAt))
  check('写的是当前顺序', pushed.order && pushed.order[0] === 'dsh-mneme', JSON.stringify(pushed.order))
}

// ================================================================ 宿主半边装配：换宿主、老宿主、没宿主
{
  const routes = []
  let effectLabel = ''
  apply({
    inject(deps, callback) {
      check('webServer 声明成可选依赖', Array.isArray(deps) && deps.includes('webServer'), JSON.stringify(deps))
      callback({
        webServer: {
          register(route) {
            routes.push(route)
            return async () => {}
          }
        },
        effect(fn, label) {
          effectLabel = label
          fn()
        }
      })
    }
  })
  check('注册了一条状态路由', routes.length === 1, String(routes.length))
  check('路由路径与浏览器半边一致', routes[0] && routes[0].path === '/dsh-panel-tidy/state', String(routes[0] && routes[0].path))
  check('路由按精确路径匹配', routes[0] && routes[0].kind === 'exact', String(routes[0] && routes[0].kind))
  check('路由挂在可清理的 effect 上', /panel-tidy/.test(effectLabel), effectLabel)
}
{
  let calls = 0
  apply({ inject() { calls += 1 } })
  check('宿主一直不给 webServer 时不报错', calls === 1)
}
{
  const routes = []
  apply({
    reflect: {
      get: (name) =>
        name === 'webServer'
          ? {
              register(route) {
                routes.push(route)
                return async () => {}
              }
            }
          : undefined
    },
    effect(fn) {
      fn()
    }
  })
  check('没有 inject 的老宿主也能注册', routes.length === 1, String(routes.length))
}
{
  let threw = false
  try {
    apply({})
  } catch {
    threw = true
  }
  check('ctx 什么都不提供时不抛错', threw === false)
}
{
  const previous = process.env.DSH_HOME
  const fakeHome = mkdtempSync(join(tmpdir(), 'panel-tidy-home-'))
  process.env.DSH_HOME = fakeHome
  const file = stateFile()
  check('状态文件位置跟随 DSH_HOME', file.startsWith(fakeHome), file)
  check('状态文件名固定', /panel-tidy[\\/]state\.json$/.test(file), file)
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
}

for (const c of checks) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name)
console.log('\n' + (failures.length === 0 ? `全部 ${checks.length} 项通过` : `失败 ${failures.length} 项:\n` + failures.join('\n')))
process.exitCode = failures.length === 0 ? 0 : 1
