import type { PresetPetItem } from '../shared/types'
import type { PetManifest } from './pet-fs'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { parseManifest, safeRelativePath } from './pet-fs'

/**
 * host/pet-repo.ts — 远端 GitHub 仓库宠物登记（对应 Rust `bridge/pet.rs` 的
 * `import_pet_repository` / `check_pet_updates` / `update_pet_repository` 及其辅助函数）。
 *
 * 只登记**远端资源地址**，不下载视频包：读仓库 HEAD 提交，把 `pet.json`（可选）与
 * `config.jsonc` 解析成一份 `PresetPetItem`（config / uri / image 全指向
 * `raw.githubusercontent.com/<owner>/<name>/<commit>/…`）。更新时再 HEAD 校验素材是否齐全。
 *
 * 与上游逐条一致：仓库地址校验、12s 超时、`kind` 必须为 `dsh`、只认 raw.githubusercontent。
 */

const PET_MANIFEST_MAX_BYTES = 64 * 1024
const PET_CONFIG_MAX_BYTES = 1024 * 1024
const PET_REPOSITORY_TIMEOUT_MS = 12_000
const PET_REPOSITORY_DOWNLOAD_TIMEOUT_MS = 12_000

type FetchLike = typeof fetch

/** 默认拉取的 `pet.json`（仓库无清单时使用）。 */
function defaultManifest(name: string): PetManifest {
  return {
    id: name,
    kind: 'dsh',
    configPath: 'config.jsonc',
    uriPath: 'webm',
    previewPath: 'preview/preview.gif',
    ext: { default: 'webm', mac: 'webm' },
  }
}

/** 解析 `owner/repo` 或 `https://github.com/owner/repo`。对应 Rust `parse_pet_repository`。 */
export function parsePetRepository(repository: string): { owner: string, name: string } {
  const invalid = (): never => {
    throw new Error('PET_REPOSITORY_INVALID: use owner/repo or https://github.com/owner/repo')
  }
  const input = repository.trim()
  let path = input
  if (input.includes('://')) {
    let url: URL
    try {
      url = new URL(input)
    }
    catch {
      return invalid()
    }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash)
      return invalid()
    path = url.pathname.replace(/^\/+/u, '').replace(/\/+$/u, '')
  }
  const slash = path.indexOf('/')
  if (slash < 0)
    return invalid()
  const owner = path.slice(0, slash)
  let name = path.slice(slash + 1)
  if (name.endsWith('.git'))
    name = name.slice(0, -4)
  if (
    !owner
    || owner.length > 39
    || owner.startsWith('-')
    || owner.endsWith('-')
    || !/^[\w-]+$/u.test(owner) || ![...owner].every(c => c.charCodeAt(0) < 128)
    || !name
    || name.length > 100
    || name === '.' || name === '..'
    || !/^[\w.-]+$/u.test(name) || ![...name].every(c => c.charCodeAt(0) < 128)
  ) {
    return invalid()
  }
  return { owner, name }
}

/** 在 base 之后追加一段受控相对路径（对应 Rust `repository_asset_url`）。 */
export function repositoryAssetUrl(base: string, relative: string): string {
  const normalized = safeRelativePath(relative)
  const url = new URL(base)
  const prefix = url.pathname.replace(/\/+$/u, '')
  return `${url.origin}${prefix}/${normalized}`
}

/** 从 `pet.json`（可选）构造预设条目。对应 Rust `repository_spec`。 */
export function repositorySpec(base: string, name: string, manifestBytes: string | null): PresetPetItem {
  const manifest = manifestBytes === null ? defaultManifest(name) : parseManifest(manifestBytes)
  if (manifest.kind !== 'dsh')
    throw new Error('PET_KIND_FORBIDDEN: repository pets must use kind dsh')
  const config = repositoryAssetUrl(base, manifest.configPath ?? '')
  const image = repositoryAssetUrl(base, manifest.previewPath ?? '')
  const uriDefault = repositoryAssetUrl(base, manifest.uriPath ?? '')
  const uriMac = manifest.macUriPath ? repositoryAssetUrl(base, manifest.macUriPath) : undefined
  return {
    id: manifest.id,
    name: (manifest.displayName ?? '').trim() || manifest.id,
    desc: manifest.description ?? null,
    image,
    kind: 'dsh',
    size: manifest.size ?? null,
    config,
    uri: uriMac ? { default: uriDefault, mac: uriMac } : { default: uriDefault },
    ext: manifest.ext ?? null,
    remote: true,
  }
}

