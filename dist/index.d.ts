import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
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
declare const inject: string[];
declare const name = "dsh-pet-lite";
declare function apply(ctx: Context): void;
//#endregion
export { apply, inject, name };