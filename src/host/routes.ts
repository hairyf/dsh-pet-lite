import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PetAsset, PetCatalog, PetPatch, PetRuntimeStatus, PetSource } from '../shared/types'
import { Buffer } from 'node:buffer'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  CATALOG_PATH,
  DESKTOP_OPEN_URL,
  ROUTE_PREFIX,
  SESSION_STREAM_PATH,
  SETTINGS_PATH,
  SETTINGS_STREAM_PATH,
  SSE_KEEPALIVE_MS,
} from '../shared/constants'
import { fullCatalog, presetAsset, registerRemotePet, replaceRemotePet, unregisterRemotePet } from './catalog'
import { findPetDirectory, listPets, parseQualifiedId, petsDir, readSpritesheet, safeRelativePath } from './pet-fs'
import { importPetArchive } from './pet-import'
import { checkPetUpdates, importPetRepository, updatePetRepository } from './pet-repo'
import { sessionStream } from './session-stream'
import { attachSettings, publishSettings } from './settings-stream'
import { snapshot, update } from './store'

/**
 * host/routes.ts — 桌宠业务路由（原生 node:http，不依赖框架）。
 *
 * 对应 apps/desktop `bridge/pet.rs` 的一整套命令：设置 / 清单 / 列表 / 素材 / 配置 /
 * 仓库登记 / zip 导入 / 更新检查 / 删除 / 外链 / SSE。上游还多一条 bridge 管道（自定义
 * scheme + stdin/stdout JSON 行）只为绕开宿主的浏览器访问闸门；本插件的窗口直接走这些
 * HTTP 端点，因此不需要管道。
 */

