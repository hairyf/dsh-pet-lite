import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PetAsset, PetCatalog, PetPatch, PetRuntimeStatus, PresetPetItem } from '../shared/types'
import { Buffer } from 'node:buffer'
import {
  CATALOG_PATH,
  ROUTE_PREFIX,
  SESSION_STREAM_PATH,
  SETTINGS_PATH,
  SSE_KEEPALIVE_MS,
} from '../shared/constants'
import { builtInCatalog, presetAsset } from './catalog'
import { sessionStream } from './session-stream'
import { snapshot, update } from './store'

/**
 * host/routes.ts — 桌宠业务路由（原生 node:http，不依赖框架）。
 *
 * 与 apps/desktop 的两处实现同构：
 *   - HTTP 路由（插件 host 半侧）
 *   - Electron 桌宠窗口消费的同一批端点
 *
 * 上游还多一条「bridge 管道」（自定义 scheme + stdin/stdout JSON 行 + 本地 HTTP 回调），
 * 只为绕开上游宿主的浏览器访问闸门。本插件的窗口直接走这些 HTTP 端点，因此不需要管道。
 */

export interface RouteContext {
  desktopSupported: boolean
  desktopOpen: boolean
  /** 打开 / 关闭独立桌宠窗口。 */
  setDesktop: (open: boolean) => Promise<void>
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  handle: (req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext) => Promise<void> | void
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** 读取请求体（带长度上限）。 */
async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit)
      throw new Error('PET_BODY_TOO_LARGE')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 当前状态快照（每次请求实时读取，避免缓存跨实例残留）。 */
function runtimeStatus(ctx: RouteContext): PetRuntimeStatus {
  return snapshot({ desktopSupported: ctx.desktopSupported, desktopOpen: ctx.desktopOpen })
}

/** 一次拿齐三份清单 + 状态（对应上游 `loadPetCatalog` 的四个命令聚合）。 */
function catalog(ctx: RouteContext): PetCatalog {
  const presets: PresetPetItem[] = builtInCatalog()
  return {
    presetPets: presets,
    // Chat / Codex 两类「用户导入」清单：本插件的导入实现（zip 解包 + 校验）尚未落地，
    // 因此固定为空数组 —— 与上游 `list_pets` 在没有导入时的返回值一致，而不是假装支持。
    chatPets: [],
    codexPets: [],
    status: runtimeStatus(ctx),
  }
}

const settingsRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}${SETTINGS_PATH}`,
  handle(_req, res, _url, ctx) {
    sendJson(res, 200, runtimeStatus(ctx))
  },
}

const catalogRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}${CATALOG_PATH}`,
  handle(_req, res, _url, ctx) {
    sendJson(res, 200, catalog(ctx))
  },
}

/**
 * PUT /settings — 更新选择 / 启用 / 大小 / 抛射，并同步桌面窗口的开关。
 *
 * 与上游一致：命令回吐**权威状态**，前端不做乐观本地副本。
 */
const patchRoute: Route = {
  method: 'PUT',
  path: `${ROUTE_PREFIX}${SETTINGS_PATH}`,
  async handle(req, res, _url, ctx) {
    let patch: PetPatch
    try {
      patch = JSON.parse(await readBody(req)) as PetPatch
    }
    catch {
      sendText(res, 400, 'PET_BAD_REQUEST: body must be JSON')
      return
    }
    if (patch === null || typeof patch !== 'object') {
      sendText(res, 400, 'PET_BAD_REQUEST: body must be an object')
      return
    }
    // 白名单收窄：只有这四个字段进持久层。
    const next = update({
      active_pet: patch.active_pet,
      enabled: patch.enabled,
      pet_size: patch.pet_size,
      throw_enabled: patch.throw_enabled,
    })
    // 启用态决定桌面窗口是否该在（与上游 `syncDesktop` 的分工一致：服务层只管落盘，
    // 窗口开合由宿主在状态变化后对齐）。
    try {
      await syncDesktop(ctx, next.enabled && next.active_pet !== '')
    }
    catch {
      /* 窗口开合失败不改变已落盘的选择 */
    }
    sendJson(res, 200, runtimeStatus(ctx))
  },
}

/** 把桌面窗口对齐到「该不该在」。 */
async function syncDesktop(ctx: RouteContext, shouldOpen: boolean): Promise<void> {
  if (!ctx.desktopSupported)
    return
  if (shouldOpen === ctx.desktopOpen)
    return
  await ctx.setDesktop(shouldOpen)
}

