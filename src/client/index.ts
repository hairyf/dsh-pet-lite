import type { ClientAdapter, ClientContext } from './sdk'
import { PLUGIN_ID } from '../shared/constants'
import { PetSettings } from './components/pet-settings'
import { locale } from './locales'
import { petOverlayFeature } from './register/pet-overlay'
import { petSectionFeature } from './register/pet-section'
import { prefillFeature } from './register/prefill'
import { settingsMenuFeature } from './register/settings-menu'
import { loadPetCatalog } from './service/pet'
import { mountPetStore, unmountPetStore } from './store'

/**
 * 客户端半侧（client half）。
 *
 * 与上游 `builtin-plugin-pet/src/client/index.ts` 同构：安装文案，注册设置分区、设置
 * 菜单项与草稿注入。差异只在边界（见 `client/sdk.ts` 与 `client/ui.tsx` 的说明）。
 */

export const name = PLUGIN_ID

/** 需要的客户端服务：slots（槽位注册）、locale（双语文案）、sessions/workspaces（新建会话）。 */
export const inject = ['slots', 'locale', 'sessions', 'workspaces']

/**
 * 插件体。
 *
 * 生命周期顺序是有意为之：
 *   1. 先挂 store（后续所有注册与服务都要读它）；
 *   2. 再注册文案（菜单补丁与设置页的 label 都取词）；
 *   3. 最后注册三个 feature —— 它们各自包了 `slots.inject`，槽位声明出现才真正生效。
 */
export function apply(ctx: ClientContext): void {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return

  // 官方 `@deepseek-ai/dsh-client-store` 的 handle 必须在 apply 世界里构造。
  mountPetStore()

  const adapter: ClientAdapter = {
    sessions: {
      list: ctx.sessions?.list,
      open: ctx.sessions?.open,
    },
    workspaces: {
      list: ctx.workspaces?.list,
      connectWorkspace: ctx.workspaces?.connectWorkspace,
    },
  }

  ctx.effect(() => locale.attach(ctx.locale), `${PLUGIN_ID}: locale`)
  ctx.effect(() => petSectionFeature(ctx, adapter), `${PLUGIN_ID}: settings section`)
  // 应用内浮层：浏览器里没有独立窗口，宠物挂在壳层的全屏浮层席位上。
  ctx.effect(() => petOverlayFeature(ctx, adapter), `${PLUGIN_ID}: in-app overlay`)
  ctx.effect(() => settingsMenuFeature(ctx, adapter), `${PLUGIN_ID}: settings menu items`)
  ctx.effect(() => prefillFeature(ctx, adapter), `${PLUGIN_ID}: conversation prefill`)

  // 首屏装载：分区挂载前把状态与预设拿齐（幂等；失败由设置页展示）。
  ctx.effect(() => {
    void loadPetCatalog()
    return () => unmountPetStore()
  }, `${PLUGIN_ID}: catalog bootstrap`)
}

/** 供测试与外部读取的组件引用。 */
export { PetSettings }
