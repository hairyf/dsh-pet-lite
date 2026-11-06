import type { Buffer } from 'node:buffer'
import type { PetListItem, PetSource } from '../shared/types'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { dshHome } from './store'

/**
 * host/pet-fs.ts — 文件系统宠物的扫描、清单读取与列表（对应 Rust `bridge/pet.rs`
 * 的 `list_pets` / `read_manifest` / `manifest_to_list_item` / `immediate_pet_directories`）。
 *
 * 与上游逐条一致：
 *   - 来源 `chat` → `$DSH_HOME/pets`；来源 `codex` → `~/.codex/pets`；
 *   - 目录下每个子目录若含可解析的 `pet.json` 即为一个宠物，坏的单个忽略、不阻断其余；
 *   - 列表 id = 来源限定 `chat:<id>` / `codex:<id>`。
 */

/** `pet.json` 受支持字段（camelCase，与 Rust `PetManifest` 一致）。 */
export interface PetManifest {
  id: string
  displayName?: string
  description?: string
  spriteVersionNumber?: number
  spritesheetPath?: string
  kind?: string
  configPath?: string
  uriPath?: string
  macUriPath?: string
  previewPath?: string
  ext?: { default: string, mac?: string }
  size?: number
}

export const PET_MANIFEST_MAX_BYTES = 64 * 1024
const PET_SPRITESHEET_MAX_BYTES = 16 * 1024 * 1024
const PET_PREVIEW_MAX_DIMENSION = 4096
const PET_SPRITE_COLUMNS = 8

/** 来源目录。 */
export function petsDir(source: PetSource): string {
  if (source === 'chat')
    return join(dshHome(), 'pets')
  return join(homedir(), '.codex', 'pets')
}

/** 来源限定 id。 */
export function qualifiedId(source: PetSource, manifestId: string): string {
  return `${source}:${manifestId}`
}

/** 解析来源限定 id（`chat:` / `codex:` 前缀）。 */
export function parseQualifiedId(id: string): { source: PetSource, manifestId: string } {
  const index = id.indexOf(':')
  if (index < 0)
    throw new Error('PET_ID_INVALID: filesystem pet id must be source-qualified')
  const source = id.slice(0, index) as PetSource
  if (source !== 'chat' && source !== 'codex')
    throw new Error('PET_SOURCE_INVALID: source must be chat or codex')
  const manifestId = id.slice(index + 1)
  validateManifestId(manifestId)
  return { source, manifestId }
}

/** 清单 id 只允许 1..=64 的 ASCII 字母数字与 `-`/`_`（直接进文件系统路径）。 */
export function validManifestId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && /^[\w-]+$/u.test(id) && [...id].every(ch => ch.charCodeAt(0) < 128)
}

export function validateManifestId(id: string): void {
  if (!validManifestId(id))
    throw new Error('PET_ID_INVALID: manifest id must be 1..=64 ascii letters/digits/-/_')
}

/**
 * 只允许普通相对路径组件（对应 Rust `safe_relative_path`）。
 *
 * 显式拒绝反斜杠与冒号：Unix 上算安全的路径，在 Windows 上是目录分隔符或盘符 / ADS。
 */
export function safeRelativePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.includes(':'))
    throw new Error('PET_PATH_INVALID: path must be a portable relative path')
  const segments = value.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.')
      continue
    if (segment === '..')
      throw new Error('PET_PATH_INVALID: path must not escape the pet directory')
    out.push(segment)
  }
  if (out.length === 0)
    throw new Error('PET_PATH_INVALID: path must not be empty')
  return out.join('/')
}

