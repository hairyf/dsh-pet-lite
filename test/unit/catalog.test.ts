import { describe, expect, it } from 'vitest'
import { builtInCatalog, mergeCatalog, presetAsset, safePresetId } from '../../src/host/catalog'

/**
 * 预设清单契约：内置条目（与 apps/desktop `resources/manifest.jsonc` 的
 * `pets.built-in` 同源）、登记条目合并顺序、以及 id 安全性。
 */
describe('host/catalog', () => {
  it('ships the same two built-in presets as the desktop app', () => {
    const ids = builtInCatalog().map(item => item.id)
    expect(ids).toContain('maid-deepseek-whale')
    expect(ids).toContain('dsh-chan-sticker-pet')
  })

  it('exposes every field the renderer needs', () => {
    for (const item of builtInCatalog()) {
      expect(item.name.length).greaterThan(0)
      expect(item.kind).toBe('dsh')
      expect(item.config.startsWith('https://')).toBe(true)
      expect(item.uri.default.startsWith('https://')).toBe(true)
      expect(item.ext?.default).toBe('webm')
      // macOS 走 HEVC-alpha 的 mov（Safari/WKWebView 不认 webm alpha）。
      expect(item.ext?.mac).toBe('mov')
      expect(item.remote).toBe(false)
    }
  })

  it('puts built-in entries first and drops registered duplicates', () => {
    const remote = [
      { id: 'maid-deepseek-whale', name: 'Dup', config: 'x', uri: { default: 'y' } },
      { id: 'custom-pet', name: 'Custom', config: 'x', uri: { default: 'y' } },
    ]
    const merged = mergeCatalog(remote as never)
    expect(merged.filter(item => item.id === 'maid-deepseek-whale')).toHaveLength(1)
    expect(merged.at(-1)?.id).toBe('custom-pet')
    expect(merged.at(-1)?.remote).toBe(true)
  })

  it('projects a preset into pet-component render params', () => {
    const item = builtInCatalog()[0]!
    const asset = presetAsset(item)
    expect(asset.kind).toBe('dsh')
    if (asset.kind === 'dsh') {
      expect(asset.config).toBe(item.config)
      expect(asset.uri.default).toBe(item.uri.default)
      expect(asset.ext?.default).toBe('webm')
    }
  })

  it('accepts only safe preset ids', () => {
    expect(safePresetId('maid-deepseek-whale')).toBe(true)
    expect(safePresetId('../etc/passwd')).toBe(false)
    expect(safePresetId('a b')).toBe(false)
    expect(safePresetId('')).toBe(false)
    expect(safePresetId('x'.repeat(65))).toBe(false)
  })
})
