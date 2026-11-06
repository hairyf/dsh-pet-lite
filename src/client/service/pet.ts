import type { ClientAdapter } from '../sdk'
import type { PetActionResult, PetListItem, PetStatus, PresetPetItem } from './pet.types'
import {
  CMD_DELETE_PET,
  CMD_GET_PET_STATUS,
  CMD_IMPORT_PET,
  CMD_IMPORT_PET_REPOSITORY,
  CMD_LIST_PETS,
  CMD_LIST_PRESET_PETS,
  CMD_OPEN_EXTERNAL_URL,
  CMD_SET_ACTIVE_PET,
  CMD_SET_PET_ENABLED,
  CMD_SET_PET_SIZE,
  CMD_SET_PET_THROW_ENABLED,
  CMD_UPDATE_PET_REPOSITORY,
  PET_COMMUNITY_URL,
  PET_HATCH_PROMPT,
} from '../constants'
import { invoke } from '../sdk'
import { store } from '../store'
import { chooseWorkspace, messageOf } from './pet.utils'

/**
 * service/pet.ts — 桌宠领域服务。
 *
 * 与上游逐字同构：两种原型 Query（`load*`，只读数据并更新 store）与 Action（领域动词，
 * 响应用户意图并更新 store）；无模块级可变状态、无副作用生命周期。
 *
 * 边界差异：上游经 `invoke` 调 Tauri 命令，本插件的 `invoke` 映射到宿主 HTTP 路由
 * （见 `client/sdk.ts` 的 INVOKE 表）。命令名与 DTO 保持不变，因此调用点无需改写。
 */

async function guard(label: string, action: () => Promise<PetActionResult>): Promise<PetActionResult> {
  try {
    return await action()
  }
  catch (error) {
    console.error(`[dsh-pet-lite] ${label} failed:`, error)
    return { ok: false, error: messageOf(error) }
  }
}

/** Query：拉取桌宠状态快照；按轮次提交，过期响应不覆盖新状态。 */
export async function loadPetStatus(): Promise<PetStatus | null> {
  const revision = store.pet.beginFetch()
  try {
    const status = await invoke<PetStatus>(CMD_GET_PET_STATUS)
    store.pet.commitFetch(revision, status)
    return status
  }
  catch (error) {
    console.error('[dsh-pet-lite] load pet status failed:', error)
    return null
  }
}

/** Query：装载预设清单，并顺带刷新共享状态快照。 */
export async function loadPetCatalog(): Promise<PetActionResult> {
  const revision = store.pet.beginFetch()
  return guard('load pet catalog', async () => {
    const catalog = await invoke<{
      presetPets: PresetPetItem[]
      chatPets: PetListItem[]
      codexPets: PetListItem[]
      status: PetStatus
    }>(CMD_LIST_PRESET_PETS)
    store.pet.setCatalog({
      presets: catalog.presetPets,
      chat: catalog.chatPets,
      codex: catalog.codexPets,
    })
    store.pet.commitFetch(revision, catalog.status)
    return { ok: true }
  })
}

/** Action：选中宠物（状态以宿主返回的权威快照为准）。 */
export async function choosePet(input: { id: string }): Promise<PetActionResult> {
  return guard('choose pet', async () => {
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_ACTIVE_PET, { id: input.id }))
    return { ok: true }
  })
}

/** Action：启用预设宠物——选中它，并确保桌宠被唤醒。 */
export async function enablePet(input: { id: string }): Promise<PetActionResult> {
  return guard('enable pet', async () => {
    let status = await invoke<PetStatus>(CMD_SET_ACTIVE_PET, { id: input.id })
    if (!status.enabled)
      status = await invoke<PetStatus>(CMD_SET_PET_ENABLED, { enabled: true })
    store.pet.setStatus(status)
    return { ok: true }
  })
}

/**
 * Action：取消选择；仍在启用时一并关闭桌宠（无内容可渲染，不留空窗口）。
 *
 * 先关闭再清空：若第二步失败，最坏情况也只是保留选择但窗口已销毁。任一步失败都从
 * 后端重拉状态，避免界面与持久层不一致。
 */
export async function clearPetSelection(): Promise<PetActionResult> {
  const status = store.pet.$state.status
  try {
    if (status?.enabled)
      store.pet.setStatus(await invoke<PetStatus>(CMD_SET_PET_ENABLED, { enabled: false }))
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_ACTIVE_PET, { id: '' }))
    return { ok: true }
  }
  catch (error) {
    console.error('[dsh-pet-lite] clear pet selection failed:', error)
    await loadPetStatus()
    return { ok: false, error: messageOf(error) }
  }
}

/** Action：启用/关闭桌宠（纯持久开关，关闭后重启不再自动拉起）。 */
export async function togglePet(input: { enabled: boolean }): Promise<PetActionResult> {
  return guard('toggle pet', async () => {
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_PET_ENABLED, { enabled: input.enabled }))
    return { ok: true }
  })
}

/** Action：调整桌宠窗口大小。 */
export async function resizePet(input: { size: number }): Promise<PetActionResult> {
  return guard('resize pet', async () => {
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_PET_SIZE, { size: input.size }))
    return { ok: true }
  })
}

/**
 * Action：开关抛射能力（拖拽甩出后飞行、撞屏幕边缘回弹）。
 *
 * 与 `togglePet` 同形：命令回吐权威状态，前端不做乐观本地副本。
 */