/** 解析 `pet.json`（受支持字段，未知字段忽略）。 */
export function parseManifest(raw: string): PetManifest {
  const value = JSON.parse(raw) as Record<string, unknown>
  if (value === null || typeof value !== 'object')
    throw new Error('PET_MANIFEST_INVALID: manifest must be an object')
  const id = typeof value.id === 'string' ? value.id : ''
  validateManifestId(id)
  const str = (key: string): string | undefined => (typeof value[key] === 'string' ? (value[key] as string) : undefined)
  const num = (key: string): number | undefined => (typeof value[key] === 'number' ? (value[key] as number) : undefined)
  let ext: PetManifest['ext']
  if (value.ext && typeof value.ext === 'object') {
    const e = value.ext as Record<string, unknown>
    if (typeof e.default === 'string')
      ext = { default: e.default, mac: typeof e.mac === 'string' ? e.mac : undefined }
  }
  return {
    id,
    displayName: str('displayName'),
    description: str('description'),
    spriteVersionNumber: num('spriteVersionNumber'),
    spritesheetPath: str('spritesheetPath'),
    kind: str('kind'),
    configPath: str('configPath'),
    uriPath: str('uriPath'),
    macUriPath: str('macUriPath'),
    previewPath: str('previewPath'),
    ext,
    size: num('size'),
  }
}

/** 读取目录下的 `pet.json`；失败抛错（调用方按「坏宠物」忽略）。 */
export function readManifest(directory: string): PetManifest {
  const file = join(directory, 'pet.json')
  const stats = statSync(file)
  if (stats.size > PET_MANIFEST_MAX_BYTES)
    throw new Error('PET_MANIFEST_READ_FAILED: pet.json exceeds its byte limit')
  return parseManifest(readFileSync(file, 'utf8'))
}

/** 来源目录下的立即子目录（忽略符号链接）。对应 Rust `immediate_pet_directories`。 */
export function immediatePetDirectories(root: string): string[] {
  if (!existsSync(root))
    return []
  const directories: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink())
      directories.push(join(root, entry.name))
  }
  return directories.sort()
}

/** Codex 图集网格（列恒 8；v1=9 行 / v2=11 行）。 */
export function spriteGrid(declared: number | undefined, width: number, height: number): { version: 1 | 2, columns: number, rows: number } {
  if (width % PET_SPRITE_COLUMNS !== 0)
    throw new Error(`PET_ASSET_DIMENSIONS_INVALID: spritesheet width must be divisible by ${PET_SPRITE_COLUMNS} columns`)
  const cell = width / PET_SPRITE_COLUMNS
  if (cell === 0 || height % cell !== 0)
    throw new Error('PET_ASSET_DIMENSIONS_INVALID: spritesheet height must be a multiple of the cell size')
  const rows = height / cell
  // 声明版本只在两种布局都整除时用于消歧；与实际比例不符时以图集为准。
  const version: 1 | 2 = rows === 9 ? 1 : 2
  void declared
  return { version, columns: PET_SPRITE_COLUMNS, rows }
}

/** 读图集尺寸（PNG / WebP 头解析，足够推断网格）。 */
function imageSize(bytes: Buffer): { width: number, height: number } | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    // PNG：IHDR 宽高在 16..24 字节。
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = bytes.toString('ascii', 12, 16)
    if (fourcc === 'VP8X') {
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
      return { width: w, height: h }
    }
    if (fourcc === 'VP8 ') {
      const w = bytes.readUInt16LE(26) & 0x3FFF
      const h = bytes.readUInt16LE(28) & 0x3FFF
      return { width: w, height: h }
    }
  }
  return null
}

/** 把图集读成 data URL（对应 Rust `read_spritesheet` 的 data URL 输出）。 */
export async function readSpritesheet(directory: string, relative: string, declared: number | undefined): Promise<{ url: string, grid: { version: 1 | 2, columns: number, rows: number } }> {
  const path = containedFile(directory, relative)
  const bytes = await readFile(path)
  if (bytes.length > PET_SPRITESHEET_MAX_BYTES)
    throw new Error('PET_ASSET_READ_FAILED: spritesheet exceeds its byte limit')
  const size = imageSize(bytes)
  if (!size)
    throw new Error('PET_ASSET_INVALID: spritesheet must be PNG or WebP')
  const grid = spriteGrid(declared, size.width, size.height)
  const mime = bytes[0] === 0x89 ? 'image/png' : 'image/webp'
  return { url: `data:${mime};base64,${bytes.toString('base64')}`, grid }
}

