import type { Context } from '@deepseek-ai/cordis'
// 类型侧需要这两条 side-effect 导入：`ctx.webServer` / `ctx.sessions` 的 Context 增强
// 由它们各自的包声明，不导入则 tsc 看不到。
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RouteContext } from './host/routes'
import { ensureElectronDownload, hasGraphicalDisplay, HelperProcess, resolveElectronPath } from './host/electron-runtime'
import { matchRoute, notFound } from './host/routes'
import { attachHost } from './host/session-stream'
import { snapshot } from './host/store'
import { PLUGIN_ID, ROUTE_PREFIX } from './shared/constants'

/**
 * 宿主半侧（host half）—— 插件后端。
 *
 * 与 apps/desktop `packages/builtin-plugin-pet/src/index.ts` 同一套职责：
 *   - 在宿主 WebServer 上注册 `${ROUTE_PREFIX}/*` 业务路由（设置 / 清单 / 素材 / SSE）；
 *   - 把「会话活动」状态化重建后经 SSE 发布给消费端；
 *   - 按需拉起 / 守护 Electron 桌宠窗口。
 *
 * 差异：上游把窗口开合交给 Rust（Tauri `invoke` 命令），本插件自己拉起 Electron 进程。
 */

/** 需要的宿主服务：webServer（路由）、sessions（会话总线）、workspaceRegistry（归档集合）。 */
export const inject = ['webServer', 'sessions', 'workspaceRegistry']

export const name = PLUGIN_ID

export function apply(ctx: Context): void {
  // 会话总线读取面：`on` 订阅事件、`get` 惰性取服务、归档集合判定。
  attachHost(ctx as never)

  let helper: HelperProcess | undefined
  let desktopOpen = false

  /** 当前环境能否真的开一个独立窗口（纯浏览器访问时为 false）。 */
  const desktopSupported = (): boolean => hasGraphicalDisplay() && resolveElectronPath() !== undefined

  /** 当前监听端口对应的本机 origin（素材 / 配置路由拼本机地址用）。 */
  const origin = (): string => `http://127.0.0.1:${ctx.webServer.port ?? 0}`

  const openDesktop = async (): Promise<void> => {
    if (desktopOpen)
      return
    if (!desktopSupported())
      throw new Error('PET_DESKTOP_UNAVAILABLE: no usable Electron runtime')
    const port = ctx.webServer.port ?? 0
    if (!port || port <= 0)
      throw new Error('PET_WEB_PORT_UNAVAILABLE: web server is not listening yet')
    const electronPath = await ensureElectronDownload() ?? resolveElectronPath()
    if (!electronPath)
      throw new Error('PET_DESKTOP_UNAVAILABLE: no usable Electron runtime')
    const process_ = new HelperProcess(
      {
        electronPath,
        env: {
          // 与上游同一组注入：窗口从宿主拿成品配置，不自己解析磁盘。
          DSH_PET_LITE_ORIGIN: `http://127.0.0.1:${port}`,
          DSH_PET_LITE_CONFIG_URL: `http://127.0.0.1:${port}${ROUTE_PREFIX}/catalog`,
        },
      },
      {
        debug: message => ctx.logger?.debug?.(message),
        error: message => ctx.logger?.error?.(message),
        info: message => ctx.logger?.info?.(message),
        warn: message => ctx.logger?.warn?.(message),
      },
    )
    process_.start()
    helper = process_
    desktopOpen = true
  }

  const closeDesktop = async (): Promise<void> => {
    if (!desktopOpen)
      return
    helper?.stop('settings-change')
    helper = undefined
    desktopOpen = false
  }

  const routeContext: RouteContext = {
    get desktopSupported() {
      return desktopSupported()
    },
    get desktopOpen() {
      return desktopOpen
    },
    setDesktop: async (open) => {
      if (open)
        await openDesktop()
      else
        await closeDesktop()
    },
    get origin() {
      return origin()
    },
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const route = matchRoute(req.method ?? 'GET', url.pathname)
        if (!route) {
          notFound(res, url.pathname)
          return
        }
        try {
          await route.handle(req, res, url, routeContext)
        }
        catch (error) {
          if (!res.headersSent)
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`PET_ROUTE_FAILED: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })
    return () => {
      dispose()
      attachHost(undefined)
      void closeDesktop()
      helper = undefined
    }
  }, `${PLUGIN_ID}: routes`)

  // 启动时把「上次退出前是启用态」的桌宠拉起来。
  ctx.effect(() => {
    const status = snapshot({ desktopSupported: desktopSupported(), desktopOpen: false })
    if (status.enabled && status.active_pet !== '' && status.desktop_supported) {
      void openDesktop().catch((error: unknown) => {
        ctx.logger?.warn?.(`dsh-pet-lite: desktop window not opened: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return () => {
      void closeDesktop()
    }
  }, `${PLUGIN_ID}: desktop lifecycle`)
}
