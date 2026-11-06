import type { PetRuntimeStatus, PetStatus, PresetPetItem } from '../shared/types'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { PET_DEFAULT_SIZE, PET_SIZE_MAX, PET_SIZE_MIN } from '../shared/constants'
import { builtInCatalog } from './catalog'

/**
 * host/store.ts — 桌宠持久设置（对应 apps/desktop `desktop/pet.rs` 的持久层）。
 *
 * 落盘位置 `$DSH_HOME/pet-lite/pet.json`：与 DSH 其余用户数据同根，删除后回到默认值。
 * 只持久化「用户意图」（选择 / 启用 / 大小 / 抛射），可见性由后端按启用态推导。
 */

export interface PetPersisted {
  active_pet: string
  enabled: boolean
  pet_size: number
  throw_enabled: boolean
}

/** `$DSH_HOME`（默认 `~/.dsh`），与 DSH 其余工具链一致。 */
export function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  if (!configured)
    return join(homedir(), '.dsh')
  return configured === '~' ? homedir() : configured
}

export function storeFile(): string {
  return join(dshHome(), 'pet-lite', 'pet.json')
}

function clampSize(value: unknown): number {
  const size = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(size))
    return PET_DEFAULT_SIZE
  return Math.round(Math.min(PET_SIZE_MAX, Math.max(PET_SIZE_MIN, size)))
}

/** 未知 id 收敛为首个内置预设（与 Rust `resolve_active_pet` 的兜底同义）。 */
function normalizeActiveId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id)
    return ''
  return builtInCatalog().some(item => item.id === id) ? id : id
}

export function defaults(): PetPersisted {
  return {
    active_pet: builtInCatalog()[0]?.id ?? '',
    enabled: false,
    pet_size: PET_DEFAULT_SIZE,
    throw_enabled: false,
  }
}

/** 读取持久设置；文件缺失或损坏时回落到默认值。 */
export function readPersisted(): PetPersisted {
  const file = storeFile()
  if (!existsSync(file))
    return defaults()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PetPersisted>
    const fallback = defaults()
    return {
      active_pet: raw.active_pet === undefined ? fallback.active_pet : normalizeActiveId(raw.active_pet),
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
      pet_size: clampSize(raw.pet_size),
      throw_enabled: typeof raw.throw_enabled === 'boolean' ? raw.throw_enabled : fallback.throw_enabled,
    }
  }
  catch {
    return defaults()
  }
}

/** 原子写盘（临时文件 + rename）；失败只返回 false，调用方保持内存态。 */
export function writePersisted(value: PetPersisted): boolean {
  const file = storeFile()
  try {
    mkdirSync(join(dshHome(), 'pet-lite'), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  }
  catch {
    return false
  }
}

/** 内存态：进程内唯一真值，落盘失败也不回滚（下次写入会再试）。 */
let current: PetPersisted | undefined

export function state(): PetPersisted {
  if (current === undefined)
    current = readPersisted()
  return current
}

/** 更新内存态并落盘；返回更新后的快照。 */
export function update(patch: Partial<PetPersisted>): PetPersisted {
  const base = state()
  const next: PetPersisted = {
    active_pet: patch.active_pet === undefined ? base.active_pet : normalizeActiveId(patch.active_pet),
    enabled: patch.enabled === undefined ? base.enabled : patch.enabled,
    pet_size: patch.pet_size === undefined ? base.pet_size : clampSize(patch.pet_size),
    throw_enabled: patch.throw_enabled === undefined ? base.throw_enabled : patch.throw_enabled,
  }
  current = next
  writePersisted(next)
  return next
}

/** 测试用：丢弃内存态，强制下次从磁盘重读。 */
export function resetCache(): void {
  current = undefined
}

// --- 远端登记目录 -------------------------------------------------------
//
// 用户在设置页登记的 GitHub 仓库宠物。与上游一样只持久化**资源地址与元信息**
// （不下载视频包），落盘在 `$DSH_HOME/pet-lite/pet.json` 的同目录 `remote-pets.json`。

function remoteFile(): string {
  return join(dshHome(), 'pet-lite', 'remote-pets.json')
}

let remoteCache: PresetPetItem[] | undefined
/** 缓存对应文件的 mtime（ms）；文件被外部改动时缓存自动失效。 */
let remoteCacheMtime = -1

/** 读远端登记目录（损坏时回落到空数组）。 */
export function readRemotePets(): PresetPetItem[] {
  const file = remoteFile()
  const exists = existsSync(file)
  const mtime = exists ? statSync(file).mtimeMs : 0
  if (remoteCache !== undefined && mtime === remoteCacheMtime)
    return remoteCache
  if (!exists) {
    remoteCache = []
    remoteCacheMtime = 0
    return remoteCache
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as PresetPetItem[]
    remoteCache = Array.isArray(raw) ? raw : []
  }
  catch {
    remoteCache = []
  }
  remoteCacheMtime = mtime
  return remoteCache
}

/** 原子写远端登记目录。 */
export function writeRemotePets(list: PresetPetItem[]): void {
  const file = remoteFile()
  remoteCache = list
  try {
    mkdirSync(join(dshHome(), 'pet-lite'), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8')
    renameSync(tmp, file)
    remoteCacheMtime = statSync(file).mtimeMs
  }
  catch {
    /* 写盘失败不改变内存态：下次写会再试 */
  }
}

/** 测试用：丢弃远端目录缓存。 */
export function resetRemoteCache(): void {
  remoteCache = undefined
  remoteCacheMtime = -1
}

/**
 * 推导对外快照（对应 Rust `PetStatus`）。
 *
 * `visible` 不是持久字段：无选择时必然不可见（没有内容可渲染，不留空窗口）。
 */
export function snapshot(input: { desktopSupported: boolean, desktopOpen: boolean }): PetRuntimeStatus {
  const value = state()
  const status: PetStatus = {
    active_pet: value.active_pet,
    enabled: value.enabled,
    pet_size: value.pet_size,
    throw_enabled: value.throw_enabled,
    visible: value.enabled && value.active_pet !== '',
  }
  return {
    ...status,
    desktop_supported: input.desktopSupported,
    desktop_open: input.desktopOpen,
  }
}
