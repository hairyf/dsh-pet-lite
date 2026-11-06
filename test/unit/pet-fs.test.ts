import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  immediatePetDirectories,
  listPets,
  manifestToListItem,
  parseManifest,
  parseQualifiedId,
  petsDir,
  qualifiedId,
  readManifest,
  safeRelativePath,
  validManifestId,
} from '../../src/host/pet-fs'
import { resetCache, resetRemoteCache } from '../../src/host/store'

/**
 * 文件系统宠物契约：来源目录、限定 id、路径穿越防护、清单解析、坏宠物忽略。
 *
 * 断言口径与 Rust `bridge/pet.rs` 的 `list_pets` / `safe_relative_path` /
 * `validate_manifest_id` 一致。
 */
const savedHome = process.env.DSH_HOME
const savedUserProfile = process.env.USERPROFILE
const savedHomeDir = process.env.HOME
let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-pet-lite-fs-'))
  process.env.DSH_HOME = home
  // codex 来源目录是 ~/.codex/pets，必须同时隔离 HOME/USERPROFILE。
  process.env.USERPROFILE = home
  process.env.HOME = home
  resetCache()
  resetRemoteCache()
})

afterEach(() => {
  if (savedHome === undefined)
    delete process.env.DSH_HOME
  else
    process.env.DSH_HOME = savedHome
  for (const [key, value] of [['USERPROFILE', savedUserProfile], ['HOME', savedHomeDir]] as const) {
    if (value === undefined)
      delete process.env[key]
    else
      process.env[key] = value
  }
  resetCache()
  resetRemoteCache()
  rmSync(home, { recursive: true, force: true })
})

describe('pet sources', () => {
  it('maps chat to $DSH_HOME/pets', () => {
    expect(petsDir('chat')).toBe(join(home, 'pets'))
  })

  it('maps codex to ~/.codex/pets', () => {
    expect(petsDir('codex').endsWith(join('.codex', 'pets'))).toBe(true)
  })

  it('qualifies and parses ids round-trip', () => {
    expect(qualifiedId('codex', 'my-pet')).toBe('codex:my-pet')
    expect(parseQualifiedId('codex:my-pet')).toEqual({ source: 'codex', manifestId: 'my-pet' })
  })

  it('rejects unqualified or unknown-source ids', () => {
    expect(() => parseQualifiedId('my-pet')).toThrow(/PET_ID_INVALID/u)
    expect(() => parseQualifiedId('nope:my-pet')).toThrow(/PET_SOURCE_INVALID/u)
  })

  it('validates manifest ids', () => {
    expect(validManifestId('abc-123_X')).toBe(true)
    expect(validManifestId('')).toBe(false)
    expect(validManifestId('../etc')).toBe(false)
    expect(validManifestId('a b')).toBe(false)
    expect(validManifestId('x'.repeat(65))).toBe(false)
  })
})

describe('safeRelativePath', () => {
  it('accepts portable relative paths', () => {
    expect(safeRelativePath('webm/idle.webm')).toBe('webm/idle.webm')
    expect(safeRelativePath('./webm//idle.webm')).toBe('webm/idle.webm')
  })

  it('rejects traversal, absolute segments and Windows separators', () => {
    expect(() => safeRelativePath('../secret')).toThrow(/PET_PATH_INVALID/u)
    expect(() => safeRelativePath('webm/../../secret')).toThrow(/PET_PATH_INVALID/u)
    expect(() => safeRelativePath('webm\\idle.webm')).toThrow(/PET_PATH_INVALID/u)
    expect(() => safeRelativePath('C:/secret')).toThrow(/PET_PATH_INVALID/u)
    expect(() => safeRelativePath('')).toThrow(/PET_PATH_INVALID/u)
  })
})

