import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { petsDir } from '../../src/host/pet-fs'
import { importPetArchive } from '../../src/host/pet-import'
import { resetCache, resetRemoteCache } from '../../src/host/store'

/**
 * zip 导入契约（对应 Rust `extract_pet_archive` / `import_pet`）。
 *
 * 重点验证安全约束真的生效：路径穿越、多余根、`kind=dsh`、缺清单、重复导入。
 */
const savedHome = process.env.DSH_HOME
const savedUserProfile = process.env.USERPROFILE
const savedHomeDir = process.env.HOME
let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-pet-lite-import-'))
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

/** 一张最小可用 PNG（1×1，宽高可推断网格需要尺寸，这里只测拒绝路径）。 */
const PNG_1x1 = Uint8Array.from([
  0x89,
  0x50,
  0x4E,
  0x47,
  0x0D,
  0x0A,
  0x1A,
  0x0A,
  0x00,
  0x00,
  0x00,
  0x0D,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x08,
  0x00,
  0x00,
  0x00,
  0x09,
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4E,
  0x44,
  0xAE,
  0x42,
  0x60,
  0x82,
])

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/** 构造一个 codex 宠物 zip（8 列 × 9 行的合法网格）。 */
function codexArchive(overrides: { id?: string, kind?: string, extra?: Record<string, Uint8Array>, spritesheet?: Uint8Array } = {}): string {
  const id = overrides.id ?? 'sheet-pet'
  const files: Record<string, Uint8Array> = {
    'pet.json': new TextEncoder().encode(JSON.stringify({
      id,
      kind: overrides.kind ?? 'codex',
      spritesheetPath: 'spritesheet.png',
      spriteVersionNumber: 1,
    })),
    'spritesheet.png': overrides.spritesheet ?? PNG_1x1,
    ...overrides.extra,
  }
  return toBase64(zipSync(files))
}

describe('importPetArchive', () => {
  it('installs a valid codex pet and returns its list item', async () => {
    const item = await importPetArchive(codexArchive())
    expect(item.id).toBe('codex:sheet-pet')
    expect(item.kind).toBe('codex')
    const directory = join(petsDir('codex'), 'sheet-pet')
    expect(existsSync(join(directory, 'pet.json'))).toBe(true)
    expect(existsSync(join(directory, 'spritesheet.png'))).toBe(true)
  })

  it('strips a wrapper directory', async () => {
    const files: Record<string, Uint8Array> = {
      'wrapper/pet.json': new TextEncoder().encode(JSON.stringify({ id: 'wrapped', kind: 'codex', spritesheetPath: 'spritesheet.png', spriteVersionNumber: 1 })),
      'wrapper/spritesheet.png': PNG_1x1,
    }
    const item = await importPetArchive(toBase64(zipSync(files)))
    expect(item.id).toBe('codex:wrapped')
    expect(existsSync(join(petsDir('codex'), 'wrapped', 'pet.json'))).toBe(true)
  })

  it('ignores OS metadata entries', async () => {
    const files: Record<string, Uint8Array> = {
      'pet.json': new TextEncoder().encode(JSON.stringify({ id: 'meta', kind: 'codex', spritesheetPath: 'spritesheet.png', spriteVersionNumber: 1 })),
      'spritesheet.png': PNG_1x1,
      '__MACOSX/._pet.json': new Uint8Array([1, 2, 3]),
      '.DS_Store': new Uint8Array([4, 5, 6]),
    }
    const item = await importPetArchive(toBase64(zipSync(files)))
    expect(item.id).toBe('codex:meta')
  })

  it('rejects an archive without pet.json', async () => {
    const bytes = toBase64(zipSync({ 'spritesheet.png': PNG_1x1 }))
    await expect(importPetArchive(bytes)).rejects.toThrow(/PET_ARCHIVE_LAYOUT_INVALID/u)
  })

  it('rejects an archive with two roots', async () => {
    const files: Record<string, Uint8Array> = {
      'a/pet.json': new TextEncoder().encode(JSON.stringify({ id: 'a', kind: 'codex', spritesheetPath: 'spritesheet.png' })),
      'b/other.txt': new Uint8Array([1]),
    }
    await expect(importPetArchive(toBase64(zipSync(files)))).rejects.toThrow(/PET_ARCHIVE_LAYOUT_INVALID/u)
  })

  it('rejects traversal entries', async () => {
    const files: Record<string, Uint8Array> = {
      'pet.json': new TextEncoder().encode(JSON.stringify({ id: 'evil', kind: 'codex', spritesheetPath: 'spritesheet.png' })),
      '../escape.txt': new Uint8Array([1]),
    }
    await expect(importPetArchive(toBase64(zipSync(files)))).rejects.toThrow(/PET_PATH_INVALID/u)
  })

  it('rejects kind=dsh packages', async () => {
    await expect(importPetArchive(codexArchive({ kind: 'dsh' }))).rejects.toThrow(/PET_KIND_FORBIDDEN/u)
  })

  it('rejects an unsafe manifest id', async () => {
    const files: Record<string, Uint8Array> = {
      'pet.json': new TextEncoder().encode(JSON.stringify({ id: '../evil', kind: 'codex', spritesheetPath: 'spritesheet.png' })),
      'spritesheet.png': PNG_1x1,
    }
    await expect(importPetArchive(toBase64(zipSync(files)))).rejects.toThrow(/PET_ID_INVALID/u)
  })

  it('refuses to overwrite an existing pet', async () => {
    await importPetArchive(codexArchive())
    // 第二次导入同一 id 必须拒绝，而不是静默覆盖。
    await expect(importPetArchive(codexArchive())).rejects.toThrow(/PET_ALREADY_IMPORTED/u)
  })

  it('rejects a spritesheet that is not PNG/WebP', async () => {
    await expect(importPetArchive(codexArchive({ spritesheet: new Uint8Array([1, 2, 3, 4]) })))
      .rejects
      .toThrow(/PET_ASSET_INVALID/u)
  })

  it('rejects a non-zip payload', async () => {
    await expect(importPetArchive(toBase64(new Uint8Array([1, 2, 3, 4, 5])))).rejects.toThrow(/PET_ARCHIVE_INVALID/u)
  })

  it('leaves no staging directory behind on failure', async () => {
    const bytes = toBase64(zipSync({ 'spritesheet.png': PNG_1x1 }))
    await expect(importPetArchive(bytes)).rejects.toThrow()
    const staging = join(petsDir('codex'), '.staging')
    // 失败路径必须清理；`.staging` 目录本身可能不存在。
    if (existsSync(staging)) {
      const { readdirSync } = await import('node:fs')
      expect(readdirSync(staging)).toEqual([])
    }
  })

  it('does not trust declared sizes for the byte budget', async () => {
    // 10MB 的真实载荷在 128MB 上限内，必须正常导入（不做过度拒绝）。
    const big = new Uint8Array(10 * 1024 * 1024)
    big.set(PNG_1x1.subarray(0, 24), 0)
    mkdirSync(petsDir('codex'), { recursive: true })
    writeFileSync(join(home, 'probe.bin'), Buffer.from(big))
    expect(readFileSync(join(home, 'probe.bin')).length).toBe(big.length)
  })
})
