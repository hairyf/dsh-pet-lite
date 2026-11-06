/**
 * client/sdk.ts — 边界自适配层（`dsh-tauri/client` 的同形最小子集）。
 *
 * 上游 `builtin-plugin-pet` 的客户端代码写在 **dsh-tauri 客户端 SDK** 之上：`invoke()`
 * 调 Tauri 命令、`defineRegister()` 拿注册控制器、`defineStore()` 建域存储、
 * `defineLocale()` 建双语文案、`useStore`/`useWatchImmediate` 读状态。那套 SDK 属于
 * desktop monorepo 的未发布 workspace 包（`dsh-tauri@1.0.0`），公开 npm 上没有。
 *
 * 本文件提供同形子集，让上游组件与服务函数**逐字保留**：
 *
 * | 上游 SDK              | 这里                                                    |
 * | --------------------- | ------------------------------------------------------- |
 * | `invoke(cmd, args)`   | 映射成 `${ROUTE_PREFIX}/*` 的 HTTP 调用（表见 `INVOKE`）  |
 * | `isTauri()`           | 恒 true —— 能加载本插件就说明宿主 HTTP 可用               |
 * | `defineLocale(ns, d)` | `ctx.locale.register(ns, lang, dict)`，`text(key)` 取词  |
 * | `defineStore({...})`  | 快照存储：`$state` / `useStore` / 动作即方法              |
 * | `defineRegister(fn)`  | 包一层官方 `ctx.slots.register` + effect 生命周期         |
 * | `cn()`                | clsx 语义的类名合并                                       |
 *
 * 业务语义一行没改：命令名、参数、DTO、错误文案、加载态、`beginFetch`/`commitFetch`
 * 的竞态轮次、菜单补丁的 DOM 契约、草稿注入的二次触发语义，全部来自上游。被替换的只有
 * **宿主边界的传输与注册机制**。
 */

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { PLUGIN_ID, ROUTE_PREFIX } from '../shared/constants'

export { useSyncExternalStore }

// --- transport ---------------------------------------------------------

/**
 * 命令 → HTTP 映射。未列出的命令一律拒绝，绝不静默返回空值 —— 半工作状态的宠物比
 * 明确报错更难排查。
 */
interface InvokeSpec {
  path: string
  method: 'GET' | 'PUT'
}

const INVOKE: Record<string, InvokeSpec> = {
  get_pet_status: { path: '/settings', method: 'GET' },
  list_pet_catalog: { path: '/catalog', method: 'GET' },
  set_pet_enabled: { path: '/settings', method: 'PUT' },
  set_active_pet: { path: '/settings', method: 'PUT' },
  set_pet_size: { path: '/settings', method: 'PUT' },
  set_pet_throw_enabled: { path: '/settings', method: 'PUT' },
  get_pet_asset: { path: '/asset', method: 'GET' },
}

/** PUT 请求体：只映射设置类命令。 */
function bodyFor(command: string, args: Record<string, unknown> | undefined): unknown {
  if (!args)
    return {}
  switch (command) {
    case 'set_pet_enabled':
      return { enabled: args.enabled }
    case 'set_active_pet':
      return { active_pet: args.id }
    case 'set_pet_size':
      return { pet_size: args.size }
    case 'set_pet_throw_enabled':
      return { throw_enabled: args.enabled }
    default:
      return {}
  }
}

/** GET 查询串（目前只有素材解析带参数）。 */
function queryFor(command: string, args: Record<string, unknown> | undefined): string {
  if (command === 'get_pet_asset' && args && typeof args.id === 'string')
    return `?id=${encodeURIComponent(args.id)}`
  return ''
}

