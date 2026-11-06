import type { PetAsset, PresetPetItem } from '../shared/types'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * host/catalog.ts — 预设宠物清单（对应 apps/desktop `resources/manifest.jsonc`
 * 的 `pets.built-in`）。
 *
 * 内置清单与用户在设置页登记的远端条目合并返回；内置优先，登记条目与内置 id 撞车时
 * 丢弃登记条目（宠物先进登记清单、后被收进内置清单的机器会留下这种残余）。
 */

interface RawPreset {
  id: string
  name: string
  desc?: string
  image?: string
  kind?: string
  size?: number
  config: string
  uri: { default: string, mac?: string }
  ext?: { default: string, mac?: string }
}

const BUILT_IN: readonly RawPreset[] = readBuiltIn()

function readBuiltIn(): RawPreset[] {
  // `dist/index.js` 与 `src/host/catalog.ts` 的「上一级」不是同一个目录，因此不能
  // 只靠 `import.meta.dirname`。以包根的 `package.json` 为锚点解析，两种布局都成立。
  const packageRoot = resolvePackageRoot()
  const raw = JSON.parse(readFileSync(join(packageRoot, 'dist', 'presets.json'), 'utf8')) as {
    pets?: { 'built-in'?: RawPreset[] }
  }
  return raw.pets?.['built-in'] ?? []
}

/** 包根：从本模块位置向上找到含 `package.json` 的目录。 */
function resolvePackageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(directory, 'package.json')))
      return directory
    const parent = dirname(directory)
    if (parent === directory)
      return directory
    directory = parent
  }
}

/** 预设 id 是否安全（直接进入持久化与路由参数，只允许 ASCII 字母数字与 `-`/`_`）。 */
export function safePresetId(id: string): boolean {
  return (
    id.length > 0
    && id.length <= 64
    && [...id].every(value => /[\w-]/u.test(value) && value.charCodeAt(0) < 128)
  )
}

function toItem(spec: RawPreset, remote: boolean): PresetPetItem {
  return {
    id: spec.id,
    name: spec.name,
    desc: spec.desc ?? null,
    image: spec.image ?? null,
    kind: (spec.kind === 'codex' ? 'codex' : 'dsh'),
    size: spec.size ?? null,
    config: spec.config,
    uri: spec.uri,
    ext: spec.ext ?? null,
    remote,
  }
}

/** 合并内置与登记条目（内置在前；id 撞车时丢弃登记条目）。 */
export function mergeCatalog(remote: readonly RawPreset[] = []): PresetPetItem[] {
  const builtInIds = new Set(BUILT_IN.map(spec => spec.id))
  return [
    ...BUILT_IN.map(spec => toItem(spec, false)),
    ...remote.filter(spec => !builtInIds.has(spec.id)).map(spec => toItem(spec, true)),
  ]
}

/** 内置条目（不含用户登记）。 */
export function builtInCatalog(): PresetPetItem[] {
  return mergeCatalog([])
}

/** 按 id 取一条预设；不存在时返回 undefined。 */
export function findPreset(id: string): PresetPetItem | undefined {
  return mergeCatalog().find(item => item.id === id)
}

/**
 * 把预设条目投影成桌宠窗口的渲染参数（对应 Rust `get_pet_asset`）。
 *
 * 预设宠物直连远端：`config` 与 `uri` 原样返回，不下载、不落地。
 */
export function presetAsset(item: PresetPetItem): PetAsset {
  if (item.kind === 'codex') {
    return {
      kind: 'codex',
      id: item.id,
      spritesheet: typeof item.uri === 'string' ? item.uri : item.uri.default,
      sprite_version_number: 2,
      columns: 8,
      rows: 11,
    }
  }
  return {
    kind: 'dsh',
    id: item.id,
    config: item.config,
    uri: item.uri,
    ext: item.ext ?? { default: 'webm', mac: 'mov' },
    size: item.size ?? undefined,
  }
}
