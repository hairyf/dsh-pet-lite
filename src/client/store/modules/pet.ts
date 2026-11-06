import type { BakedActions, StoreInstance } from '@deepseek-ai/dsh-client-store'
import type { PetListItem, PetStatus, PresetPetItem } from '../../service/pet.types'
import { defineStore } from '@deepseek-ai/dsh-client-store'
import { useSyncExternalStore } from 'react'

/**
 * store/modules/pet.ts — 桌宠域状态。
 *
 * 容器使用官方 `@deepseek-ai/dsh-client-store`：`defineStore({ init, actions })` 产出
 * store handle，`.create()` 产出活体实例（`getSnapshot` / `subscribe` / 烘焙后的
 * `actions`）。所有写操作都是 **draft mutator**，组件只能经由这些动作写 —— 这是官方
 * store 的审计面，不额外暴露 `set`/`update`。
 *
 * 为什么再包一层 `$state` / `useStore()`：上游 `builtin-plugin-pet` 的调用点分布在整个
 * 设置页、服务层与菜单补丁里（`store.pet.setStatus(...)`、`useStore(store.pet)`、
 * `store.pet.$state.status`）。这一层只是**读取面适配**，语义一一映射到官方实例：
 *
 * | 上游读取面          | 官方实例                                        |
 * | ------------------- | ----------------------------------------------- |
 * | `store.pet.$state`  | `instance.getSnapshot()`（只读快照）             |
 * | `useStore(...)`     | `useSyncExternalStore(subscribe, getSnapshot)`   |
 * | `store.pet.xxx()`   | `instance.actions.xxx(...)`（draft mutator 烘焙） |
 */

/** 域状态形状。 */
export interface PetState {
  /** 最近一次从宿主读回的桌宠状态缓存。 */
  status: PetStatus | null
  /** 状态拉取轮次：只有最新一轮允许写回首屏快照。 */
  fetchRevision: number
  /** 清单是否装载过（设置页首屏加载态判定）。 */
  catalogLoaded: boolean
  presetPets: PresetPetItem[]
  petUpdates: string[]
  chatPets: PetListItem[]
  codexPets: PetListItem[]
  /** 待注入的新会话草稿（sessionId → 文本）。 */
  prefills: Record<string, string>
  /** 当前环境能否让桌宠窗口置顶并定位；`null` 为尚未读取。 */
  overlaySupported: boolean | null
  /** 「强制 XWayland」开关的持久值；`null` 为尚未读取。 */
  forceXwayland: boolean | null
}

/** 官方动作表：全部是 draft mutator（唯一的写入口）。 */
const actions = {
  bumpRevision(draft: PetState): void {
    draft.fetchRevision += 1
  },
  writeStatus(draft: PetState, status: PetStatus | null): void {
    draft.status = status
  },
  clearStatus(draft: PetState): void {
    draft.fetchRevision += 1
    draft.status = null
  },
  writeCatalog(draft: PetState, input: { presets: PresetPetItem[], chat: PetListItem[], codex: PetListItem[] }): void {
    draft.presetPets = input.presets
    draft.chatPets = input.chat
    draft.codexPets = input.codex
    draft.catalogLoaded = true
  },
  writePresetPets(draft: PetState, list: PresetPetItem[]): void {
    draft.presetPets = list
  },
  writeCodexPets(draft: PetState, list: PetListItem[]): void {
    draft.codexPets = list
  },
  writePetUpdates(draft: PetState, ids: string[]): void {
    draft.petUpdates = ids
  },
  replacePresetPet(draft: PetState, item: PresetPetItem): void {
    draft.presetPets = draft.presetPets.map(pet => (pet.id === item.id ? item : pet))
    draft.petUpdates = draft.petUpdates.filter(id => id !== item.id)
  },
  removePet(draft: PetState, id: string): void {
    draft.presetPets = draft.presetPets.filter(item => item.id !== id)
    draft.petUpdates = draft.petUpdates.filter(item => item !== id)
    draft.chatPets = draft.chatPets.filter(item => item.id !== id)
    draft.codexPets = draft.codexPets.filter(item => item.id !== id)
  },
  writeOverlaySupported(draft: PetState, supported: boolean): void {
    draft.overlaySupported = supported
  },
  writeForceXwayland(draft: PetState, enabled: boolean): void {
    draft.forceXwayland = enabled
  },
  writePrefill(draft: PetState, sessionId: string, text: string): void {
    draft.prefills[sessionId] = text
  },
  dropPrefill(draft: PetState, sessionId: string): void {
    delete draft.prefills[sessionId]
  },
  clearPrefills(draft: PetState): void {
    draft.prefills = {}
  },
}