/**
 * GET /asset/:id — 预设宠物的渲染参数（对应 Rust `get_pet_asset`）。
 *
 * 预设宠物直连远端：返回的 `config` / `uri` 是原始远端地址，不做代理与下载。
 */
const assetRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}/asset`,
  handle(_req, res, url) {
    const id = url.searchParams.get('id') ?? ''
    const item = builtInCatalog().find(entry => entry.id === id)
    if (!item) {
      sendText(res, 404, `PET_NOT_FOUND: ${id}`)
      return
    }
    const asset: PetAsset = presetAsset(item)
    sendJson(res, 200, asset)
  },
}

/**
 * GET /config — 预设的原始配置文件代理。
 *
 * 桌宠窗口是 `file://` 页面，直连远端会撞 CORS；这里由宿主代取（同源），窗口只连本机。
 * 只允许代理**清单里出现过的** config 地址，避免变成任意 URL 代理。
 */
const configRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}/config`,
  async handle(_req, res, url) {
    const id = url.searchParams.get('id') ?? ''
    const item = builtInCatalog().find(entry => entry.id === id)
    if (!item) {
      sendText(res, 404, `PET_NOT_FOUND: ${id}`)
      return
    }
    try {
      const response = await fetch(item.config, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) {
        sendText(res, 502, `PET_CONFIG_FETCH_FAILED: ${response.status}`)
        return
      }
      const text = await response.text()
      sendJson(res, 200, { id: item.id, url: item.config, body: text })
    }
    catch (error) {
      sendText(res, 502, `PET_CONFIG_FETCH_FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

/**
 * GET /session/stream — 桌宠会话增量 SSE 流。
 *
 * 帧格式与上游逐字对齐：
 *   - 数据帧 `data: {"action":…,"payload":…}\n\n`；
 *   - 心跳注释帧 `: keepalive\n\n`；
 *   - 状态作废注释帧 `: state-lost\n\n`；
 *   - 重连提示 `retry: 1000` 只随**首帧**数据发出。
 *
 * 这里手写 SSE 而不用 h3 的 EventStream：原生 http 响应已足够，且少一层依赖。
 */
const streamRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}${SESSION_STREAM_PATH}`,
  handle(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // 接入即刷一帧注释：写头不会单独把响应头发出去，若长时间没有会话事件，
    // 客户端会一直拿不到响应头。注释帧被所有 SSE 客户端忽略，等价于「连接已就绪」。
    res.write(': keepalive\n\n')

    let retrySent = false
    let closed = false
    let keepalive: ReturnType<typeof setInterval> | undefined
    let detach: (() => void) | undefined

    const finish = (): void => {
      if (closed)
        return
      closed = true
      if (keepalive !== undefined) {
        clearInterval(keepalive)
        keepalive = undefined
      }
      detach?.()
      detach = undefined
    }

    const sink = {
      push(frame: string): void {
        if (closed)
          return
        if (retrySent) {
          res.write(`data: ${frame}\n\n`)
          return
        }
        retrySent = true
        res.write(`retry: 1000\ndata: ${frame}\n\n`)
      },
      close(): void {
        finish()
        res.end()
      },
    }

    const { detach: release, stateLost } = sessionStream.start(sink)
    detach = release
    // 接入前已无其他消费者：宿主累计态是从零重建的，消费端手里的气泡全部作废。
    if (stateLost)
      res.write(': state-lost\n\n')

    keepalive = setInterval(() => {
      if (!closed)
        res.write(': keepalive\n\n')
    }, SSE_KEEPALIVE_MS)
    keepalive.unref?.()

    req.on('close', finish)
    res.on('close', finish)
    res.on('error', finish)
  },
}

export const routes: readonly Route[] = [
  settingsRoute,
  catalogRoute,
  patchRoute,
  assetRoute,
  configRoute,
  streamRoute,
]

/** 逐条匹配：方法 + 绝对路径。 */
export function matchRoute(method: string, pathname: string): Route | undefined {
  return routes.find(route => route.method === method && route.path === pathname)
}

/** 未匹配到任何路由时的统一 404 文案。 */
export function notFound(res: ServerResponse, pathname: string): void {
  sendText(res, 404, `PET_NOT_FOUND: ${pathname}`)
}