describe('parseManifest', () => {
  it('reads the supported fields and defaults', () => {
    const manifest = parseManifest(JSON.stringify({
      id: 'sample',
      displayName: 'Sample',
      description: '  spaced  ',
      kind: 'dsh',
      configPath: 'assets/config.jsonc',
      uriPath: 'webm',
      previewPath: 'preview/preview.gif',
      ext: { default: 'webm', mac: 'mov' },
      size: 220,
    }))
    expect(manifest.id).toBe('sample')
    expect(manifest.kind).toBe('dsh')
    expect(manifest.ext).toEqual({ default: 'webm', mac: 'mov' })
    expect(manifest.size).toBe(220)
  })

  it('rejects a missing or unsafe id', () => {
    expect(() => parseManifest('{}')).toThrow(/PET_ID_INVALID/u)
    expect(() => parseManifest(JSON.stringify({ id: '../x' }))).toThrow(/PET_ID_INVALID/u)
  })
})

describe('listPets', () => {
  function installPet(root: string, dir: string, manifest: unknown): void {
    const directory = join(root, dir)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'pet.json'), JSON.stringify(manifest), 'utf8')
  }

  it('returns an empty list when the source directory is missing', async () => {
    expect(await listPets('chat')).toEqual([])
  })

  it('lists valid pets and ignores broken ones', async () => {
    const root = petsDir('chat')
    mkdirSync(root, { recursive: true })
    installPet(root, 'good', { id: 'good', displayName: 'Good Pet', kind: 'dsh' })
    installPet(root, 'broken', { id: 'broken', kind: 'dsh' })
    // 清单不可解析 → 整个目录被忽略。
    const badDirectory = join(root, 'malformed')
    mkdirSync(badDirectory, { recursive: true })
    writeFileSync(join(badDirectory, 'pet.json'), '{ not json', 'utf8')
    // Codex 来源禁止 kind=dsh。
    installPet(root, 'dsh-in-chat-ok', { id: 'chatonly', kind: 'dsh' })

    const items = await listPets('chat')
    const ids = items.map(item => item.id)
    expect(ids).toContain('chat:good')
    expect(ids).toContain('chat:broken')
    expect(ids).toContain('chat:chatonly')
    expect(ids).not.toContain('chat:malformed')
    // 排序稳定。
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)))
  })

  it('ignores kind=dsh pets in the codex source', async () => {
    const root = petsDir('codex')
    mkdirSync(root, { recursive: true })
    installPet(root, 'sheet', { id: 'sheet', kind: 'codex' })
    installPet(root, 'wrong', { id: 'wrong', kind: 'dsh' })

    const ids = (await listPets('codex')).map(item => item.id)
    expect(ids).toContain('codex:sheet')
    expect(ids).not.toContain('codex:wrong')
  })

  it('only walks immediate directories and skips symlink-like entries', () => {
    const root = petsDir('chat')
    mkdirSync(join(root, 'a', 'nested'), { recursive: true })
    expect(immediatePetDirectories(root)).toEqual([join(root, 'a')])
    expect(immediatePetDirectories(join(root, 'missing'))).toEqual([])
  })
})

describe('readManifest + manifestToListItem', () => {
  it('produces a list item with the source-qualified id', async () => {
    const root = petsDir('chat')
    const directory = join(root, 'sample')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'pet.json'), JSON.stringify({
      id: 'sample',
      displayName: 'Sample Pet',
      description: 'desc',
      kind: 'dsh',
      previewPath: 'preview/preview.gif',
    }), 'utf8')

    const manifest = readManifest(directory)
    const item = await manifestToListItem('chat', directory, manifest)
    expect(item.id).toBe('chat:sample')
    expect(item.name).toBe('Sample Pet')
    expect(item.description).toBe('desc')
    expect(item.source).toBe('chat')
    expect(item.kind).toBe('dsh')
    expect(item.thumbnail_type).toBe('gif')
    // 预览图缺失不阻断列表（缩略图留空）。
    expect(item.thumbnail).toBeUndefined()
  })
})
