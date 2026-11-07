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

/**
 * 「显示主界面」用的 deep link（与官方桌面端同一个协议）。
 *
 * 官方桌面端在 `desktop/deep_link.rs` 里注册并处理它，`is_open_request` **精确匹配**
 * `dsh://open` 与 `dsh://open/`（带 query 不认）。这里只发这一个固定串，不做任何拼接。
 *
 * 夜间版注册的是 `dsh-nightly`；两者不共存于同一台机器的默认处理器，因此这里取正式版，
 * 夜间版宿主下该项会由宿主返回的 `open_url` 覆盖。
 */
export const DESKTOP_OPEN_URL = 'dsh://open'

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

/**
 * 设置变更推送流：设置页改选择 / 大小 / 抛射后，宿主在这里把**权威状态**推给已开的桌宠窗口。
 *
 * 【为什么必须有】窗口只在挂载时 `GET /settings` 一次。没有这条流，设置页改完大小、换个
 * 宠物、关掉抛射，已经开着的窗口一无所知 —— 表现就是「滑条拖了宠物不变」。
 *
 * 单独一条流而不是塞进 `/session/stream`：后者是**会话增量**（reducer 逐字复刻上游），
 * 混进设置帧会让那份契约漂移。
 */
export const SETTINGS_STREAM_PATH = '/settings/stream'

// --- 窗口几何（主进程与渲染端必须用同一组数字） -------------------------
//
// 作用域：像素 / DIP。`runtime/electron-helper/main.cjs` 是纯 CJS、不经构建，
// 因此那边重复写一遍同值常量（带注释指回本文件），改动时必须同步。

/** 宠物基准渲染宽度（px，100% 档位）。 */
export const PET_BASE_WIDTH = 200
/**
 * 窗口最小宽度（px）：保证气泡读得清。
 *
 * 与上游 `apps/desktop/src/pet/constants.ts` 的 `PET_BUBBLE_MIN_WIDTH` 同义 —— 宠物缩到
 * 50% 时若窗口也跟着收到 200px 宽，气泡会被压成两行甚至被裁，索性给窗口一个下限。
 */
export const PET_BUBBLE_MIN_WIDTH = 420
/** 宠物包围盒宽高比（dsh-pet 画布 640×360）。 */
export const PET_ASPECT = 9 / 16
/** 窗口左右与下方留白（px，100% 档位）。 */
export const PET_WINDOW_MARGIN = 48
/**
 * 窗口上方留白（px，100% 档位）：**气泡画布**。
 *
 * 气泡层挂在宠物头顶（`.dsh-pet__bubbles--top` 的 `bottom: calc(100% - size*0.108)`），
 * 最多堆 3 条。窗口只有 48px 上边距时，气泡会被窗口裁掉 —— 这就是「气泡不出现」的
 * 第二个原因（第一个是从没调用过 `pet.bubble`）。120px 恰好够 200% 档位下的三条。
 */
export const PET_BUBBLE_HEADROOM = 120
