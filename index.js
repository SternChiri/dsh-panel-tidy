/**
 * 宿主半边：把侧栏布局存进 DSH 主目录，浏览器存储被清掉也能恢复。
 *
 * 只依赖 node 内置模块，路径一律在运行时按 `$DSH_HOME`（没有就 `~/.dsh`）推导，
 * 所以换机器、换目录、换端口都不需要改代码。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 浏览器半边用同一个路径来读写。 */
export const STATE_ROUTE = '/dsh-panel-tidy/state'
const BODY_LIMIT = 64 * 1024

/** 状态文件：`$DSH_HOME/panel-tidy/state.json`。 */
export function stateFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'panel-tidy', 'state.json')
}

/** 校验并归一化一份状态；不合法返回 null。 */
export function parseState(value) {
  let parsed = value
  if (typeof value === 'string') {
    if (value.length > BODY_LIMIT) return null
    try {
      parsed = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.folded !== undefined && (parsed.folded === null || typeof parsed.folded !== 'object' || Array.isArray(parsed.folded))) {
    return null
  }
  if (parsed.order !== undefined && !Array.isArray(parsed.order)) return null
  const folded = {}
  if (parsed.folded !== null && typeof parsed.folded === 'object' && !Array.isArray(parsed.folded)) {
    for (const [id, on] of Object.entries(parsed.folded)) {
      if (id !== '' && typeof on === 'boolean') folded[id] = on
    }
  }
  const order = Array.isArray(parsed.order) ? parsed.order.filter((id) => typeof id === 'string' && id !== '') : []
  const savedAt = typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0
  return { folded, order, savedAt }
}

/** 文件读写：先写临时文件再 rename，避免写一半被读到。 */
export function createStateStore(file) {
  return {
    async read() {
      try {
        return parseState(await readFile(file, 'utf8'))
      } catch (error) {
        if (error && error.code === 'ENOENT') return null
        throw error
      }
    },
    async write(state) {
      const next = parseState(state)
      if (next === null) throw new Error('invalid state')
      await mkdir(dirname(file), { recursive: true })
      const temp = file + '.' + process.pid + '.tmp'
      await writeFile(temp, JSON.stringify(next), 'utf8')
      await rename(temp, file)
      return next
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res, status, body, headers) {
  res.writeHead(status, headers || {})
  res.end(body === undefined ? undefined : body)
}

/** GET/HEAD 读、POST 写，其余 405。 */
export function createRouteHandler(store) {
  return async function handle(req, res) {
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const state = await store.read()
        if (state === null) {
          send(res, 204)
          return
        }
        send(res, 200, JSON.stringify(state), {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store'
        })
        return
      }
      if (req.method === 'POST') {
        const state = parseState(await readBody(req))
        if (state === null) {
          send(res, 400, 'invalid state', { 'content-type': 'text/plain; charset=utf-8' })
          return
        }
        await store.write(state)
        send(res, 204)
        return
      }
      send(res, 405, 'method not allowed', { allow: 'GET, HEAD, POST' })
    } catch (error) {
      send(res, 500, 'state unavailable', { 'content-type': 'text/plain; charset=utf-8' })
    }
  }
}

/** 注册状态路由；宿主没有 Web 服务时安静跳过。 */
function registerRoute(store, webCtx) {
  const webServer = webCtx && webCtx.webServer
  if (!webServer || typeof webServer.register !== 'function') return
  if (typeof webCtx.effect !== 'function') return
  webCtx.effect(() => {
    const dispose = webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: createRouteHandler(store)
    })
    return () => {
      void dispose()
    }
  }, 'dsh-panel-tidy: 布局状态路由')
}

/** 拿 Web 服务：新宿主用 ctx.inject 等它上线，老宿主退回 reflect 读一次。 */
function attach(ctx, register) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], register)
    return
  }
  const webServer = typeof ctx.reflect?.get === 'function' ? ctx.reflect.get('webServer') : undefined
  if (webServer) {
    register({ webServer, effect: (fn, label) => ctx.effect(fn, label) })
  }
}

export function apply(ctx) {
  const store = createStateStore(stateFile())
  try {
    attach(ctx, (webCtx) => registerRoute(store, webCtx))
  } catch (error) {
    // 宿主能力对不上时只放弃路由：浏览器半边不受影响。
    console.warn('[panel-tidy] 宿主状态路由未注册', error)
  }
}