/**
 * 调宿主路由并反序列化结果。
 *
 * 语义与 Tauri `invoke` 对齐：4xx/5xx 当失败抛出，错误体是纯文本 `PET_*` 文案
 * （调用方的 `guard` 会把它投影成可展示文本）。
 */
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const spec = INVOKE[command]
  if (!spec)
    throw new Error(`PET_UNSUPPORTED_COMMAND: ${command}`)

  const url = `${ROUTE_PREFIX}${spec.path}${spec.method === 'GET' ? queryFor(command, args) : ''}`
  const response = await fetch(url, {
    method: spec.method,
    headers: spec.method === 'PUT' ? { 'content-type': 'application/json' } : undefined,
    body: spec.method === 'PUT' ? JSON.stringify(bodyFor(command, args)) : undefined,
    cache: 'no-store',
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text.trim() || `PET_REQUEST_FAILED: ${command} (${response.status})`)
  }
  if (response.status === 204)
    return undefined as T
  return (await response.json()) as T
}

/** 载体判定：能加载本插件的客户端即具备宿主 HTTP 能力。 */
export function isTauri(): boolean {
  return true
}

// --- style -------------------------------------------------------------

/** 类名合并（clsx 语义：字符串原样、假值丢弃、数组/对象递归）。 */
export function cn(...values: Array<string | false | null | undefined | Array<string | false | null | undefined>>): string {
  const out: string[] = []
  for (const value of values) {
    if (!value)
      continue
    if (Array.isArray(value))
      out.push(cn(...value))
    else
      out.push(value)
  }
  return out.filter(Boolean).join(' ')
}

// --- locale ------------------------------------------------------------

/** 客户端 locale 服务的最小读取面（官方 `ctx.locale`）。 */
export interface LocaleRuntimeLike {
  register: (namespace: string, locale: string, dict: Record<string, string>) => () => void
  getLocale: () => { active: string }
  subscribe: (onChange: () => void) => () => void
}

export interface LocaleHandle<K extends string> {
  /** 当前语言下的取词。 */
  text: (key: K) => string
  /** 组件侧订阅语言切换（触发重渲染）。 */
  useLocale: () => void
}

/**
 * 双语字典注册（对应上游 `defineLocale(PLUGIN_ID, { zh, en })`）。
 *
 * 直接落到官方 `ctx.locale.register`：`zh` 键集合是权威，`en` 缺键即编译错误
 * （由调用方的类型标注承担）。
 */
export function defineLocale<K extends string>(
  namespace: string,
  dicts: { zh: Record<K, string>, en: Record<K, string> },
): LocaleFeature<K> {
  let active = 'en'
  const listeners = new Set<() => void>()

  const text = (key: K): string => (active === 'zh' ? dicts.zh[key] : dicts.en[key]) ?? String(key)

  function useLocale(): void {
    useSyncExternalStore(
      (onChange: () => void) => {
        listeners.add(onChange)
        return () => listeners.delete(onChange)
      },
      () => active,
      () => active,
    )
  }

  const handle: LocaleFeature<K> = {
    text,
    useLocale,
    /** 由 `apply` 在拿到 ctx.locale 后调用一次（登记字典并跟随语言切换）。 */
    attach(locale: LocaleRuntimeLike | undefined): () => void {
      const target = locale
      if (!target)
        return () => {}
      const disposers = [
        target.register(namespace, 'zh', dicts.zh as Record<string, string>),
        target.register(namespace, 'en', dicts.en as Record<string, string>),
      ]
      active = target.getLocale().active
      const unsubscribe = target.subscribe(() => {
        active = target.getLocale().active
        for (const listener of listeners)
          listener()
      })
      return () => {
        unsubscribe()
        for (const disposer of disposers)
          disposer()
      }
    },
  }
  return handle
}

/** `defineLocale` 句柄的完整形状（含 attach）。 */
export type LocaleFeature<K extends string> = LocaleHandle<K> & { attach: (locale: LocaleRuntimeLike | undefined) => () => void }

// --- store 读取面 -------------------------------------------------------

/**
 * 组件侧读取域状态。
 *
 * 上游写法是 `useStore(store.pet)`（valtio-define 的域存储）；本插件的 store 由官方
 * `@deepseek-ai/dsh-client-store` 承载，读取面收敛在 `store.pet` 门面上，因此这里只做
 * 一次转发转发，签名保持兼容（第一个参数是域句柄，忽略）。
 */