/** 去掉 JSONC 注释与尾逗号（对应 Rust `strip_jsonc`，字符串字面量感知）。 */
export function stripJsonc(text: string): string {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const next = text[i + 1]
    if (inLine) {
      if (ch === '\n') {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (ch === '\\')
        out += text[++i] ?? ''
      else if (ch === '"')
        inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
    }
    else if (ch === '/' && next === '/') {
      inLine = true
      i++
    }
    else if (ch === '/' && next === '*') {
      inBlock = true
      i++
    }
    else {
      out += ch
    }
  }
  return out.replace(/,(\s*[}\]])/gu, '$1')
}

/** 配置里的全部动画名（素材自检用；对应 Rust `animation_names`）。 */
export function animationNames(config: unknown): string[] {
  const names = new Set<string>()

  /** 池 = 字符串 / 字符串数组。 */
  function collect(value: unknown): void {
    if (typeof value === 'string') {
      names.add(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value)
        collect(item)
      return
    }
    if (value && typeof value === 'object') {
      // `motions` / `events` 是「名字 → 池」的映射，逐项当池处理。
      for (const item of Object.values(value)) {
        if (typeof item === 'string' || Array.isArray(item))
          collect(item)
      }
    }
  }
  if (config && typeof config === 'object') {
    const record = config as Record<string, unknown>
    const animations = record.animations as Record<string, unknown> | undefined
    if (animations && typeof animations === 'object') {
      for (const [key, value] of Object.entries(animations)) {
        if (key === 'moves') {
          const moves = value as { actions?: Array<{ name?: unknown }> } | undefined
          for (const action of moves?.actions ?? []) {
            if (typeof action?.name === 'string')
              names.add(action.name)
          }
        }
        else if (key === 'categories') {
          for (const category of (value as Array<{ actions?: unknown[] }> | undefined) ?? []) {
            for (const name of category.actions ?? [])
              collect(name)
          }
        }
        else if (key === 'events' || key === 'motions') {
          collect(value)
        }
        else {
          collect(value)
        }
      }
    }
  }
  return [...names]
}

/**
 * GitHub 请求头。
 *
 * 未认证的 GitHub API 限流是 **60 次/小时/IP**：更新检查与仓库登记/更新都会命中它
 * （上游用应用内代理与自己的客户端，同样受这个限制）。这里额外支持 `GITHUB_TOKEN`
 * （或 `GH_TOKEN`）环境变量：设了就用它换 5000 次/小时的配额，没设就按匿名请求走 ——
 * 默认行为不变。
 */
function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()
  const base: Record<string, string> = { 'user-agent': 'dsh-pet-lite', 'accept': 'application/vnd.github+json' }
  return token ? { ...base, authorization: `Bearer ${token}` } : base
}

