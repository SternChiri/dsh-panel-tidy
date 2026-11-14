// 面板整理 · DeepSeek Harness 插件：浏览器半边
//
// 做两件事：
//   1. 每条侧栏面板都能长按拖动：主列表内自由排序；拖到「更多」上＝收进二级菜单；
//      「更多」里的条目也能排序，拖回左侧栏＝重新放出来。
//   2. 记住「哪几条被收起来了」和「顺序」，重启后照旧。
//
// 收纳的视觉与「更多」里的行交给宿主自己画，本插件只负责驱动和记住：
//   原生模式（0.2.2 起，宿主自带钉针）：点那条行自己的取消固定钮，宿主把它从 DOM 摘走；
//     用户在「更多」里钉回来时捕获那次点击，写回状态。
//   兼容模式（0.2.1.x 及更早，没有钉针）：沿用 CSS display:none 隐藏，
//     并在 sidebar.panellist.actions 里自己画被收起来的入口。
// 两种模式共用同一份存储，升级或降级都不丢配置。
window.__ModuleLoader__.load({
  id: 'dsh-panel-tidy',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** 宿主写死的那一个：永远显示、不进「更多」，也没有取消固定钮，所以收不了。 */
    const LOCKED_IDS = ['plugins']
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

    function isLocked(id) {
      return LOCKED_IDS.includes(id)
    }

    /** 只有显式收起来过的才不在主列表；新装插件注册的入口按原样显示。 */
    function isFolded(id) {
      if (isLocked(id)) return false
      return state.folded[id] === true
    }

    function setFolded(id, folded) {
      if (isLocked(id)) return false
      const next = folded === true
      if (state.folded[id] === next) return false
      state.folded[id] = next
      saveState()
      return true
    }

    // ---------------------------------------------------------------- 宿主钉针
    //
    // 0.2.2 起宿主自己有了钉针：宽态下每条面板行多一个「取消固定」钮，「更多」里的行
    // 带一个钉回来的钮。那个 store 是 sidebar 插件内部私有的，没暴露成 Service，
    // 而且要等「更多」菜单打开才拿得到 setPinned —— 所以不碰 React，
    // 只把它的按钮当成开关来点，静态视觉全交给它。

    /** 宿主是否自带钉针。拿到证据后不回退：中途来回切会让行闪。 */
    let nativeMode = false

    function buttonsOf(el) {
      return el && typeof el.querySelectorAll === 'function' ? el.querySelectorAll('button') : []
    }

    /** 行里的主按钮（打开面板那个）；行本身就是一个按钮时就是它自己。 */
    function mainButton(row) {
      if (row === null || row === undefined) return null
      if (row.tagName === 'BUTTON') return row
      return typeof row.querySelector === 'function' ? row.querySelector('button') : null
    }

    /**
     * 行内的「取消固定」钮：宽态下每条面板行有两个按钮，第二个就是它。
     * 用「它的无障碍名字里带着这一行的名字」认它，不认本地化文案，换语言也不会错。
     */
    function unpinButton(row, label) {
      const buttons = buttonsOf(row)
      if (buttons.length < 2) return null
      for (let i = 1; i < buttons.length; i += 1) {
        const button = buttons[i]
        if (button === null || button === undefined) continue
        if (button.getAttribute('aria-haspopup') !== null) continue
        const aria = button.getAttribute('aria-label')
        if (aria === null || aria === '') continue
        if (label !== null && label !== '' && aria.indexOf(label) < 0) continue
        return button
      }
      return null
    }

    /** 「更多」里的行：原生那行有两个按钮，最后一个就是钉回去的钮。 */
    function pinButton(row) {
      const buttons = buttonsOf(row)
      if (buttons.length < 2) return null
      return buttons[buttons.length - 1]
    }

    /** 我们自己点宿主按钮时，别把这次点击当成用户操作再写一遍状态。 */
    let nativeClicking = 0

    /** 点一个宿主按钮；点完把焦点还给原来那个元素——宿主会把焦点抢到「更多」上。 */
    function clickNative(button) {
      if (button === null || button === undefined) return false
      const active = document.activeElement
      // 拖放刚结束时 suppressClick 还立着（复位排在下一个宏任务），
      // 不临时放行的话，点宿主按钮的这一次会被自己的捕获监听吞掉。
      const hold = suppressClick
      suppressClick = false
      nativeClicking += 1
      try {
        button.click()
      } catch (error) {
        console.warn('[panel-tidy] 点击宿主按钮失败', error)
        return false
      } finally {
        nativeClicking -= 1
        suppressClick = hold
        if (active !== null && active !== undefined && typeof active.focus === 'function' && document.contains(active)) {
          try {
            active.focus({ preventScroll: true })
          } catch {
            try {
              active.focus()
            } catch {}
          }
        }
      }
      return true
    }

    /** 有宿主钉针就切到原生模式；只在「宽态行里确实出现了取消固定钮」时才认定。 */
    function probeNative(byLabel, labelOf) {
      for (const child of navChildren()) {
        const button = mainButton(child)
        if (button === null) continue
        const id = byLabel.get(button.getAttribute('aria-label'))
        if (id === undefined) continue
        if (unpinButton(child, labelOf.get(id) ?? null) === null) continue
        nativeMode = true
        return
      }
    }

    /**
     * 「更多」里的一行：从菜单里的任意节点向外爬，取最外那层「刚好只有两个按钮」的祖先。
     * 宿主的结构是 菜单 > 行 > (主按钮 + 钉针按钮)，中间可能还有包装层，不能只看直接子元素。
     */
    function menuRowNear(node, menu) {
      let row = null
      let cur = node
      while (cur !== null && cur !== undefined && cur !== menu && cur.parentNode !== null) {
        const parent = cur.parentNode
        if (parent === menu) break
        const count = buttonsOf(parent).length
        if (count > 2) break
        if (count === 2) row = parent
        cur = parent
      }
      return row
    }

    /** 指针落在「更多」里的哪一行：先看打好的标，标被冲掉就按结构认一次并补标。 */
    function menuRowHit(target) {
      const tagged = target.closest('[data-dsh-tidy-menu-row]')
      if (tagged !== null) return { el: tagged, id: resolveMenuRowId(tagged) }
      const menu = target.closest('[role="menu"]')
      if (menu === null) return null
      const button = target.closest('button')
      const row = menuRowNear(button === null ? target : button, menu)
      if (row === null) return null
      const id = resolveMenuRowId(row)
      if (id === null) return null
      row.setAttribute('data-dsh-tidy-menu-row', '')
      row.setAttribute('data-dsh-tidy-id', id)
      return { el: row, id }
    }

    /** 给宿主画的「更多」行打上身份，好让我们能拖它们。 */
    function tagMenuRows(byLabel) {
      const menus = document.querySelectorAll('[role="menu"]')
      for (const menu of menus) {
        const buttons = buttonsOf(menu)
        for (const button of buttons) {
          const text = (button.textContent || '').trim()
          if (text === '') continue
          const id = byLabel.get(text)
          if (id === undefined) continue
          const row = menuRowNear(button, menu)
          if (row === null) continue
          if (row.getAttribute('aria-haspopup') !== null) continue
          row.setAttribute('data-dsh-tidy-menu-row', '')
          row.setAttribute('data-dsh-tidy-id', id)
        }
      }
    }

    /** 行的 id：优先用打好的标；还没打上就按主按钮的文字反查注册表。 */
    function resolveMenuRowId(row) {
      const tagged = row.getAttribute('data-dsh-tidy-id')
      if (tagged !== null && tagged !== '') return tagged
      const main = mainButton(row)
      const ctx = ctxRef
      if (main === null || ctx === null) return null
      const text = (main.textContent || '').trim()
      for (const info of panelInfos(ctx)) if (info.label === text) return info.id
      return null
    }

    function menuRowOf(id) {
      for (const row of document.querySelectorAll('[data-dsh-tidy-menu-row]')) {
        if (row.getAttribute('data-dsh-tidy-id') === id) return row
      }
      return null
    }

    /** 兜底：宿主重渲染会把行上的标冲掉，这时按行的文字重新找一次。 */
    function menuRowByLabel(id) {
      const ctx = ctxRef
      if (ctx === null) return null
      let label = null
      for (const info of panelInfos(ctx)) if (info.id === id) label = info.label
      if (label === null || label === '') return null
      for (const menu of document.querySelectorAll('[role="menu"]')) {
        for (const button of buttonsOf(menu)) {
          if (button.getAttribute('aria-haspopup') !== null) continue
          if ((button.textContent || '').trim() !== label) continue
          const row = menuRowNear(button, menu)
          if (row !== null) return row
        }
      }
      return null
    }

    function findMenuRow(id) {
      return menuRowOf(id) ?? menuRowByLabel(id)
    }

    /** 侧栏那颗「更多」按钮：补点时得先把菜单重新打开。 */
    function moreButton() {
      for (const child of navChildren()) {
        const button = mainButton(child)
        if (button !== null && button.getAttribute('aria-haspopup') === 'menu') return button
      }
      return null
    }

    /** 钉回去的那一下可能扑空（菜单刚好关了、宿主正在重渲染）：稍等再补点一次。 */
    let pinTimers = []

    function clearPinTimers() {
      for (const timer of pinTimers) clearTimeout(timer)
      pinTimers = []
    }

    function pinBack(id) {
      clearPinTimers()
      pinTimers.push(
        setTimeout(() => {
          const row = findMenuRow(id)
          if (row !== null) {
            clickNative(pinButton(row))
            return
          }
          const more = moreButton()
          if (more === null) return
          clickNative(more)
          pinTimers.push(
            setTimeout(() => {
              schedulePaint()
              const again = findMenuRow(id)
              if (again !== null) clickNative(pinButton(again))
            }, 160)
          )
        }, 120)
      )
    }

    /** 把已收起的条目在宿主那边点掉，让它真的从侧栏消失。 */
    function reconcileNative() {
      if (!nativeMode) return
      for (const row of sideRows()) {
        if (!isFolded(row.getAttribute('data-dsh-tidy-id'))) continue
        const button = unpinButton(row, row.getAttribute('data-dsh-tidy-label'))
        if (button !== null) clickNative(button)
      }
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
      const child = rowOfId(id)
      if (child === null) return
      child.classList.add('dsh-tidy-settled')
      setTimeout(() => child.classList.remove('dsh-tidy-settled'), 360)
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

    /** 左侧栏里的所有直接子节点（面板行与「更多」）。 */
    function navChildren() {
      const children = []
      for (const nav of navCache) for (const child of nav.children) children.push(child)
      return children
    }

    /** 侧栏里已经认出来的面板行。 */
    function sideRows() {
      const rows = []
      for (const nav of navCache) {
        for (const child of nav.children) {
          if (typeof child.hasAttribute === 'function' && child.hasAttribute('data-dsh-tidy-row')) rows.push(child)
        }
      }
      return rows
    }

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
      const labelOf = new Map()
      for (const info of infos) {
        labelOf.set(info.id, info.label)
        if (info.label !== null) byLabel.set(info.label, info.id)
      }
      const index = orderMap()

      if (!nativeMode) probeNative(byLabel, labelOf)

      for (const child of navChildren()) {
        const button = mainButton(child)
        if (button === null) continue
        if (button.getAttribute('aria-haspopup') === 'menu') {
          child.style.order = String(ORDER_TAIL)
          continue
        }
        const id = byLabel.get(button.getAttribute('aria-label'))
        if (id === undefined) continue
        child.setAttribute('data-dsh-tidy-row', '')
        child.setAttribute('data-dsh-tidy-id', id)
        child.setAttribute('data-dsh-tidy-label', labelOf.get(id) ?? '')
        // 清掉上一轮拖动可能留下的落点高亮、可拖标记与位移。
        child.classList.remove('dsh-tidy-drop-before', 'dsh-tidy-drop-after', 'dsh-tidy-drop-more', 'dsh-tidy-pending')
        if (child.hasAttribute('draggable')) child.removeAttribute('draggable')
        if (armed !== null && armed.el === child) continue
        if (child.style.transform) {
          child.style.transform = ''
          child.style.pointerEvents = ''
          child.style.zIndex = ''
        }
        // 原生模式下显示权归宿主，这里只清掉兼容模式留下的隐藏。
        child.style.display = nativeMode || !isFolded(id) ? '' : 'none'
        child.style.order = String(index.has(id) ? index.get(id) : ORDER_TAIL - 1)
      }

      if (nativeMode) {
        tagMenuRows(byLabel)
        orderMenuRows()
        reconcileNative()
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
      const menuRow = menuRowHit(target)
      if (menuRow !== null) return { el: menuRow.el, kind: 'menu', id: menuRow.id }
      const mainRow = target.closest('[data-dsh-tidy-row]')
      if (mainRow === null) return null
      return { el: mainRow, kind: 'main', id: mainRow.getAttribute('data-dsh-tidy-id') }
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
      const after = isAfter(el, y)
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
      const menuRow = menuRowHit(el)
      if (menuRow !== null) return { kind: 'menu', el: menuRow.el, id: menuRow.id }
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

    /**
     * 原生「更多」里的行按我们记的顺序排。
     * 直接换 DOM 位置而不是只写 style.order——宿主的菜单不一定是 flex，
     * 写 order 在一些布局里毫无效果，看起来就是「拖了没反应」。
     */
    function orderMenuRows() {
      const index = orderMap()
      const menus = document.querySelectorAll('[role="menu"]')
      for (const menu of menus) {
        const rows = []
        for (const row of menu.querySelectorAll('[data-dsh-tidy-menu-row]')) rows.push(row)
        if (rows.length < 2) continue
        const parent = rows[0].parentNode
        if (parent === null) continue
        if (rows.some((row) => row.parentNode !== parent)) continue
        const pos = (row) => {
          const id = row.getAttribute('data-dsh-tidy-id')
          return index.has(id) ? index.get(id) : ORDER_TAIL
        }
        const sorted = rows.slice().sort((a, b) => pos(a) - pos(b))
        const current = []
        for (const child of parent.children) {
          if (child.getAttribute('data-dsh-tidy-menu-row') !== null) current.push(child)
        }
        let same = current.length === sorted.length
        if (same) {
          for (let i = 0; i < sorted.length; i += 1) {
            if (current[i] !== sorted[i]) {
              same = false
              break
            }
          }
        }
        if (same) continue
        // 锚点：最后一个行之后的第一个非行兄弟；没有就插到末尾。
        const siblings = Array.from(parent.children)
        const from = siblings.indexOf(rows[rows.length - 1])
        let anchor = null
        for (let i = from + 1; i < siblings.length; i += 1) {
          if (siblings[i].getAttribute('data-dsh-tidy-menu-row') === null) {
            anchor = siblings[i]
            break
          }
        }
        for (const row of sorted) parent.insertBefore(row, anchor)
      }
    }

    function rowOfId(id) {
      return sideRows().find((row) => row.getAttribute('data-dsh-tidy-id') === id) ?? null
    }

    /** 收起/放出：状态照旧记在自己这边，原生模式下再顺手点掉宿主那颗钮。 */
    function applyFold(id, folded) {
      const changed = setFolded(id, folded)
      // 状态没变（含宿主写死的「插件」）就不要再戳宿主，免得白点一次。
      if (!changed || !nativeMode) return changed
      if (folded) {
        const row = rowOfId(id)
        if (row !== null) clickNative(unpinButton(row, row.getAttribute('data-dsh-tidy-label')))
      } else {
        const row = findMenuRow(id)
        if (row !== null) clickNative(pinButton(row))
        else pinBack(id)
      }
      return changed
    }

    function commitDrop(source, x, y) {
      const hit = resolveHit(x, y)
      clearMarks()
      if (hit === null) {
        // 从「更多」拖到菜单外、又没落在侧栏上：按「拿出来」处理。
        if (source.kind === 'menu') {
          applyFold(source.id, false)
          emit()
        }
        return
      }
      const fromMenu = source.kind === 'menu'
      const afterAt = (el) => (el.after !== undefined ? el.after : isAfter(el.el, y))
      if (hit.kind === 'menu') {
        if (!fromMenu) applyFold(source.id, true)
        moveId(source.id, hit.id, afterAt(hit))
        emit()
        return
      }
      if (hit.kind === 'more') {
        applyFold(source.id, true)
        emit()
        const button = fromMenu ? null : hit.el.querySelector('button[aria-haspopup="menu"]')
        if (button !== null) setTimeout(() => button.click(), 0)
        return
      }
      if (fromMenu) applyFold(source.id, false)
      if (hit.kind === 'row') {
        moveId(source.id, hit.id !== undefined ? hit.id : hit.el.getAttribute('data-dsh-tidy-id'), afterAt(hit))
      } else {
        // 左侧栏空白处：归到队尾。
        const last = state.order[state.order.length - 1]
        if (last !== undefined) moveId(source.id, last, true)
      }
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
      if (armed === null) return
      resetDrag()
      setTimeout(() => {
        suppressClick = false
      }, 0)
    }

    /** 指针落在行里的钉针按钮上时不算拖动起点——否则长按会把这次点击吞掉。 */
    function onRowControl(event, hit) {
      const target = event.target
      if (target === null || target === undefined || typeof target.closest !== 'function') return false
      const button = target.closest('button')
      if (button === null) return false
      return button !== mainButton(hit.el)
    }

    function onPointerDown(event) {
      if (event.button !== undefined && event.button !== 0) return
      if (armed !== null) endDrag()
      if (pending !== null) cancelPending()
      const hit = rowUnder(event.target)
      if (hit === null) return
      if (hit.kind === 'menu' && buttonsOf(hit.el).length > 2) return
      if (onRowControl(event, hit)) return
      lastPointer = { x: event.clientX, y: event.clientY }
      const start = { el: hit.el, kind: hit.kind, id: hit.id, x: event.clientX, y: event.clientY, timer: null }
      start.timer = setTimeout(() => armHold(start), HOLD_MS)
      pending = start
      hit.el.classList.add('dsh-tidy-pending')
    }

    /** 指针离按下点远了超过 MOVE_CANCEL。 */
    function beyond(start, event) {
      return Math.abs(event.clientX - start.x) > MOVE_CANCEL || Math.abs(event.clientY - start.y) > MOVE_CANCEL
    }

    function onPointerMove(event) {
      lastPointer = { x: event.clientX, y: event.clientY }
      // 还没按满就移动：当作普通点击/误触，别把人家的点击吃掉。
      if (pending !== null) {
        if (beyond(pending, event)) cancelPending()
        return
      }
      if (armed === null) return
      if (beyond(armed, event)) armed.moved = true
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
      // 拖放结束的那一下我们自己会去点宿主的钉针钮——那次点击必须放行，
      // 否则拦下的是我们唯一能改原生状态的通道。
      if (nativeClicking > 0) return
      if (!suppressClick) return
      suppressClick = false
      event.preventDefault()
      event.stopPropagation()
    }

    /**
     * 用户自己点宿主那颗钉针钮时，把结果记下来（我们自己点的那次不算）。
     * 侧栏行上的「取消固定」→ 收起；「更多」行里的「钉回去」→ 放出。
     */
    function onNativeClick(event) {
      if (!nativeMode || nativeClicking > 0) return
      const target = event.target
      if (target === null || target === undefined || typeof target.closest !== 'function') return
      const row = target.closest('[data-dsh-tidy-row]')
      if (row !== null) {
        const button = unpinButton(row, row.getAttribute('data-dsh-tidy-label'))
        if (button !== null && button.contains(target)) {
          if (setFolded(row.getAttribute('data-dsh-tidy-id'), true)) emit()
        }
        return
      }
      const menu = target.closest('[role="menu"]')
      if (menu === null) return
      const menuRow = menuRowNear(target, menu)
      if (menuRow === null) return
      const pin = pinButton(menuRow)
      if (pin === null || !pin.contains(target)) return
      const id = resolveMenuRowId(menuRow)
      if (id !== null && setFolded(id, false)) emit()
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
      const host = mainButton(rowOfId(id))
      if (host === null || typeof host.querySelector !== 'function') return null
      const svg = host.querySelector('svg')
      return svg !== null && svg !== undefined && typeof svg.outerHTML === 'string' ? svg.outerHTML : null
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
        icon ?? null,
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
      // 宿主把 pinned 传下来了 = 它自带钉针：收纳的行由它自己画，我们不再抢。
      for (const entry of entries) {
        if (entry !== null && typeof entry === 'object' && 'pinned' in entry) {
          nativeMode = true
          break
        }
      }
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
      const folded = entries.filter((entry) => entry && typeof entry.id === 'string' && !isLocked(entry.id) && isFolded(entry.id))
      if (nativeMode || folded.length === 0) return null
      const at = (entry) => (index.has(entry.id) ? index.get(entry.id) : ORDER_TAIL)
      folded.sort((a, b) => at(a) - at(b))
      return h(
        React.Fragment,
        null,
        folded.map((entry) => h(MenuRow, { key: entry.id, entry, onOpen, onDismiss }))
      )
    }

    /** 点开「更多」之后的一小段时间里多刷几遍：菜单异步挂载，MutationObserver 常赶在行之前。 */
    let menuWatch = null

    function watchMenuOpen(event) {
      const target = event.target
      if (target === null || target === undefined || typeof target.closest !== 'function') return
      const button = target.closest('button')
      if (button === null || button.getAttribute('aria-haspopup') !== 'menu') return
      if (menuWatch !== null) clearTimeout(menuWatch)
      let ticks = 0
      const tick = () => {
        menuWatch = null
        ticks += 1
        schedulePaint()
        if (ticks >= 14) return
        menuWatch = setTimeout(tick, 100)
      }
      menuWatch = setTimeout(tick, 30)
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
            if (target !== null && typeof target.closest === 'function') {
              if (target.closest('nav') !== null) return true
              if (target.closest('[role="menu"]') !== null) return true
            }
            for (const node of record.addedNodes) {
              if (node === null || node === undefined || node.nodeType !== 1) continue
              if (node.getAttribute('role') === 'menu') return true
              if (typeof node.querySelector === 'function' && node.querySelector('[role="menu"]') !== null) return true
            }
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

        const handlers = [
          ['pointerdown', onPointerDown],
          ['pointermove', onPointerMove],
          ['pointerup', onPointerUp],
          ['pointercancel', onPointerCancel],
          ['click', onClickCapture],
          ['click', onNativeClick],
          ['click', watchMenuOpen]
        ]
        for (const [type, handler] of handlers) document.addEventListener(type, handler, true)

        void syncFromHost()

        // 首屏：侧栏可能还没挂载完，前几秒补几次重试。
        const timers = [0, 120, 400, 1200, 3000].map((delay) => setTimeout(schedulePaint, delay))

        return () => {
          observer.disconnect()
          timers.forEach(clearTimeout)
          removeStyle()
          for (const [type, handler] of handlers) document.removeEventListener(type, handler, true)
          if (menuWatch !== null) {
            clearTimeout(menuWatch)
            menuWatch = null
          }
          clearPinTimers()
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
