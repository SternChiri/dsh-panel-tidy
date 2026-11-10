// 面板整理 · DeepSeek Harness 插件：浏览器半边
//
// 做三件事：
//   1. 每条侧栏面板都能长按拖动：主列表内自由排序；拖到「更多」上＝收进二级菜单；
//      菜单里的条目也能排序，拖回左侧栏＝重新放出来。
//   2. 「非本体」的面板（除 plugins / schedules 之外的一切）默认从主列表 CSS 隐藏，
//      等价于收进「更多」；新装的插件自动生效（未知 id 默认收纳）。
//   3. 在「更多」菜单的最上方（order: -1，排在「浏览更多插件」之前）画这些被收纳的入口。
//
// 为什么用 CSS 隐藏而不是官方 pin：官方 pin 状态在 sidebar 组件的内存 store 里，
// 而 sidebar.panellist.actions 的组件只在「更多」菜单展开时才挂载，加载时拿不到 setPinned。
// 直接隐藏 DOM 是唯一能在首屏就生效的路径，也不动官方 pin 状态。
window.__ModuleLoader__.load({
  id: 'dsh-panel-tidy',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** 本体注册、永远留在主列表的入口。 */
    const CORE_IDS = ['plugins', 'schedules']
    // 状态放 cookie，不放 localStorage：cookie 只按域名隔离，端口变了照样读得到；
    // localStorage 按 origin（含端口）隔离，重启后换端口就全空。localStorage 只留作同端口备份。
    const COOKIE_NAME = 'dsh.panel-tidy'
    const COOKIE_MAX_AGE = 60 * 60 * 24 * 365
    const STORAGE_KEY = 'dsh.panel-tidy.v1'
    // 宿主半边注册的状态路由：浏览器存储被清掉时，布局还能从这里读回来。
    const STATE_URL = '/dsh-panel-tidy/state'
    const HOST_PUSH_DELAY = 250
    const SLOT_PANELS = 'sidebar.panellist'
    const SLOT_ACTIONS = 'sidebar.panellist.actions'
    const ORDER_TAIL = 9000

    // ---------------------------------------------------------------- 状态

    /** 把存下来的字符串解析成状态；解析不了返回 null。 */
    function normalize(raw) {
      if (typeof raw !== 'string' || raw === '') return null
      try {
        const parsed = JSON.parse(raw)
        const folded = parsed && typeof parsed.folded === 'object' && parsed.folded !== null ? parsed.folded : {}
        const order = Array.isArray(parsed && parsed.order) ? parsed.order.filter((x) => typeof x === 'string') : []
        const savedAt = typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0
        return { folded, order, savedAt }
      } catch {
        return null
      }
    }

    function readCookie() {
      try {
        for (const part of document.cookie.split(';')) {
          const at = part.indexOf('=')
          if (at < 0) continue
          if (part.slice(0, at).trim() !== COOKIE_NAME) continue
          return decodeURIComponent(part.slice(at + 1).trim())
        }
      } catch (error) {
        console.warn('[panel-tidy] 读取 cookie 失败', error)
      }
      return null
    }

    function writeCookie(raw) {
      try {
        document.cookie =
          COOKIE_NAME + '=' + encodeURIComponent(raw) + '; path=/; max-age=' + COOKIE_MAX_AGE + '; SameSite=Lax'
      } catch (error) {
        console.warn('[panel-tidy] 写入 cookie 失败', error)
      }
    }

    function loadState() {
      const fromCookie = normalize(readCookie())
      if (fromCookie !== null) return fromCookie
      // 没有 cookie：读同端口下的旧数据，读到就顺手迁到 cookie。
      try {
        const migrated = normalize(localStorage.getItem(STORAGE_KEY))
        if (migrated !== null) {
          writeCookie(JSON.stringify(migrated))
          return migrated
        }
      } catch (error) {
        console.warn('[panel-tidy] 读取本地备份失败', error)
      }
      return { folded: {}, order: [], savedAt: 0 }
    }

    let state = loadState()
    const listeners = new Set()
    let ctxRef = null
    let alive = true
    // 主机状态读回来之前不往宿主写，免得用一份过期的浏览器状态覆盖它。
    let hostReady = false
    let pushTimer = null
    const canFetch = typeof fetch === 'function'

    function writeLocal() {
      const raw = JSON.stringify(state)
      writeCookie(raw)
      try {
        localStorage.setItem(STORAGE_KEY, raw)
      } catch (error) {
        console.warn('[panel-tidy] 保存本地备份失败', error)
      }
    }

    function pushToHost() {
      pushTimer = null
      if (!canFetch) return
      try {
        void fetch(STATE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify(state)
        }).catch(() => {})
      } catch (error) {
        console.warn('[panel-tidy] 写入宿主状态失败', error)
      }
    }

    function schedulePush() {
      if (!hostReady || !canFetch) return
      if (pushTimer !== null) clearTimeout(pushTimer)
      pushTimer = setTimeout(pushToHost, HOST_PUSH_DELAY)
    }

    function saveState() {
      state.savedAt = Date.now()
      writeLocal()
      schedulePush()
    }

    /** 启动时对齐三处存储：宿主文件最新就采纳它，否则把浏览器这份推上去。 */
    async function syncFromHost() {
      if (!canFetch) return
      let remote = null
      let reachable = false
      try {
        const response = await fetch(STATE_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
        reachable = true
        if (response.ok) remote = normalize(await response.text())
      } catch (error) {
        // 宿主没注册路由（headless）或网络层失败：浏览器存储自己扛。
      }
      if (!alive) return
      const localAt = typeof state.savedAt === 'number' ? state.savedAt : 0
      if (remote !== null && remote.savedAt > localAt) {
        state = remote
        writeLocal()
        hostReady = true
        emit()
        return
      }
      hostReady = true
      // 读不到宿主就别回写：一次网络抖动不该用旧状态盖掉宿主那份。
      if (!reachable || state.order.length === 0) return
      // 老版本留下的 cookie 没有时间戳：补一个，顺手把宿主那份建起来。
      if (localAt === 0) state.savedAt = Date.now()
      writeLocal()
      pushToHost()
    }

    function emit() {
      for (const fn of [...listeners]) {
        try {
          fn()
        } catch (error) {
          console.warn('[panel-tidy] 订阅回调失败', error)
        }
      }
      schedulePaint()
    }

    function isCore(id) {
      return CORE_IDS.includes(id)
    }

    /** 未知 id 默认收纳；只有显式存过 false 才留在主列表。 */
    function isFolded(id) {
      if (isCore(id)) return false
      return state.folded[id] !== false
    }

    function setFolded(id, folded) {
      if (isCore(id)) return false
      const next = folded === true
      if (state.folded[id] === next) return false
      state.folded[id] = next
      saveState()
      return true
    }

    /** 把当前注册的 id 补进顺序表，并清掉已经消失的 id。 */
    function syncOrder(ids) {
      const present = new Set(ids)
      const next = state.order.filter((id) => present.has(id))
      const known = new Set(next)
      for (const id of ids) {
        if (!known.has(id)) {
          next.push(id)
          known.add(id)
        }
      }
      const changed = next.length !== state.order.length || next.some((id, i) => id !== state.order[i])
      if (changed) {
        state.order = next
        saveState()
      }
    }

    function orderMap() {
      const map = new Map()
      state.order.forEach((id, index) => map.set(id, index))
      return map
    }

    function moveId(id, targetId, after) {
      if (id === targetId) return false
      const list = state.order.filter((x) => x !== id)
      const at = list.indexOf(targetId)
      if (at < 0) list.push(id)
      else list.splice(after ? at + 1 : at, 0, id)
      state.order = list
      saveState()
      flashSettled(id)
      return true
    }

    /** 落位后闪一下，让人确认「这一条确实挪过来了」。纯视觉，失败不影响功能。 */
    function flashSettled(id) {
      for (const nav of navCache) {
        for (const child of nav.children) {
          if (child.getAttribute('data-dsh-tidy-id') !== id) continue
          child.classList.add('dsh-tidy-settled')
          setTimeout(() => child.classList.remove('dsh-tidy-settled'), 360)
          return
        }
      }
    }

    // ---------------------------------------------------------------- 面板表

    function readLabel(label) {
      if (typeof label === 'string') return label
      if (typeof label === 'function') {
        try {
          const value = label()
          return typeof value === 'string' ? value : null
        } catch {
          return null
        }
      }
      return null
    }

    /** 复刻 sidebar 里 syncPanels 的排序：priority 升序，再 order 升序。 */
    function panelInfos(ctx) {
      const seen = new Set()
      const infos = []
      for (const registration of ctx.slots.entriesOfSlot(SLOT_PANELS)) {
        const options = (registration && registration.options) || {}
        const id = options.id
        if (typeof id !== 'string' || seen.has(id)) continue
        seen.add(id)
        infos.push({
          id,
          label: readLabel(options.label),
          priority: options.priority ?? 0,
          order: options.order ?? 0
        })
      }
      infos.sort((a, b) => a.priority - b.priority || a.order - b.order)
      return infos
    }

    // ---------------------------------------------------------------- DOM 上色

    let navCache = []
    let paintQueued = false

    function findNavs(labels) {
      const navs = []
      const buttons = document.querySelectorAll('button[aria-label]')
      for (const button of buttons) {
        if (!labels.has(button.getAttribute('aria-label'))) continue
        const nav = button.closest('nav')
        if (nav !== null && !navs.includes(nav)) navs.push(nav)
      }
      return navs
    }

    function paint() {
      const ctx = ctxRef
      if (ctx === null) return
      const infos = panelInfos(ctx)
      if (infos.length === 0) return
      syncOrder(infos.map((info) => info.id))

      const labels = new Set(infos.filter((info) => info.label !== null).map((info) => info.label))
      if (navCache.length === 0 || navCache.some((nav) => !nav.isConnected)) navCache = findNavs(labels)
      if (navCache.length === 0) return

      const byLabel = new Map()
      for (const info of infos) if (info.label !== null) byLabel.set(info.label, info.id)
      const index = orderMap()

      for (const nav of navCache) {
        for (const child of nav.children) {
          const button = child.tagName === 'BUTTON' ? child : child.querySelector('button')
          if (button === null) continue
          if (button.getAttribute('aria-haspopup') === 'menu') {
            child.style.order = String(ORDER_TAIL)
            continue
          }
          const id = byLabel.get(button.getAttribute('aria-label'))
          if (id === undefined) continue
          child.setAttribute('data-dsh-tidy-row', '')
          child.setAttribute('data-dsh-tidy-id', id)
          // 清掉上一轮拖动可能留下的落点高亮（不然会留一条黑边）。
          child.classList.remove(
            'dsh-tidy-drop-before',
            'dsh-tidy-drop-after',
            'dsh-tidy-drop-more',
            'dsh-tidy-pending'
          )
          // 兜底：行上还挂着 draggable 就摘掉——挂着它，浏览器会把光标变成抓手。
          if (child.hasAttribute('draggable')) child.removeAttribute('draggable')
          // 拖动中被打断时也别把位移留在这行上。
          if (armed !== null && armed.el === child) continue
          if (child.style.transform) {
            child.style.transform = ''
            child.style.pointerEvents = ''
            child.style.zIndex = ''
          }
          child.style.display = isFolded(id) ? 'none' : ''
          child.style.order = String(index.has(id) ? index.get(id) : ORDER_TAIL - 1)
        }
      }
    }

    function schedulePaint() {
      if (paintQueued) return
      paintQueued = true
      const run = () => {
        paintQueued = false
        try {
          paint()
        } catch (error) {
          console.warn('[panel-tidy] 刷新侧栏失败', error)
        }
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
      else setTimeout(run, 16)
    }

    // ---------------------------------------------------------------- 拖动
    //
    // 纯指针事件，不使用原生 draggable：元素一旦可拖，浏览器就把光标变成抓手，
    // 也没有「先按住再开始拖」的时机。按下开始计时，HOLD_MS 内移动超过
    // MOVE_CANCEL 视为普通点击/误触；按满才进入拖动态，被拖的那一行自己跟着指针走。

    const HOLD_MS = 500
    const MOVE_CANCEL = 8

    let pending = null         // 按着、还没按满的行
    let armed = null           // 按满了、随时可能被拖起来的行
    let dragging = null        // 正在拖的行
    let suppressClick = false
    let lastPointer = { x: 0, y: 0 }

    function rowUnder(target) {
      if (!target || typeof target.closest !== 'function') return null
      const menuRow = target.closest('[data-dsh-tidy-menu-row]')
      if (menuRow !== null) return { el: menuRow, kind: 'menu', id: menuRow.getAttribute('data-dsh-tidy-id') }
      const mainRow = target.closest('[data-dsh-tidy-row]')
      if (mainRow !== null) return { el: mainRow, kind: 'main', id: mainRow.getAttribute('data-dsh-tidy-id') }
      return null
    }

    /** 左侧栏里指针落在哪：More 那一项，还是某一条面板行。 */
    function navHit(target) {
      if (!target || typeof target.closest !== 'function') return null
      const nav = target.closest('nav')
      if (nav === null || !navCache.includes(nav)) return null
      if (target === nav) return { kind: 'space', el: nav, nav }
      let child = target
      while (child !== null && child.parentNode !== nav) child = child.parentNode
      if (child === null || child.nodeType !== 1) return null
      if (child.querySelector('button[aria-haspopup="menu"]') !== null) return { kind: 'more', el: child, nav }
      if (child.hasAttribute('data-dsh-tidy-row')) return { kind: 'row', el: child, nav }
      return { kind: 'space', el: nav, nav }
    }

    /** 几何兜底：按 Y 找最近的一行。指针落在行间空隙、侧栏空白或第一行上方时用它。 */
    function nearestRowHit(y) {
      let best = null
      let bestDist = Infinity
      for (const nav of navCache) {
        for (const child of nav.children) {
          if (typeof child.hasAttribute !== 'function' || !child.hasAttribute('data-dsh-tidy-row')) continue
          if (child.style.display === 'none') continue
          const rect = child.getBoundingClientRect()
          if (rect.height <= 0) continue
          const mid = rect.top + rect.height / 2
          const dist = Math.abs(y - mid)
          if (dist < bestDist) {
            bestDist = dist
            best = { el: child, after: y > mid }
          }
        }
      }
      return best === null ? null : { kind: 'row', el: best.el, after: best.after, nav: navCache[0] }
    }

    /** 指针是否还落在左侧栏这一列里（允许上下各多出 32px）。 */
    function inSidebarColumn(x, y) {
      for (const nav of navCache) {
        const rect = nav.getBoundingClientRect()
        const width = rect.width !== undefined ? rect.width : rect.right - rect.left
        const height = rect.height !== undefined ? rect.height : rect.bottom - rect.top
        if (!(height > 0)) continue
        if (x >= rect.left - 8 && x <= rect.left + width + 8 && y >= rect.top - 32 && y <= rect.top + height + 32) return true
      }
      return false
    }

    function clearMarks() {
      const marked = document.querySelectorAll('.dsh-tidy-drop-before, .dsh-tidy-drop-after, .dsh-tidy-drop-more')
      for (const el of marked) el.classList.remove('dsh-tidy-drop-before', 'dsh-tidy-drop-after', 'dsh-tidy-drop-more')
    }

    function markAfter(el, y) {
      const rect = el.getBoundingClientRect()
      const after = y > rect.top + rect.height / 2
      el.classList.add(after ? 'dsh-tidy-drop-after' : 'dsh-tidy-drop-before')
      return after
    }

    /** 只算位置、不画标记：提交落点时用，免得把高亮留在行上。 */
    function isAfter(el, y) {
      const rect = el.getBoundingClientRect()
      return y > rect.top + rect.height / 2
    }

    /** 指针下面是什么可投放目标：菜单行优先，其次左侧栏（More / 面板行 / 空白）。 */
    function dropTargetAt(x, y) {
      const el = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null
      if (el === null || el === undefined || typeof el.closest !== 'function') return null
      const menuRow = el.closest('[data-dsh-tidy-menu-row]')
      if (menuRow !== null) return { kind: 'menu', el: menuRow, id: menuRow.getAttribute('data-dsh-tidy-id') }
      if (el.closest('[role="menu"]') !== null) return null
      return navHit(el)
    }

    /** 落点解析：先按指针下的元素判，落在空白/行间/第一行上方时退化成「最近一行」。 */
    function resolveHit(x, y) {
      const hit = dropTargetAt(x, y)
      if (hit !== null && (hit.kind === 'menu' || hit.kind === 'more')) return hit
      if (hit !== null && hit.kind === 'row' && inSidebarColumn(x, y)) return hit
      // 空白 / 行间 / 侧栏上下边缘：按几何找最近一行，避免「拖到最上面却什么都不发生」。
      if (!inSidebarColumn(x, y)) return null
      return nearestRowHit(y)
    }

    function markHit(x, y) {
      clearMarks()
      const hit = resolveHit(x, y)
      if (hit === null) return
      if (hit.kind === 'menu') markAfter(hit.el, y)
      else if (hit.kind === 'more') hit.el.classList.add('dsh-tidy-drop-more')
      else if (hit.kind === 'row') {
        if (hit.after === undefined) markAfter(hit.el, y)
        else hit.el.classList.add(hit.after ? 'dsh-tidy-drop-after' : 'dsh-tidy-drop-before')
      }
    }

    function commitDrop(source, x, y) {
      const hit = resolveHit(x, y)
      clearMarks()
      if (hit === null) return
      if (hit.kind === 'menu') {
        if (source.kind === 'main') setFolded(source.id, true)
        moveId(source.id, hit.id, hit.after !== undefined ? hit.after : isAfter(hit.el, y))
        emit()
        return
      }
      if (hit.kind === 'more') {
        if (setFolded(source.id, true)) emit()
        const button = hit.el.querySelector('button[aria-haspopup="menu"]')
        if (source.kind === 'main' && button !== null) setTimeout(() => button.click(), 0)
        return
      }
      if (hit.kind === 'row') {
        if (source.kind === 'menu') setFolded(source.id, false)
        const id = hit.id !== undefined ? hit.id : hit.el.getAttribute('data-dsh-tidy-id')
        moveId(source.id, id, hit.after !== undefined ? hit.after : isAfter(hit.el, y))
        emit()
        return
      }
      // 左侧栏空白处：归到队尾。
      const last = state.order[state.order.length - 1]
      if (source.kind === 'menu') setFolded(source.id, false)
      if (last !== undefined) moveId(source.id, last, true)
      emit()
    }

    function cancelPending() {
      if (pending === null) return
      clearTimeout(pending.timer)
      if (pending.el !== null && pending.el !== undefined) pending.el.classList.remove('dsh-tidy-pending')
      pending = null
      document.body.classList.remove('dsh-tidy-drag-active')
    }

    /**
     * 按满 HOLD_MS：这一行进入拖动态，直接跟着指针走（不是浮层克隆）。
     * 拖动期间把这一行的 pointer-events 关掉，elementFromPoint 才能落在它下面那一行上。
     */
    function armHold(start) {
      if (pending !== start) return
      pending = null
      start.el.classList.remove('dsh-tidy-pending')
      armed = { el: start.el, kind: start.kind, id: start.id, x: start.x, y: start.y, moved: false }
      document.body.classList.add('dsh-tidy-drag-active')
      start.el.classList.add('dsh-tidy-dragging')
      start.el.style.pointerEvents = 'none'
      start.el.style.transform = 'translate(0px, 0px)'
      start.el.style.zIndex = '20'
      suppressClick = true
    }

    function followPointer(x, y) {
      if (armed === null) return
      armed.el.style.transform = 'translate(0px, ' + (y - armed.y) + 'px)'
    }

    /** 收掉拖动留下的痕迹：半透明、位移、pointer-events、落点高亮。 */
    function resetDrag() {
      if (armed !== null) {
        const el = armed.el
        el.classList.remove('dsh-tidy-dragging')
        el.style.transform = ''
        el.style.pointerEvents = ''
        el.style.zIndex = ''
        armed = null
      }
      document.body.classList.remove('dsh-tidy-drag-active')
      clearMarks()
    }

    function endDrag() {
      const had = armed !== null
      resetDrag()
      if (!had) return
      setTimeout(() => {
        suppressClick = false
      }, 0)
    }

    function onPointerDown(event) {
      if (event.button !== undefined && event.button !== 0) return
      if (armed !== null) endDrag()
      if (pending !== null) cancelPending()
      const hit = rowUnder(event.target)
      if (hit === null) return
      lastPointer = { x: event.clientX, y: event.clientY }
      const start = { el: hit.el, kind: hit.kind, id: hit.id, x: event.clientX, y: event.clientY, timer: null }
      start.timer = setTimeout(() => armHold(start), HOLD_MS)
      pending = start
      hit.el.classList.add('dsh-tidy-pending')
    }

    function onPointerMove(event) {
      lastPointer = { x: event.clientX, y: event.clientY }
      if (pending !== null) {
        // 还没按满就移动：当作普通点击/误触，别把人家的点击吃掉。
        if (Math.abs(event.clientX - pending.x) > MOVE_CANCEL || Math.abs(event.clientY - pending.y) > MOVE_CANCEL) cancelPending()
        return
      }
      if (armed === null) return
      if (Math.abs(event.clientX - armed.x) > MOVE_CANCEL || Math.abs(event.clientY - armed.y) > MOVE_CANCEL) armed.moved = true
      followPointer(event.clientX, event.clientY)
      markHit(event.clientX, event.clientY)
    }

    function onPointerUp(event) {
      if (pending !== null) {
        cancelPending()
        return
      }
      if (armed === null) return
      const source = { el: armed.el, kind: armed.kind, id: armed.id }
      const moved = armed.moved
      endDrag()
      if (moved) commitDrop(source, event.clientX, event.clientY)
    }

    function onPointerCancel() {
      cancelPending()
      endDrag()
    }

    /** 拖动结束后的那一次 click 不该再触发面板切换。 */
    function onClickCapture(event) {
      if (!suppressClick) return
      suppressClick = false
      event.preventDefault()
      event.stopPropagation()
    }

    // ---------------------------------------------------------------- 样式

    const CSS = `
.dsh-tidy-icon { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; flex:none; color:inherit; }
.dsh-tidy-icon svg { width:16px !important; height:16px !important; }

/* 按住等待长按判定：先与官方按下态同色，500ms 内渐染一点品牌色，提示「快进入拖动」 */
.dsh-tidy-pending {
  background-color: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)) !important;
  animation: dsh-tidy-arm 500ms var(--ds-ease-in-out, ease) forwards;
}
@keyframes dsh-tidy-arm {
  from { background-color: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
  to { background-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))); }
}

/* 拖动中：抬起一层。圆角、底色都取官方 token，阴影只在下方很轻地散开 */
.dsh-tidy-dragging {
  position: relative !important;
  border-radius: var(--dsw-radius-md, 8px) !important;
  background-color: var(--dsw-alias-bg-layer-1) !important;
  box-shadow: 0 10px 24px -12px rgba(0, 0, 0, .28), 0 1px 2px rgba(0, 0, 0, .06) !important;
  opacity: .96 !important;
  will-change: transform;
  transition: box-shadow .16s var(--ds-ease-in-out, ease), opacity .16s var(--ds-ease-in-out, ease) !important;
}
.dsh-tidy-drag-active, .dsh-tidy-drag-active * { cursor: grabbing !important; }

/* 落点提示：2px 圆角线，从中间轻轻展开 */
[data-dsh-tidy-row], .dsh-tidy-menu-row { position: relative; }
.dsh-tidy-drop-before::before,
.dsh-tidy-drop-after::after {
  content: '';
  position: absolute;
  left: 6px;
  right: 6px;
  height: 2px;
  border-radius: 2px;
  background: var(--dsw-alias-brand-primary);
  pointer-events: none;
  animation: dsh-tidy-line-in .12s var(--ds-ease-out, ease-out);
}
.dsh-tidy-drop-before::before { top: -1px; }
.dsh-tidy-drop-after::after { bottom: -1px; }
@keyframes dsh-tidy-line-in {
  from { opacity: 0; transform: scaleX(.88); }
  to { opacity: 1; transform: scaleX(1); }
}

/* 拖到「更多」上：一圈品牌色描边 + 极浅底色，表示「收进这里」 */
.dsh-tidy-drop-more {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, transparent) !important;
  background-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent) !important;
}

/* 落位后闪一下 */
.dsh-tidy-settled { animation: dsh-tidy-settle .34s var(--ds-ease-out, ease-out); }
@keyframes dsh-tidy-settle {
  from { background-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
  to { background-color: transparent; }
}

.dsh-tidy-menu-row { display: block; }
.dsh-tidy-fallback { display:flex; align-items:center; width:100%; gap:8px; padding:6px 10px; border:0; border-radius:var(--dsw-radius-md, 8px); background:transparent; color:var(--dsw-alias-label-primary); font:inherit; text-align:left; cursor:pointer; transition:background-color .15s var(--ds-ease-in-out, ease); }
.dsh-tidy-fallback:hover, .dsh-tidy-fallback:focus-visible { background:var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }

@media (prefers-reduced-motion: reduce) {
  .dsh-tidy-pending, .dsh-tidy-settled,
  .dsh-tidy-drop-before::before, .dsh-tidy-drop-after::after { animation: none !important; }
  .dsh-tidy-dragging, .dsh-tidy-fallback { transition: none !important; }
}
`

    function injectStyle() {
      // 先摘掉同一来源的样式节点：热替换后旧节点仍在 head 里，同一选择器会叠出多份规则。
      const stale = document.querySelectorAll('[data-dsh-panel-tidy]')
      for (const el of stale) {
        if (el.tagName === 'STYLE' && typeof el.remove === 'function') el.remove()
      }
      const style = document.createElement('style')
      style.setAttribute('data-dsh-panel-tidy', '')
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    // ---------------------------------------------------------------- 菜单行

    let primitives = null
    let primitivesResolved = false

    function getPrimitives() {
      if (!primitivesResolved) {
        primitivesResolved = true
        try {
          primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        } catch (error) {
          console.warn('[panel-tidy] 取不到 ui-primitives，改用内置行样式', error)
          primitives = null
        }
      }
      return primitives
    }

    /** 面板自己的图标：直接从主列表那一行克隆 svg，缩放交给 CSS。 */
    function glyphHTML(id) {
      for (const nav of navCache) {
        for (const child of nav.children) {
          if (child.getAttribute('data-dsh-tidy-id') !== id) continue
          const host = child.tagName === 'BUTTON' ? child : child.querySelector('button')
          if (host === null || typeof host.querySelector !== 'function') continue
          const svg = host.querySelector('svg')
          if (svg !== null && svg !== undefined && typeof svg.outerHTML === 'string') return svg.outerHTML
        }
      }
      return null
    }

    const glyphCache = new Map()

    function iconFor(id) {
      let html = glyphCache.get(id)
      if (html === undefined) {
        const found = glyphHTML(id)
        if (found !== null) {
          html = found
          glyphCache.set(id, html)
        }
      }
      if (typeof html !== 'string' || html === '') return undefined
      return h('span', { className: 'dsh-tidy-icon', dangerouslySetInnerHTML: { __html: html } })
    }

    function FallbackRow({ icon, children, current, onSelect }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'dsh-tidy-fallback',
          'aria-current': current === true ? 'page' : undefined,
          onClick: onSelect
        },
        icon === undefined || icon === null ? null : icon,
        h('span', null, children)
      )
    }

    /** 与官方「浏览更多插件」同一套行：左图标、文字，不带手柄和分隔线。 */
    function MenuRow({ entry, onOpen, onDismiss }) {
      const prims = getPrimitives()
      const Row = prims !== null && typeof prims.MenuItemButton === 'function' ? prims.MenuItemButton : FallbackRow
      const select = () => {
        onDismiss()
        onOpen(entry.id)
      }
      return h(
        'div',
        {
          className: 'dsh-tidy-menu-row',
          'data-dsh-tidy-menu-row': '',
          'data-dsh-tidy-id': entry.id
        },
        h(Row, { icon: iconFor(entry.id), current: entry.active === true, onSelect: select }, entry.label)
      )
    }

    /** 「更多」菜单抽屉：把被收纳的入口画成和官方行一样的样式。 */
    function FoldedMenu(props) {
      const entries = Array.isArray(props.entries) ? props.entries : []
      const onOpen = props.onOpen
      const onDismiss = typeof props.onDismiss === 'function' ? props.onDismiss : () => {}
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        const refresh = () => setTick((n) => n + 1)
        listeners.add(refresh)
        return () => {
          listeners.delete(refresh)
        }
      }, [])
      const index = orderMap()
      const folded = entries.filter((entry) => entry && typeof entry.id === 'string' && !isCore(entry.id) && isFolded(entry.id))
      if (folded.length === 0) return null
      folded.sort((a, b) => {
        const ai = index.has(a.id) ? index.get(a.id) : ORDER_TAIL
        const bi = index.has(b.id) ? index.get(b.id) : ORDER_TAIL
        return ai - bi
      })
      return h(
        React.Fragment,
        null,
        folded.map((entry) => h(MenuRow, { key: entry.id, entry, onOpen, onDismiss }))
      )
    }

    // ---------------------------------------------------------------- 装配

    function apply(ctx) {
      ctxRef = ctx
      ctx.effect(() => {
        const removeStyle = injectStyle()

        // 只在侧栏附近变化时重画：聊天流式输出会疯狂改动 DOM，别陪着跑。
        const relevant = (records) => {
          if (navCache.length === 0) return true
          for (const record of records) {
            const target = record.target
            if (target === document.documentElement || target === document.body) return true
            if (target !== null && typeof target.closest === 'function' && target.closest('nav') !== null) return true
          }
          return false
        }

        const observer = new MutationObserver((records) => {
          if (relevant(records)) schedulePaint()
        })
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-label']
        })

        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('pointermove', onPointerMove, true)
        document.addEventListener('pointerup', onPointerUp, true)
        document.addEventListener('pointercancel', onPointerCancel, true)
        document.addEventListener('click', onClickCapture, true)

        void syncFromHost()

        // 首屏：侧栏可能还没挂载完，前几秒补几次重试。
        const timers = [0, 120, 400, 1200, 3000].map((delay) => setTimeout(schedulePaint, delay))

        return () => {
          observer.disconnect()
          timers.forEach(clearTimeout)
          removeStyle()
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('pointermove', onPointerMove, true)
          document.removeEventListener('pointerup', onPointerUp, true)
          document.removeEventListener('pointercancel', onPointerCancel, true)
          document.removeEventListener('click', onClickCapture, true)
          alive = false
          if (pushTimer !== null) clearTimeout(pushTimer)
          pushTimer = null
          navCache = []
          glyphCache.clear()
          cancelPending()
          endDrag()
          ctxRef = null
        }
      }, 'dsh-panel-tidy: 面板整理')

      ctx.slots.inject(SLOT_ACTIONS, () =>
        ctx.slots.register({ name: SLOT_ACTIONS, id: 'panel-tidy', order: -1 }, FoldedMenu)
      )
    }

    return { inject: ['slots'], apply }
  }
})