async function fetchText(fetchImpl: FetchLike, url: string, limit: number, optional: boolean): Promise<string | null> {
  const response = await fetchImpl(url, {
    headers: githubHeaders(),
    redirect: 'follow',
    signal: AbortSignal.timeout(PET_REPOSITORY_DOWNLOAD_TIMEOUT_MS),
  })
  if (optional && response.status === 404)
    return null
  if (!response.ok)
    throw new Error(`PET_REPOSITORY_DOWNLOAD_FAILED: HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length > limit)
    throw new Error('PET_REPOSITORY_TOO_LARGE: metadata exceeds its byte limit')
  const text = await response.text()
  if (Buffer.byteLength(text) > limit)
    throw new Error('PET_REPOSITORY_TOO_LARGE: metadata exceeds its byte limit')
  return text
}

/** 读仓库 HEAD 提交 SHA（40 位十六进制）。对应 Rust `repository_head`。 */
export async function repositoryHead(fetchImpl: FetchLike, owner: string, name: string): Promise<string> {
  const text = await fetchText(fetchImpl, `https://api.github.com/repos/${owner}/${name}/commits/HEAD`, PET_CONFIG_MAX_BYTES, false)
  const value = JSON.parse(text ?? '{}') as { sha?: unknown }
  const sha = typeof value.sha === 'string' ? value.sha : ''
  if (!/^[\da-f]{40}$/iu.test(sha))
    throw new Error('PET_REPOSITORY_INVALID: missing commit SHA')
  return sha.toLowerCase()
}

/** 读一份仓库宠物登记（`checkMedia` 时额外 HEAD 校验素材齐全）。对应 Rust `read_repository_spec`。 */
export async function readRepositorySpec(
  fetchImpl: FetchLike,
  base: string,
  name: string,
  checkMedia: boolean,
): Promise<PresetPetItem> {
  const manifestBytes = await fetchText(fetchImpl, repositoryAssetUrl(base, 'pet.json'), PET_MANIFEST_MAX_BYTES, true)
  const spec = repositorySpec(base, name, manifestBytes)
  const configText = await fetchText(fetchImpl, spec.config!, PET_CONFIG_MAX_BYTES, false)
  const config = JSON.parse(stripJsonc(configText ?? '{}')) as unknown
  if (checkMedia) {
    const ext = spec.ext ?? { default: 'webm', mac: 'webm' }
    const urls: string[] = [spec.image!]
    const names = animationNames(config)
    for (const [uri, extension] of [[spec.uri!.default, ext.default], [spec.uri!.mac, ext.mac]] as const) {
      if (!uri || !extension)
        continue
      for (const anim of names)
        urls.push(repositoryAssetUrl(`${uri}/`, `${anim}.${extension}`))
    }
    for (const url of urls) {
      const response = await fetchImpl(url, {
        method: 'HEAD',
        headers: githubHeaders(),
        redirect: 'follow',
        signal: AbortSignal.timeout(PET_REPOSITORY_DOWNLOAD_TIMEOUT_MS),
      })
      if (!response.ok)
        throw new Error(`PET_ASSET_INVALID: HTTP ${response.status} for ${url}`)
    }
  }
  return spec
}

/** 从条目里解析出 `{owner, name, 当前提交}`（对应 Rust `pet_repository_revision`）。 */
export function petRepositoryRevision(spec: PresetPetItem): { owner: string, name: string, current: string } {
  const url = new URL(spec.config ?? '')
  const parts = url.pathname.split('/').filter(Boolean)
  const sha = parts[2] ?? ''
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'raw.githubusercontent.com'
    || url.username || url.password || url.port || url.search || url.hash
    || parts.length < 4
    || !(sha === 'HEAD' || /^[\da-f]{40}$/iu.test(sha))
  ) {
    throw new Error('PET_REPOSITORY_INVALID: pet is not a registered GitHub repository')
  }
  const { owner, name } = parsePetRepository(`${parts[0]}/${parts[1]}`)
  return { owner, name, current: sha }
}

/** 登记一个新仓库宠物：读 HEAD + 清单 → PresetPetItem。12s 超时。 */
export async function importPetRepository(fetchImpl: FetchLike, repository: string): Promise<PresetPetItem> {
  const { owner, name } = parsePetRepository(repository)
  const run = async (): Promise<PresetPetItem> => {
    const commit = await repositoryHead(fetchImpl, owner, name)
    const base = `https://raw.githubusercontent.com/${owner}/${name}/${commit}/`
    return readRepositorySpec(fetchImpl, base, name, false)
  }
  return withTimeout(run(), PET_REPOSITORY_TIMEOUT_MS, 'PET_REPOSITORY_TIMEOUT: metadata registration exceeded 12 seconds')
}

/** 更新一个已登记仓库宠物：读最新 HEAD + 清单 → 新 PresetPetItem（保留原 id）。 */
export async function updatePetRepository(fetchImpl: FetchLike, spec: PresetPetItem): Promise<PresetPetItem> {
  const { owner, name } = petRepositoryRevision(spec)
  const run = async (): Promise<PresetPetItem> => {
    const commit = await repositoryHead(fetchImpl, owner, name)
    const base = `https://raw.githubusercontent.com/${owner}/${name}/${commit}/`
    const next = await readRepositorySpec(fetchImpl, base, name, true)
    return { ...next, id: spec.id }
  }
  return withTimeout(run(), PET_REPOSITORY_TIMEOUT_MS, 'PET_REPOSITORY_TIMEOUT: update exceeded 12 seconds')
}

/** 检查已登记仓库宠物是否有更新：HEAD 提交与登记的提交不同即提示更新。12s 总预算。 */
export async function checkPetUpdates(fetchImpl: FetchLike, specs: readonly PresetPetItem[]): Promise<string[]> {
  const remote = specs.filter(spec => spec.remote)
  const result: string[] = []
  await withTimeout(async () => {
    const checks = remote.map(async (spec) => {
      try {
        const { owner, name, current } = petRepositoryRevision(spec)
        const latest = await repositoryHead(fetchImpl, owner, name)
        if (current.toLowerCase() !== latest)
          result.push(spec.id)
      }
      catch {
        /* 单个失败不影响其余 */
      }
    })
    await Promise.all(checks)
  }, PET_REPOSITORY_TIMEOUT_MS, 'PET_REPOSITORY_TIMEOUT: update check exceeded 12 seconds')
  return result
}

async function withTimeout<T>(task: Promise<T> | (() => Promise<T>), ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    const run = typeof task === 'function' ? task() : task
    return await Promise.race([run, timeout])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}