/** GIF 预览图 → data URL（对应 Rust `gif_data_url`）。 */
export function gifDataUrl(directory: string, relative: string): string {
  const path = containedFile(directory, relative)
  const bytes = readFileSync(path)
  if (bytes.length < 13 || (bytes.toString('ascii', 0, 6) !== 'GIF87a' && bytes.toString('ascii', 0, 6) !== 'GIF89a'))
    throw new Error('PET_PREVIEW_INVALID: preview must have a GIF header')
  const width = bytes.readUInt16LE(6)
  const height = bytes.readUInt16LE(8)
  if (width === 0 || width !== height || width > PET_PREVIEW_MAX_DIMENSION)
    throw new Error('PET_PREVIEW_INVALID: GIF must be square and within 1..=4096px')
  return `data:image/gif;base64,${bytes.toString('base64')}`
}

/** 跟随符号链接后仍必须留在宠物目录内（对应 Rust `contained_file`）。 */
function containedFile(directory: string, relative: string): string {
  const normalized = safeRelativePath(relative)
  const root = resolve(directory)
  const candidate = resolve(directory, normalized)
  if (candidate !== root && !candidate.startsWith(root + sep))
    throw new Error('PET_PATH_INVALID: path escapes the pet directory')
  return candidate
}

/** 校验来源：Codex 宠物必须是图集（禁止 kind=dsh）。 */
export function validatePetSource(source: PetSource, manifest: PetManifest): void {
  if (source === 'codex' && manifest.kind === 'dsh')
    throw new Error('PET_KIND_FORBIDDEN: Codex pets must use spritesheets')
}

/** 清单 → 列表项（对应 Rust `manifest_to_list_item`）。 */
export async function manifestToListItem(source: PetSource, directory: string, manifest: PetManifest): Promise<PetListItem> {
  const name = (manifest.displayName ?? '').trim() || manifest.id
  const description = (manifest.description ?? '').trim() || undefined
  const isDsh = manifest.kind === 'dsh'
  let thumbnail: string | undefined
  try {
    thumbnail = isDsh
      ? gifDataUrl(directory, manifest.previewPath ?? '')
      : (await readSpritesheet(directory, manifest.spritesheetPath ?? '', manifest.spriteVersionNumber)).url
  }
  catch {
    thumbnail = undefined
  }
  return {
    id: qualifiedId(source, manifest.id),
    name,
    description,
    thumbnail,
    source,
    kind: isDsh ? 'dsh' : 'codex',
    thumbnail_type: isDsh ? 'gif' : 'spritesheet',
  }
}

/** 列出某来源目录下全部有效宠物（坏宠物忽略）。对应 Rust `list_pets`。 */
export async function listPets(source: PetSource): Promise<PetListItem[]> {
  const root = petsDir(source)
  const items: PetListItem[] = []
  const ids = new Set<string>()
  for (const directory of immediatePetDirectories(root)) {
    let manifest: PetManifest
    try {
      manifest = readManifest(directory)
    }
    catch {
      continue
    }
    try {
      validatePetSource(source, manifest)
    }
    catch {
      continue
    }
    const id = qualifiedId(source, manifest.id)
    if (ids.has(id))
      continue
    ids.add(id)
    items.push(await manifestToListItem(source, directory, manifest))
  }
  items.sort((left, right) => left.id.localeCompare(right.id))
  return items
}

/** 按清单 id 找宠物目录（对应 Rust `find_pet_directory`）。 */
export function findPetDirectory(root: string, manifestId: string): { directory: string, manifest: PetManifest } | undefined {
  for (const directory of immediatePetDirectories(root)) {
    let manifest: PetManifest
    try {
      manifest = readManifest(directory)
    }
    catch {
      continue
    }
    if (manifest.id === manifestId)
      return { directory, manifest }
  }
  return undefined
}