export interface RouteContext {
  desktopSupported: boolean
  desktopOpen: boolean
  /** 打开 / 关闭独立桌宠窗口。 */
  setDesktop: (open: boolean) => Promise<void>
  /** 当前服务的 origin（`http://127.0.0.1:<port>`），用于拼本机文件 URL。 */
  origin: string
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
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
async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<string> {
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

/** 解析 JSON 请求体；非法时回 400 并返回 undefined。 */
async function readJson<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  try {
    const value = JSON.parse(await readBody(req)) as T
    if (value === null || typeof value !== 'object') {
      sendText(res, 400, 'PET_BAD_REQUEST: body must be an object')
      return undefined
    }
    return value
  }
  catch {
    sendText(res, 400, 'PET_BAD_REQUEST: body must be JSON')
    return undefined
  }
}

/**
 * 当前状态快照（每次请求实时读取）。
 *
 * `open_url` 是「显示主界面」要打开的目标：
 *   - 独立窗口跑在桌面端宿主里时用官方协议 `dsh://open`（`desktop/deep_link.rs`
 *     精确匹配它，官方桌面端据此把主窗口带到前台）；
 *   - 纯网页宿主回落到自己的 origin（浏览器里由谁接住取决于宿主，给 origin 最保守）；
 *   - 都没有就留空，渲染端据此隐藏该菜单项。
 */
function runtimeStatus(ctx: RouteContext): PetRuntimeStatus {
  const openUrl = ctx.desktopOpen || ctx.desktopSupported ? DESKTOP_OPEN_URL : ctx.origin
  return snapshot({ desktopSupported: ctx.desktopSupported, desktopOpen: ctx.desktopOpen, openUrl })
}

/** 一次拿齐三份清单 + 状态（= `list_preset_pets` + `list_pets(chat)` + `list_pets(codex)`）。 */
async function catalog(ctx: RouteContext): Promise<PetCatalog> {
  const [chatPets, codexPets] = await Promise.all([listPets('chat'), listPets('codex')])
  return {
    presetPets: fullCatalog(),
    chatPets,
    codexPets,
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
  async handle(_req, res, _url, ctx) {
    sendJson(res, 200, await catalog(ctx))
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
    const patch = await readJson<PetPatch>(req, res)
    if (patch === undefined)
      return
    // 白名单收窄：只有这四个字段进持久层。
    const next = update({
      active_pet: patch.active_pet,
      enabled: patch.enabled,
      pet_size: patch.pet_size,
      throw_enabled: patch.throw_enabled,
    })
    let status: PetRuntimeStatus
    try {
      await syncDesktop(ctx, next.enabled && next.active_pet !== '')
      status = runtimeStatus(ctx)
    }
    catch (error) {
      // Window startup failure must be visible. Persisted user intent remains unchanged
      // only in memory, so reporting the failure prevents the UI from showing a false success.
      sendText(res, 502, `PET_DESKTOP_START_FAILED: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    // 已打开的窗口必须立刻知道「大小 / 抛射 / 选择」变了 —— 否则它要等下次重启才跟上
    // （滑条拖了宠物不变、抛射关了还在飞，都是这条推送缺席的表现）。
    publishSettings(status)
    sendJson(res, 200, status)
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
 * GET /asset?id= — 宠物渲染参数（对应 Rust `get_pet_asset`）。
 *
 * - 预设（无 `:`）：直连远端，`config` / `uri` 原样返回；
 * - 本地来源限定 id（`chat:` / `codex:`）：读盘。codex 返回图集 data URL；dsh 返回
 *   配置对象 + 指回本机 `/file` 的素材模板（组件按 `uri/<name>.<ext>` 拼地址）。
 */
const assetRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}/asset`,
  async handle(_req, res, url, ctx) {
    const id = (url.searchParams.get('id') ?? '').trim()
    if (!id) {
      sendText(res, 400, 'PET_ID_INVALID: id is required')
      return
    }
    // 预设。
    const preset = fullCatalog().find(entry => entry.id === id)
    if (preset) {
      sendJson(res, 200, presetAsset(preset))
      return
    }
    // 本地来源限定 id。
    let qualified: { source: PetSource, manifestId: string }
    try {
      qualified = parseQualifiedId(id)
    }
    catch {
      sendText(res, 404, `PET_NOT_FOUND: ${id}`)
      return
    }
    const root = petsDir(qualified.source)
    const found = findPetDirectory(root, qualified.manifestId)
    if (!found) {
      sendText(res, 404, `PET_NOT_FOUND: ${id}`)
      return
    }
    try {
      if (found.manifest.kind === 'dsh') {
        const configPath = safeRelativePath(found.manifest.configPath ?? 'config.jsonc')
        const ext = found.manifest.ext ?? { default: 'webm', mac: 'mov' }
        const uriPath = safeRelativePath(found.manifest.uriPath ?? 'webm')
        const asset: PetAsset = {
          kind: 'dsh',
          id,
          config: readFileSync(join(found.directory, configPath), 'utf8'),
          uri: { default: `${ctx.origin}${ROUTE_PREFIX}/file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(uriPath)}/{name}.{ext}` },
          ext,
          size: found.manifest.size,
        }
        sendJson(res, 200, asset)
        return
      }
      const { url: spritesheet, grid } = await readSpritesheet(found.directory, found.manifest.spritesheetPath ?? '', found.manifest.spriteVersionNumber)
      const asset: PetAsset = {
        kind: 'codex',
        id,
        spritesheet,
        sprite_version_number: found.manifest.spriteVersionNumber === 1 ? 1 : grid.version,
        columns: grid.columns,
        rows: grid.rows,
      }
      sendJson(res, 200, asset)
    }
    catch (error) {
      sendText(res, 422, `PET_ASSET_INVALID: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

/**
 * GET /file?id=&path= — 提供本地宠物的素材文件（dsh 逐动作视频）。
 *
 * 只允许在**该宠物自己的目录**内取文件（`safeRelativePath` + 前缀校验），绝不做任意
 * 文件服务。`path` 是相对素材根（`uriPath`）的路径。
 */
const fileRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}/file`,
  handle(_req, res, url) {
    const id = (url.searchParams.get('id') ?? '').trim()
    const relative = url.searchParams.get('path') ?? ''
    let qualified: { source: PetSource, manifestId: string }
    try {
      qualified = parseQualifiedId(id)
    }
    catch {
      sendText(res, 400, 'PET_ID_INVALID: source-qualified id is required')
      return
    }
    const root = petsDir(qualified.source)
    const found = findPetDirectory(root, qualified.manifestId)
    if (!found) {
      sendText(res, 404, `PET_NOT_FOUND: ${id}`)
      return
    }
    let target: string
    try {
      target = join(found.directory, safeRelativePath(relative))
    }
    catch {
      sendText(res, 400, 'PET_PATH_INVALID: invalid asset path')
      return
    }
    const base = found.directory
    if (!target.startsWith(base) || !existsSync(target) || !statSync(target).isFile()) {
      sendText(res, 404, 'PET_ASSET_NOT_FOUND')
      return
    }
    const extension = target.slice(target.lastIndexOf('.')).toLowerCase()
    const contentType = extension === '.webm'
      ? 'video/webm'
      : extension === '.mov'
        ? 'video/quicktime'
        : extension === '.mp4'
          ? 'video/mp4'
          : extension === '.png' ? 'image/png' : 'application/octet-stream'
    const bytes = readFileSync(target)
    res.writeHead(200, { 'content-type': contentType, 'content-length': bytes.length, 'cache-control': 'public, max-age=3600' })
    res.end(bytes)
  },
}

/**
 * GET /config?id= — 预设的原始配置文件代理（`file://` 页面避免 CORS）。
 *
 * 只代理**清单里出现过的** config 地址，避免变成任意 URL 代理。
 */
const configRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}/config`,
  async handle(_req, res, url) {
    const id = (url.searchParams.get('id') ?? '').trim()
    const item = fullCatalog().find(entry => entry.id === id)
    if (!item) {
      sendText(res, 404, `PET_NOT_FOUND: ${id}`)
      return
    }
    try {
      const response = await fetch(item.config ?? '', { signal: AbortSignal.timeout(15_000) })
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

/** GET /pets?source= — 列出某来源（chat/codex）的文件系统宠物。 */
const petsRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}/pets`,
  async handle(_req, res, url) {
    const source = url.searchParams.get('source') ?? ''
    if (source !== 'chat' && source !== 'codex') {
      sendText(res, 400, 'PET_SOURCE_INVALID: source must be chat or codex')
      return
    }
    try {
      sendJson(res, 200, await listPets(source))
    }
    catch (error) {
      sendText(res, 500, `PET_LIST_FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

/** POST /import — 导入 Codex 宠物 zip（base64）。返回安装后的列表项。 */
const importRoute: Route = {
  method: 'POST',
  path: `${ROUTE_PREFIX}/import`,
  async handle(req, res) {
    const body = await readJson<{ name?: string, data?: string }>(req, res)
    if (body === undefined)
      return
    if (typeof body.data !== 'string' || body.data.length === 0) {
      sendText(res, 400, 'PET_PACKAGE_DECODE_FAILED: data is required')
      return
    }
    try {
      const item = await importPetArchive(body.data, 'codex')
      sendJson(res, 200, item)
    }
    catch (error) {
      sendText(res, 422, error instanceof Error ? error.message : String(error))
    }
  },
}

/** POST /repository — 登记远端 GitHub 仓库宠物。 */
const importRepositoryRoute: Route = {
  method: 'POST',
  path: `${ROUTE_PREFIX}/repository`,
  async handle(req, res) {
    const body = await readJson<{ repository?: string }>(req, res)
    if (body === undefined)
      return
    if (typeof body.repository !== 'string') {
      sendText(res, 400, 'PET_REPOSITORY_INVALID: repository is required')
      return
    }
    try {
      const spec = await importPetRepository(fetch, body.repository)
      sendJson(res, 200, registerRemotePet(spec))
    }
    catch (error) {
      sendText(res, 422, error instanceof Error ? error.message : String(error))
    }
  },
}

/** PUT /repository — 更新一个已登记仓库宠物，返回新条目。 */
const updateRepositoryRoute: Route = {
  method: 'PUT',
  path: `${ROUTE_PREFIX}/repository`,
  async handle(req, res) {
    const body = await readJson<{ id?: string }>(req, res)
    if (body === undefined)
      return
    const id = typeof body.id === 'string' ? body.id : ''
    const entry = fullCatalog().find(item => item.id === id && item.remote)
    if (!entry) {
      sendText(res, 404, `PET_NOT_FOUND: preset ${id} is not registered`)
      return
    }
    try {
      const spec = await updatePetRepository(fetch, entry)
      sendJson(res, 200, replaceRemotePet(spec))
    }
    catch (error) {
      sendText(res, 422, error instanceof Error ? error.message : String(error))
    }
  },
}

/** DELETE /repository?id= — 反注册一个远端条目。 */
const deleteRepositoryRoute: Route = {
  method: 'DELETE',
  path: `${ROUTE_PREFIX}/repository`,
  handle(_req, res, url, ctx) {
    const id = (url.searchParams.get('id') ?? '').trim()
    try {
      unregisterRemotePet(id)
      sendJson(res, 200, runtimeStatus(ctx))
    }
    catch (error) {
      sendText(res, 404, error instanceof Error ? error.message : String(error))
    }
  },
}

/** GET /updates — 检查已登记仓库宠物是否有更新，返回 id 列表。 */
const updatesRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}/updates`,
  async handle(_req, res) {
    try {
      sendJson(res, 200, await checkPetUpdates(fetch, fullCatalog()))
    }
    catch (error) {
      sendText(res, 500, `PET_REPOSITORY_DOWNLOAD_FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

/**
 * DELETE /pet?id= — 删除宠物。
 *
 * - 预设 / 远端登记（无 `:`）：反注册远端条目；
 * - 来源限定 id（`chat:x` / `codex:x`）：删除该来源目录下的宠物目录。
 *
 * 回吐权威状态（与上游 `delete_pet` 一致）。
 */
const deletePetRoute: Route = {
  method: 'DELETE',
  path: `${ROUTE_PREFIX}/pet`,
  async handle(_req, res, url, ctx) {
    const id = (url.searchParams.get('id') ?? '').trim()
    try {
      if (id.includes(':')) {
        const { source, manifestId } = parseQualifiedId(id)
        const root = petsDir(source)
        const found = findPetDirectory(root, manifestId)
        if (!found)
          throw new Error(`PET_NOT_FOUND: pet ${id} was not found`)
        rmSync(found.directory, { recursive: true, force: true })
      }
      else {
        unregisterRemotePet(id)
      }
      sendJson(res, 200, runtimeStatus(ctx))
    }
    catch (error) {
      sendText(res, 404, error instanceof Error ? error.message : String(error))
    }
  },
}

/**
 * POST /open-external — 校验外链地址（仅 http/https）。
 *
 * 真正打开在消费端（Electron 窗口经 `pet:open-external`；纯浏览器侧用 `window.open`）。
 * 宿主这里只做地址校验与应答，不依赖宿主机是否有 GUI。
 */
const openExternalRoute: Route = {
  method: 'POST',
  path: `${ROUTE_PREFIX}/open-external`,
  async handle(req, res) {
    const body = await readJson<{ url?: string }>(req, res)
    if (body === undefined)
      return
    const value = typeof body.url === 'string' ? body.url : ''
    if (!/^https?:\/\/\S+$/u.test(value)) {
      sendText(res, 400, 'PET_URL_INVALID: only http(s) URLs are allowed')
      return
    }
    sendJson(res, 200, { ok: true, url: value })
  },
}

/**
 * GET /session/stream — 桌宠会话增量 SSE 流。
 *
 * 帧格式与上游逐字对齐：数据帧 / 心跳注释帧 / 状态作废注释帧 / 首帧 `retry`。
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

/**
 * GET /settings/stream — 设置变更 SSE 流（给已打开的桌宠窗口）。
 *
 * 帧格式与 `/session/stream` 一致（`data: <json>\n\n` + 心跳 + 首帧 `retry`），
 * 只是载荷是 `PetSettingsFrame`。接入时先推一帧当前状态：消费者永远不需要自己再
 * `GET /settings` 一次，也就不会出现「拿到的是旧值」的竞态。
 */
const settingsStreamRoute: Route = {
  method: 'GET',
  path: `${ROUTE_PREFIX}${SETTINGS_STREAM_PATH}`,
  handle(req, res, _url, ctx) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })

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
        if (!closed)
          res.write(`data: ${frame}\n\n`)
      },
      close(): void {
        finish()
        res.end()
      },
    }

    res.write('retry: 1000\n\n')
    detach = attachSettings(sink)
    // 首帧就是当前权威状态：接上即有值，不需要额外一次 GET。
    sink.push(JSON.stringify({ action: 'settings', payload: runtimeStatus(ctx) }))

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
  settingsStreamRoute,
  catalogRoute,
  patchRoute,
  assetRoute,
  fileRoute,
  configRoute,
  petsRoute,
  importRoute,
  importRepositoryRoute,
  updateRepositoryRoute,
  deleteRepositoryRoute,
  updatesRoute,
  deletePetRoute,
  openExternalRoute,
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