/**
 * store handle。
 *
 * 官方文档要求 handle 在 `apply` 世界里构造、不要模块级导出（模块缓存身份是伪单例）。
 * 因此 handle 由 `createPetStoreHandle()` 每次插件装载时新建，实例再交给 `attach()`。
 */
export function createPetStoreHandle(): ReturnType<typeof defineStore<PetState, typeof actions>> {
  return defineStore<PetState, typeof actions>({
    init: (): PetState => ({
      status: null,
      fetchRevision: 0,
      catalogLoaded: false,
      presetPets: [],
      petUpdates: [],
      chatPets: [],
      codexPets: [],
      prefills: {},
      overlaySupported: null,
      forceXwayland: null,
    }),
    actions,
  })
}

type PetInstance = StoreInstance<PetState, typeof actions>

/** 上游读取面（服务层与组件共用）。 */
export interface PetStoreFacade {
  readonly $state: PetState
  /** 官方实例（注册 store 席位时传给 slots）。 */
  readonly instance: PetInstance
  /** 组件侧读取整份快照（上游 `useStore(store.pet)` 的返回形状）。 */
  useStore: () => PetState
  beginFetch: () => number
  commitFetch: (revision: number, status: PetStatus) => boolean
  setStatus: (status: PetStatus | null) => void
  setCatalog: (input: { presets: PresetPetItem[], chat: PetListItem[], codex: PetListItem[] }) => void
  setOverlaySupported: (supported: boolean) => void
  setForceXwayland: (enabled: boolean) => void
  setPresetPets: (list: PresetPetItem[]) => void
  setPetUpdates: (ids: string[]) => void
  replacePresetPet: (item: PresetPetItem) => void
  setCodexPets: (list: PetListItem[]) => void
  removePet: (id: string) => void
  setPrefill: (sessionId: string, draft: string) => void
  takePrefill: (sessionId: string) => string | undefined
  clearPrefills: () => void
}

/** 把官方实例包成上游读取面。 */
export function createPetStoreFacade(instance: PetInstance): PetStoreFacade {
  const a: BakedActions<PetState, typeof actions> = instance.actions

  const facade: PetStoreFacade = {
    get $state() {
      return instance.getSnapshot()
    },
    instance,
    useStore(): PetState {
      return useSyncExternalStore(instance.subscribe, instance.getSnapshot, instance.getSnapshot)
    },
    beginFetch(): number {
      a.bumpRevision()
      return instance.getSnapshot().fetchRevision
    },
    commitFetch(revision, status): boolean {
      // 过期轮次直接丢弃：并发时旧响应不得覆盖新状态。
      if (revision !== instance.getSnapshot().fetchRevision)
        return false
      a.writeStatus(status)
      return true
    },
    setStatus(status): void {
      // 覆写状态并推进轮次（使在途的旧拉取失效）。
      a.bumpRevision()
      a.writeStatus(status)
    },
    setCatalog(input): void {
      a.writeCatalog(input)
    },
    setOverlaySupported(supported): void {
      a.writeOverlaySupported(supported)
    },
    setForceXwayland(enabled): void {
      a.writeForceXwayland(enabled)
    },
    setPresetPets(list): void {
      a.writePresetPets(list)
    },
    setPetUpdates(ids): void {
      a.writePetUpdates(ids)
    },
    replacePresetPet(item): void {
      a.replacePresetPet(item)
    },
    setCodexPets(list): void {
      a.writeCodexPets(list)
    },
    removePet(id): void {
      a.removePet(id)
    },
    setPrefill(sessionId, text): void {
      a.writePrefill(sessionId, text)
    },
    takePrefill(sessionId): string | undefined {
      const value = instance.getSnapshot().prefills[sessionId]
      if (value === undefined)
        return undefined
      a.dropPrefill(sessionId)
      return value
    },
    clearPrefills(): void {
      a.clearPrefills()
    },
  }
  return facade
}
