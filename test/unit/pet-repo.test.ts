import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  animationNames,
  checkPetUpdates,
  parsePetRepository,
  petRepositoryRevision,
  readRepositorySpec,
  repositoryAssetUrl,
  repositoryHead,
  stripJsonc,
} from '../../src/host/pet-repo'
import { resetCache, resetRemoteCache } from '../../src/host/store'

/**
 * 远端仓库登记契约（对应 Rust `parse_pet_repository` / `repository_asset_url` /
 * `repository_spec` / `read_repository_spec` / `pet_repository_revision`）。
 *
 * 网络用注入的 fetch 桩，不真的打 GitHub。
 */
const savedHome = process.env.DSH_HOME
let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-pet-lite-repo-'))
  process.env.DSH_HOME = home
  resetCache()
  resetRemoteCache()
})

afterEach(() => {
  if (savedHome === undefined)
    delete process.env.DSH_HOME
  else
    process.env.DSH_HOME = savedHome
  resetCache()
  resetRemoteCache()
  rmSync(home, { recursive: true, force: true })
})

const SHA = 'a'.repeat(40)

/** 一个按 URL 应答的假 fetch。 */
function fakeFetch(routes: Record<string, string | null>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const key = `${method} ${url}`
    const body = routes[key] ?? routes[url]
    if (body === null || body === undefined)
      return new Response('not found', { status: 404 })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })
  }) as typeof fetch
}

describe('parsePetRepository', () => {
  it('accepts owner/repo and github URLs', () => {
    expect(parsePetRepository('owner/repo')).toEqual({ owner: 'owner', name: 'repo' })
    expect(parsePetRepository('https://github.com/owner/repo')).toEqual({ owner: 'owner', name: 'repo' })
    expect(parsePetRepository('https://github.com/owner/repo/')).toEqual({ owner: 'owner', name: 'repo' })
    expect(parsePetRepository('owner/repo.git')).toEqual({ owner: 'owner', name: 'repo' })
  })

  it('rejects non-github hosts, credentials, ports and traversal', () => {
    expect(() => parsePetRepository('https://gitlab.com/owner/repo')).toThrow(/PET_REPOSITORY_INVALID/u)
    expect(() => parsePetRepository('https://user:pw@github.com/owner/repo')).toThrow(/PET_REPOSITORY_INVALID/u)
    expect(() => parsePetRepository('https://github.com:8443/owner/repo')).toThrow(/PET_REPOSITORY_INVALID/u)
    expect(() => parsePetRepository('https://github.com/owner/repo?x=1')).toThrow(/PET_REPOSITORY_INVALID/u)
    expect(() => parsePetRepository('owner')).toThrow(/PET_REPOSITORY_INVALID/u)
    expect(() => parsePetRepository('owner/..')).toThrow(/PET_REPOSITORY_INVALID/u)
    expect(() => parsePetRepository('-bad/repo')).toThrow(/PET_REPOSITORY_INVALID/u)
  })
})

describe('repositoryAssetUrl', () => {
  it('joins a controlled relative path onto the base', () => {
    expect(repositoryAssetUrl('https://raw.githubusercontent.com/o/r/abc/', 'webm')).toBe('https://raw.githubusercontent.com/o/r/abc/webm')
    expect(repositoryAssetUrl('https://raw.githubusercontent.com/o/r/abc', 'webm/x')).toBe('https://raw.githubusercontent.com/o/r/abc/webm/x')
  })

  it('refuses traversal', () => {
    expect(() => repositoryAssetUrl('https://raw.githubusercontent.com/o/r/abc/', '../secret')).toThrow(/PET_PATH_INVALID/u)
  })
})

describe('stripJsonc', () => {
  it('strips comments and trailing commas but respects strings', () => {
    const text = '{\n  // line\n  "a": "http://x//y",\n  /* block */\n  "b": [1, 2,],\n}'
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: 'http://x//y', b: [1, 2] })
  })
})

describe('animationNames', () => {
  it('collects names from pools, motions, events and categories', () => {
    const names = animationNames({
      animations: {
        idle: ['idle-a', 'idle-b'],
        clicks: ['wave'],
        motions: { dragging: 'lifted' },
        events: { workStatus: ['think', 'work'] },
        categories: [{ actions: ['dance', 'sing'] }],
        moves: { actions: [{ name: 'walk' }] },
      },
    })
    for (const expected of ['idle-a', 'idle-b', 'wave', 'lifted', 'think', 'work', 'dance', 'sing', 'walk'])
      expect(names).toContain(expected)
  })
})

describe('repositoryHead', () => {
  it('returns the lowercased commit sha', async () => {
    const fetchImpl = fakeFetch({ [`https://api.github.com/repos/o/r/commits/HEAD`]: JSON.stringify({ sha: SHA.toUpperCase() }) })
    expect(await repositoryHead(fetchImpl, 'o', 'r')).toBe(SHA)
  })

  it('rejects a malformed sha', async () => {
    const fetchImpl = fakeFetch({ [`https://api.github.com/repos/o/r/commits/HEAD`]: JSON.stringify({ sha: 'nope' }) })
    await expect(repositoryHead(fetchImpl, 'o', 'r')).rejects.toThrow(/PET_REPOSITORY_INVALID/u)
  })
})