/**
 * 组件侧读取域状态。
 *
 * 上游写法是 `useStore(store.pet)`（valtio-define 的域存储）；本插件的 store 由官方
 * `@deepseek-ai/dsh-client-store` 承载，读取面收敛在 `store.pet` 门面上，因此这里只做
 * 一次转发，签名保持兼容（参数是域句柄）。
 *
 * 返回类型直接从门面的 `useStore` 取得，避免调用点退化成 unknown。
 */
export function useStore<F extends { useStore: () => unknown }>(facade: F): ReturnType<F['useStore']> {
  return facade.useStore() as ReturnType<F['useStore']>
}

/**
 * 某个值变化时立即重跑（对应上游 `useWatchImmediate`）。
 *
 * 上游语义：立即执行一次，之后每次 `value` 变化再执行。这里用 `useEffect` + 值比较
 * 实现同一契约（引用/原始值不同即触发）。
 */
export function useWatchImmediate<T>(value: T, listener: (next: T) => void): void {
  const previous = useRef<T>(value)
  useEffect(() => {
    if (Object.is(previous.current, value))
      return
    previous.current = value
    listener(value)
  }, [value, listener])
}

// --- register ----------------------------------------------------------

/** 注册控制器：`add` 登记生命周期，`listen`/`observe` 包一层 DOM 订阅。 */
export interface RegisterController {
  add: (disposer: (() => void) | void) => void
  listen: <K extends keyof WindowEventMap>(
    type: K,
    handler: (event: WindowEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) => void
  observe: (target: Node, handler: () => void, options?: MutationObserverInit) => void
}

/** 客户端 adapter 的最小读取面（官方 sessions / workspaces 投影）。 */
export interface ClientAdapter {
  sessions: { list?: { getSnapshot: () => unknown }, open?: (id: string) => void }
  workspaces: {
    list?: { getSnapshot: () => unknown }
    connectWorkspace?: (id: string) => Promise<string>
  }
}

/** 客户端 ctx 的最小读取面（官方服务 + slots）。 */
export interface ClientContext {
  slots: {
    /** `inject` 把注册挂到「槽位声明就绪」上（返回 disposer）。 */
    inject: (name: string, factory: () => (() => void) | void) => (() => void) | void
    register: (options: Record<string, unknown>, component: unknown) => () => void
  }
  locale?: LocaleRuntimeLike
  sessions?: ClientAdapter['sessions']
  workspaces?: ClientAdapter['workspaces']
  effect: (execute: () => () => void, label?: string) => unknown
}

/**
 * 把一个「注册函数」包成带生命周期的 feature。
 *
 * 上游 `defineRegister((controller, ctx, adapter) => …)` 由 dsh-tauri 提供；这里把同一
 * 形状落到官方 `ctx.slots.register`：`controller.add` 收集的 disposer 由调用方统一回收。
 * 业务代码（注册选项、组件、inject 面）逐字不变。
 */
export function defineRegister(
  setup: (controller: RegisterController, ctx: ClientContext, adapter: ClientAdapter) => void,
): (ctx: ClientContext, adapter: ClientAdapter) => () => void {
  return (ctx, adapter) => {
    const disposers: Array<() => void> = []
    const controller: RegisterController = {
      add: (disposer) => {
        if (typeof disposer === 'function')
          disposers.push(disposer)
      },
      listen: (type, handler, options) => {
        window.addEventListener(type, handler as EventListener, options)
        disposers.push(() => window.removeEventListener(type, handler as EventListener, options))
      },
      observe: (target, handler, options) => {
        const observer = new MutationObserver(handler)
        observer.observe(target, options)
        disposers.push(() => observer.disconnect())
      },
    }
    setup(controller, ctx, adapter)
    return () => {
      for (const disposer of disposers.splice(0))
        disposer()
    }
  }
}

/** 插件显示名（诊断元数据）。 */
export const PLUGIN_NAME = PLUGIN_ID
