import type { PetListItem, PetSource } from '../shared/types'
import type { PetManifest } from './pet-fs'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { unzipSync } from 'fflate'
import { manifestToListItem, parseManifest, petsDir, readSpritesheet, safeRelativePath, validateManifestId } from './pet-fs'

/**
 * host/pet-import.ts — Codex 宠物 zip 包导入（对应 Rust `bridge/pet.rs` 的
 * `extract_pet_archive` + `import_pet`）。
 *
 * 与上游一致的安全约束：
 *   - base64 载荷 ≤ 32MB；条目数 ≤ 512；解压后总量 ≤ 128MB；
 *   - 条目路径必须是可移植相对路径（拒绝 `\`、`:`、`..` 逃逸、绝对路径、NUL）；
 *   - 忽略 OS 元数据（`__MACOSX`、`._*`、`.DS_Store`、`Thumbs.db`、`desktop.ini`、`.staging`）；
 *   - 恰好一个 `pet.json`，其所在目录即包根，剥离包装目录后全部条目必须落在包根内；
 *   - 清单 id 合法、kind 非 dsh、图集为 PNG/WebP 且尺寸可推断网格；
 *   - 目标 id 已存在则拒绝（不覆盖）。
 */

const PET_PACKAGE_MAX_BYTES = 32 * 1024 * 1024
const PET_PACKAGE_MAX_ENTRIES = 512
const PET_PACKAGE_MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024

/** 归档里与宠物无关的条目。 */
function ignoredArchiveEntry(name: string): boolean {
  return name.split('/').some(segment =>
    segment === '__MACOSX'
    || segment === '.DS_Store'
    || segment === 'Thumbs.db'
    || segment === 'desktop.ini'
    || segment === '.staging'
    || segment.startsWith('._'),
  )
}

interface Entry {
  name: string
  data: Uint8Array
  isDir: boolean
}

/** 定位归档里唯一的 `pet.json`，返回需要剥离的前缀（`''` = 清单就在归档根）。 */
function archiveRootPrefix(entries: readonly Entry[]): string {
  const manifests = entries.filter(entry => !entry.isDir && entry.name.split('/').pop() === 'pet.json')
  if (manifests.length !== 1)
    throw new Error('PET_ARCHIVE_LAYOUT_INVALID: archive must contain exactly one pet.json')
  const manifestPath = manifests[0]!.name
  const slash = manifestPath.lastIndexOf('/')
  const prefix = slash < 0 ? '' : manifestPath.slice(0, slash + 1)
  if (prefix === '')
    return ''
  for (const entry of entries) {
    if (entry.name.startsWith(prefix))
      continue
    // 允许 prefix 的上级包装目录条目（它们只能是目录）。
    if (entry.isDir && prefix.startsWith(`${entry.name}/`))
      continue
    throw new Error('PET_ARCHIVE_LAYOUT_INVALID: archive must have exactly one supported root')
  }
  return prefix
}

function uniqueStagingPath(root: string): string {
  const nonce = `${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e9)}`
  return join(root, '.staging', `import-${nonce}`)
}

/**
 * 导入一个 Codex 宠物 zip（base64）。返回安装后的列表项。
 *
 * @param base64 - 前端 FileReader 读出的 base64（不含 `data:` 前缀）。
 */
export async function importPetArchive(base64: string, source: PetSource = 'codex'): Promise<PetListItem> {
  // 压缩包大小预检（base64 → 原始字节的上界）。
  const encodedLimit = Math.ceil(PET_PACKAGE_MAX_BYTES / 3) * 4
  if (base64.length > encodedLimit)
    throw new Error(`PET_PACKAGE_TOO_LARGE: pet package must not exceed ${PET_PACKAGE_MAX_BYTES} compressed bytes`)
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > PET_PACKAGE_MAX_BYTES)
    throw new Error(`PET_PACKAGE_TOO_LARGE: pet package must not exceed ${PET_PACKAGE_MAX_BYTES} compressed bytes`)

  let raw: Record<string, Uint8Array>
  try {
    raw = unzipSync(new Uint8Array(bytes))
  }
  catch (error) {
    throw new Error(`PET_ARCHIVE_INVALID: failed to open zip: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 第一遍：收集条目、校验路径与类型、累计解压字节。
  const entries: Entry[] = []
  let total = 0
  const names = Object.keys(raw)
  if (names.length === 0 || names.length > PET_PACKAGE_MAX_ENTRIES)
    throw new Error(`PET_ARCHIVE_ENTRY_LIMIT: archive must contain 1..=${PET_PACKAGE_MAX_ENTRIES} entries`)
  for (const name of names) {
    const isDir = name.endsWith('/')
    if (ignoredArchiveEntry(name))
      continue
    // 目录条目也过一遍路径校验（拒绝逃逸）。
    safeRelativePath(name.replace(/\/+$/u, ''))
    const data = raw[name]!
    if (!isDir) {
      total += data.length
      if (total > PET_PACKAGE_MAX_UNCOMPRESSED_BYTES)
        throw new Error(`PET_ARCHIVE_TOO_LARGE: uncompressed files must not exceed ${PET_PACKAGE_MAX_UNCOMPRESSED_BYTES} bytes`)
    }
    entries.push({ name, data, isDir })
  }

  const prefix = archiveRootPrefix(entries)
  const root = petsDir(source)
  const staging = uniqueStagingPath(root)
  mkdirSync(staging, { recursive: true })

  let committed = false
  try {
    // 第二遍：剥前缀写入 staging。
    const outputs = new Set<string>()
    for (const entry of entries) {
      const relative = entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : ''
      if (relative === '' || relative.endsWith('/'))
        continue
      const normalized = safeRelativePath(relative)
      if (outputs.has(normalized))
        throw new Error('PET_ARCHIVE_DUPLICATE_ENTRY: duplicate output path')
      outputs.add(normalized)
      const target = join(staging, normalized)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, entry.data)
    }

    const manifest: PetManifest = parseManifest(readFileSync(join(staging, 'pet.json'), 'utf8'))
    validateManifestId(manifest.id)
    if (manifest.kind === 'dsh')
      throw new Error('PET_KIND_FORBIDDEN: Codex pets must use spritesheets')
    // 校验图集存在且可解析出网格。
    await readSpritesheet(staging, manifest.spritesheetPath ?? '', manifest.spriteVersionNumber)

    const target = join(root, manifest.id)
    if (existsSync(target))
      throw new Error(`PET_ALREADY_IMPORTED: Codex pet target ${manifest.id} already exists`)
    mkdirSync(root, { recursive: true })
    renameSync(staging, target)
    committed = true
    return await manifestToListItem(source, target, manifest)
  }
  finally {
    if (!committed)
      rmSync(staging, { recursive: true, force: true })
  }
}
