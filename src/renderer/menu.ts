/**
 * renderer/menu.ts — 桌宠右键菜单。
 *
 * 两项，语义与 Tauri 桌面端的 `pet_show_context_menu` 对齐：
 *
 * - **显示主界面** → 打开宿主返回的 `openUrl`（官方桌面端是 `dsh://open`）。
 *   走系统协议而不是自己找窗口，是因为官方桌面端已经注册并处理了它
 *   （`desktop/deep_link.rs` 里 `is_open_request` 精确匹配 `dsh://open`），
 *   我们照同一个协议发就能唤起它；网页端则由宿主返回自己的地址。
 *
 * - **关闭宠物** → 调内部的 `set_pet_enabled(false)` 等价动作（PUT `/settings`），
 *   持久化成「关闭」。宿主随即注销窗口，和设置页里点「关闭宠物」是同一条路径。
 *
 * 用 Electron 原生菜单（主进程 `Menu.popup`）而不是窗口内自绘 DOM：
 * 窗口是点击穿透的，自绘菜单还得额外维护一整块命中区；原生菜单三平台一致，
 * 也不会被窗口边界裁掉。
 */

export interface PetMenuItem {
  id: string
  label: string
}

/** 菜单项定义（文案与 Tauri 桌面端同一组，见 `config::i18n::t("pet.show_main_window"/"pet.close")`）。 */
export const MENU_ITEMS: readonly PetMenuItem[] = [
  { id: 'show-main-window', label: '显示主界面' },
  { id: 'close-pet', label: '关闭宠物' },
]

/** 触屏/鼠标右键判定：button === 2 或显式 contextmenu 事件。 */
export function isContextMenuTrigger(event: { button?: number }): boolean {
  return event.button === 2
}