export async function togglePetThrow(input: { enabled: boolean }): Promise<PetActionResult> {
  return guard('toggle pet throw', async () => {
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_PET_THROW_ENABLED, { enabled: input.enabled }))
    return { ok: true }
  })
}

/** Action：在系统浏览器中打开 Codex 宠物社区站点。 */
export async function openCommunityShare(): Promise<PetActionResult> {
  return guard('open community share', async () => {
    await invoke(CMD_OPEN_EXTERNAL_URL, { url: PET_COMMUNITY_URL })
    return { ok: true }
  })
}

/**
 * Action：新建桌宠会话——挑工作区、建会话、装一次性草稿、打开会话并收起设置面板。
 *
 * 工作区目标顺序见 `chooseWorkspace`；官方导航能力缺席时明确失败，不猜核心版本。
 */
export async function createPetSession(input: {
  adapter: ClientAdapter
  close?: () => void
}): Promise<PetActionResult> {
  const { adapter, close } = input
  const workspaceId = chooseWorkspace(adapter)
  const connectWorkspace = adapter.workspaces.connectWorkspace
  const open = adapter.sessions.open
  if (workspaceId === undefined || connectWorkspace === undefined)
    return { ok: false, error: 'PET_WORKSPACE_UNAVAILABLE: no workspace can create a pet session' }
  if (open === undefined)
    return { ok: false, error: 'PET_SESSION_UNAVAILABLE: session opener is unavailable' }

  return guard('create pet session', async () => {
    const sessionId = await connectWorkspace(workspaceId)
    if (typeof sessionId !== 'string' || sessionId.length === 0)
      return { ok: false, error: 'PET_SESSION_UNAVAILABLE: workspace did not return a session id' }
    store.pet.setPrefill(sessionId, PET_HATCH_PROMPT)
    close?.()
    open(sessionId)
    return { ok: true }
  })
}

// --- 未实现的领域能力 -----------------------------------------------------
//
// 下面这些动作在上游由 Rust 侧实现（远端仓库登记、zip 解包导入、更新检查、外链打开）。
// 本插件的宿主没有对应后端，因此**明确失败**并给出可辨识的错误码 —— 不像上一条注释
// 那样静默返回 ok，避免设置页在「看起来能用」的状态下丢数据。

export async function deletePet(input: { id: string }): Promise<PetActionResult> {
  return guard('delete pet', async () => {
    await invoke(CMD_DELETE_PET, { id: input.id })
    return { ok: true }
  })
}

export async function importPetArchive(input: { name: string, data: string }): Promise<PetActionResult> {
  return guard('import pet', async () => {
    await invoke(CMD_IMPORT_PET, { name: input.name, data: input.data })
    return { ok: true }
  })
}

export async function importPetRepository(input: { repository: string }): Promise<PetActionResult> {
  const match = /^(?:https:\/\/github\.com\/)?([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([\w.-]{1,100})\/?$/i.exec(input.repository.trim())
  if (!match || match[2] === '.' || match[2] === '..')
    return { ok: false, error: 'PET_REPOSITORY_INVALID' }
  return guard('import pet repository', async () => {
    await invoke(CMD_IMPORT_PET_REPOSITORY, { repository: `${match[1]}/${match[2]}` })
    return { ok: true }
  })
}

export async function updatePetRepository(input: { id: string }): Promise<PetActionResult> {
  return guard('update pet repository', async () => {
    await invoke(CMD_UPDATE_PET_REPOSITORY, { id: input.id })
    return { ok: true }
  })
}

/** Query：用户导入的宠物清单（本插件暂不支持导入，恒空）。 */
export async function loadPetList(source: 'chat' | 'codex'): Promise<PetListItem[]> {
  try {
    return await invoke<PetListItem[]>(CMD_LIST_PETS, { source })
  }
  catch {
    return []
  }
}

export async function loadPetUpdates(): Promise<PetActionResult> {
  store.pet.setPetUpdates([])
  return { ok: true }
}

/**
 * Query：读取当前环境能否让桌宠窗口置顶并定位。
 *
 * 上游由 Rust 判定（Wayland / XWayland）。本插件的独立窗口来自 Electron，XWayland 这一
 * 支不适用，因此恒返回 true —— 但**保留同一条读取路径与失败语义**（返回 `null` 时不显示
 * 提示，而不是把设置页打成错误态），这样设置页那段 Wayland 提示逻辑无需改写。
 */
export async function loadPetOverlaySupported(): Promise<boolean | null> {
  try {
    store.pet.setOverlaySupported(true)
    return true
  }
  catch (error) {
    console.error('[dsh-pet-lite] load pet overlay support failed:', error)
    return null
  }
}

/** Query：「强制 XWayland」开关（本插件无此机制，恒 false，保留同形读取面）。 */
export async function loadForceXwayland(): Promise<boolean | null> {
  try {
    store.pet.setForceXwayland(false)
    return false
  }
  catch (error) {
    console.error('[dsh-pet-lite] load force xwayland failed:', error)
    return null
  }
}

/** Action：「强制 XWayland」开关（本插件无此机制，明确不改状态）。 */
export async function toggleForceXwayland(_input: { enabled: boolean }): Promise<PetActionResult> {
  return { ok: false, error: 'PET_UNSUPPORTED_COMMAND: force xwayland is not configurable' }
}
