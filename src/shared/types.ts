/**
 * shared/types.ts — 宿主 / 客户端 / Electron 桌宠窗口三端共享的协议形状。
 *
 * DTO 命名与 apps/desktop `bridge/pet.rs` 的 serde 结构逐字对应（snake_case），
 * 因此「复刻 Tauri 桌面端」意味着前端渲染层的字段访问代码可以原样保留。
 */

/** 桌宠能力状态（对应 Rust `PetStatus`）。 */
export interface PetStatus {
  active_pet: string
  enabled: boolean
  pet_size?: number | null
  /** 是否允许抛射（默认关闭）。 */
  throw_enabled: boolean
  visible: boolean
}

/** 前端可见的完整状态：Rust `PetStatus` + 本插件额外提供的桌面端可用性。 */
export interface PetRuntimeStatus extends PetStatus {
  /** 当前环境能否真的开一个独立置顶窗口（Electron 可解析且非纯浏览器）。 */
  desktop_supported: boolean
  /** 是否已打开独立窗口。 */
  desktop_open: boolean
}

/** 宠物来源：用户导入（chat）/ Codex 图集。 */
export type PetSource = 'chat' | 'codex'

/** 一份宠物清单条目（对应 Rust `list_pets` 投影）。 */
export interface PetListItem {
  description?: string
  id: string
  name: string
  source: PetSource
  kind?: 'dsh' | 'codex'
  thumbnail?: string
  thumbnail_type?: 'gif' | 'spritesheet'
}

/**
 * 预设宠物清单条目（`presets.json` 的 `pets.built-in` 展示层投影）。
 *
 * 与 dsh-pet-component 的 `<Pet>` props 一一对应：预设不下载、不安装，条目本身就是
 * 渲染参数，因此这里只声明渲染需要的字段。
 */
export interface PresetPetItem {
  config: string
  desc?: string | null
  ext?: { default: string, mac?: string } | null
  id: string
  image?: string | null
  kind?: 'dsh' | 'codex' | null
  name: string
  /** 是否由用户登记远端资源；内置预设为 false，只有登记来的条目可删除。 */
  remote?: boolean
  size?: number | null
  uri: { default: string, mac?: string }
}

/** 桌宠解析后的素材参数（对应 Rust `get_pet_asset` 的返回）。 */
export type PetAsset = {
  kind: 'codex'
  id: string
  spritesheet: string
  sprite_version_number: number
  columns: number
  rows: number
} | {
  kind: 'dsh'
  id: string
  config: string
  uri: { default: string, mac?: string }
  ext?: { default: string, mac?: string }
  size?: number
}

/** 三份清单聚合（一次请求拿齐，避免设置页并发四个命令）。 */
export interface PetCatalog {
  presetPets: PresetPetItem[]
  chatPets: PetListItem[]
  codexPets: PetListItem[]
  status: PetRuntimeStatus
}

/** 领域动作的统一结果（Action 原型）。 */
export type PetActionResult = { ok: true } | { ok: false, error: string }

/** 请求体：选择 / 启用 / 关闭 / 调整大小 / 抛射开关。 */
export interface PetPatch {
  active_pet?: string
  enabled?: boolean
  pet_size?: number
  throw_enabled?: boolean
}

/** 桌宠展示态（SSE 帧载荷）。 */
export interface PetSessionPayload {
  id: string
  origin?: 'subagent'
  title?: string
  displayTitle?: string
  name?: string
  description?: string
  message?: string
  status?: string
  activity?: string
  phase?: string
  running?: boolean
  pendingInteraction?: unknown
  pending?: readonly unknown[]
  lastAgentError?: string
  workStatus?: PetWorkStatus
  task?: string
  toolActivity?: PetToolActivity
  liveActivity?: {
    kind: string
    text?: string
    name?: string
    command?: string
    path?: string
    args?: string
  }
}

/**
 * 工作状态细分档位（对齐 dsh-pet 的 6 档枚举；索引 = config.jsonc
 * `animations.events.workStatus` 数组索引，勿在中间插入新档）。
 */
export type PetWorkStatus = 'thinking' | 'working' | 'result' | 'waiting' | 'success' | 'error'

/** 工具活动分类：气泡按分类选文案。 */
export type PetToolActivity = 'searching' | 'editing' | 'testing' | 'commanding' | 'using-tool'

/** 单个 SSE 消费者：只暴露「推一帧」与「结束连接」。 */
export interface SessionStreamSink {
  push: (frame: string) => void
  close: () => void
}
