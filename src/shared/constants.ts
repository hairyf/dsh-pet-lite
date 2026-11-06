/**
 * dsh-pet-lite — 插件名与协议常量。
 *
 * `PLUGIN_ID` 同时是 Cordis 补丁项 id、locale 命名空间与诊断标签。
 * 路由路径同时被三端消费：宿主 HTTP、应用内浮层、Electron 桌宠窗口。
 */

export const PLUGIN_ID = 'dsh-pet-lite'

/** 桌宠业务路由前缀（与 apps/desktop `bridge/pet.rs` 的 ROUTE_PREFIX 同形）。 */
export const ROUTE_PREFIX = '/dsh-pet-lite'

/** 会话增量 SSE 流：`${ROUTE_PREFIX}${SESSION_STREAM_PATH}`。 */
export const SESSION_STREAM_PATH = '/session/stream'

/** 统一设置读取 / 写入。 */
export const SETTINGS_PATH = '/settings'

/** 预设 / Chat / Codex 三份清单。 */
export const CATALOG_PATH = '/catalog'

/** 素材与配置代理（预设宠物直连远端、本地宠物读盘）。 */
export const ASSET_PATH = '/asset'

/** SSE 心跳注释帧间隔（毫秒）。 */
export const SSE_KEEPALIVE_MS = 15_000

/** SSE 首帧重连提示（毫秒）。 */
export const SSE_RETRY_MS = 1000

/**
 * 「宿主累计态已丢弃」注释帧文本。
 *
 * 与 apps/desktop `bridge/pet.rs` 同名常量逐字一致：宿主只在**最后一个**消费者断开时
 * 丢弃逐会话累计态，因此新消费者接入时若已无其他消费者，任何已展示的气泡都作废。
 */
export const SSE_STATE_LOST_COMMENT = 'state-lost'

/** 桌宠大小百分比缺省值与合法区间（与设置页滑条一致）。 */
export const PET_DEFAULT_SIZE = 100
export const PET_SIZE_MIN = 50
export const PET_SIZE_MAX = 200
export const PET_SIZE_STEP = 5
