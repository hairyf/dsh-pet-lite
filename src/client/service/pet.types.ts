/** 桌宠领域动作的统一结果（Action 原型）。 */
export type PetActionResult = { ok: true } | { ok: false, error: string }

/** DTO：宿主路由的请求/响应形状（invoke 层专属）。 */

export interface PetStatus {
  active_pet: string
  enabled: boolean
  pet_size?: number | null
  /** 是否允许抛射（默认关闭）。 */
  throw_enabled: boolean
  visible: boolean
  /** 当前环境能否真的开一个独立置顶窗口。 */
  desktop_supported?: boolean
  /** 是否已打开独立窗口。 */
  desktop_open?: boolean
}

export type PetSource = 'chat' | 'codex'

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
 * 预设不下载/安装：条目本身就是渲染参数，设置页只需要展示字段，因此这里只声明投影形状。
 */
export interface PresetPetItem {
  desc?: string | null
  id: string
  image?: string | null
  kind?: 'dsh' | 'codex' | null
  name: string
  /** 是否由用户登记远端资源；内置预设为 false，只有登记来的条目可删除。 */
  remote?: boolean
  size?: number | null
  /** 配置文件地址（dsh-pet `config.jsonc` / Codex `pet.json`）。 */
  config?: string
  /** 素材基地址。 */
  uri?: { default: string, mac?: string }
  ext?: { default: string, mac?: string } | null
}