describe('readRepositorySpec', () => {
  const base = `https://raw.githubusercontent.com/o/r/${SHA}/`

  it('falls back to the default manifest when pet.json is absent', async () => {
    const fetchImpl = fakeFetch({
      [`${base}pet.json`]: null,
      [`${base}config.jsonc`]: '{"animations":{"idle":["idle"]}}',
    })
    const spec = await readRepositorySpec(fetchImpl, base, 'r', false)
    expect(spec.id).toBe('r')
    expect(spec.kind).toBe('dsh')
    expect(spec.config).toBe(`${base}config.jsonc`)
    expect(spec.uri.default).toBe(`${base}webm`)
    expect(spec.image).toBe(`${base}preview/preview.gif`)
    expect(spec.remote).toBe(true)
  })

  it('honours the manifest paths when present', async () => {
    const fetchImpl = fakeFetch({
      [`${base}pet.json`]: JSON.stringify({
        id: 'declared',
        kind: 'dsh',
        displayName: 'Declared',
        configPath: 'assets/config.jsonc',
        uriPath: 'assets/webm',
        previewPath: 'preview/p.gif',
        ext: { default: 'webm', mac: 'mov' },
        size: 220,
      }),
      [`${base}assets/config.jsonc`]: '{}',
    })
    const spec = await readRepositorySpec(fetchImpl, base, 'r', false)
    expect(spec.id).toBe('declared')
    expect(spec.name).toBe('Declared')
    expect(spec.config).toBe(`${base}assets/config.jsonc`)
    expect(spec.uri.default).toBe(`${base}assets/webm`)
    expect(spec.size).toBe(220)
  })

  it('refuses a non-dsh manifest', async () => {
    const fetchImpl = fakeFetch({
      [`${base}pet.json`]: JSON.stringify({ id: 'x', kind: 'codex', spritesheetPath: 'a.webp' }),
      [`${base}config.jsonc`]: '{}',
    })
    await expect(readRepositorySpec(fetchImpl, base, 'r', false)).rejects.toThrow(/PET_KIND_FORBIDDEN/u)
  })

  it('checks media availability on update', async () => {
    const fetchImpl = fakeFetch({
      [`${base}pet.json`]: null,
      [`${base}config.jsonc`]: '{"animations":{"idle":["idle"]}}',
      [`HEAD ${base}preview/preview.gif`]: '',
      [`HEAD ${base}webm/idle.webm`]: '',
    })
    const spec = await readRepositorySpec(fetchImpl, base, 'r', true)
    expect(spec.id).toBe('r')
  })

  it('reports a missing media file as PET_ASSET_INVALID', async () => {
    const fetchImpl = fakeFetch({
      [`${base}pet.json`]: null,
      [`${base}config.jsonc`]: '{"animations":{"idle":["idle"]}}',
      [`HEAD ${base}preview/preview.gif`]: '',
      // webm/idle.webm 故意缺失
    })
    await expect(readRepositorySpec(fetchImpl, base, 'r', true)).rejects.toThrow(/PET_ASSET_INVALID/u)
  })
})

describe('petRepositoryRevision + checkPetUpdates', () => {
  const base = `https://raw.githubusercontent.com/o/r/${SHA}/`

  it('extracts owner, name and commit from the config URL', () => {
    expect(petRepositoryRevision({ id: 'r', name: 'r', config: `${base}config.jsonc`, uri: { default: `${base}webm` } } as never))
      .toEqual({ owner: 'o', name: 'r', current: SHA })
  })

  it('rejects a non-github config URL', () => {
    expect(() => petRepositoryRevision({ id: 'r', name: 'r', config: 'https://example.com/x', uri: { default: '' } } as never))
      .toThrow(/PET_REPOSITORY_INVALID/u)
  })

  it('reports ids whose HEAD moved and skips built-in entries', async () => {
    const newer = 'b'.repeat(40)
    const fetchImpl = fakeFetch({ [`https://api.github.com/repos/o/r/commits/HEAD`]: JSON.stringify({ sha: newer }) })
    const specs = [
      { id: 'r', name: 'r', remote: true, config: `${base}config.jsonc`, uri: { default: `${base}webm` } },
      { id: 'builtin', name: 'b', remote: false, config: `${base}config.jsonc`, uri: { default: `${base}webm` } },
    ]
    expect(await checkPetUpdates(fetchImpl, specs as never)).toEqual(['r'])
  })

  it('reports nothing when the commit is unchanged', async () => {
    const fetchImpl = fakeFetch({ [`https://api.github.com/repos/o/r/commits/HEAD`]: JSON.stringify({ sha: SHA }) })
    const specs = [{ id: 'r', name: 'r', remote: true, config: `${base}config.jsonc`, uri: { default: `${base}webm` } }]
    expect(await checkPetUpdates(fetchImpl, specs as never)).toEqual([])
  })
})
