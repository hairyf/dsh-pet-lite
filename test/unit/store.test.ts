import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetCache, snapshot, state, update } from '../../src/host/store'

/**
 * store 的动作语义测试：默认值、大小归一化、可见性推导、字段独立。
 *
 * 这些是设置页与桌宠窗口共同依赖的契约 —— 断言口径与上游同款
 * （见 `source/deepseek-harness-desktop/packages/builtin-plugin-pet`）。
 *
 * 每个用例用**全新的临时 `DSH_HOME`**：开发机上可能已经存在真实的
 * `~/.dsh/pet-lite/pet.json`（自己装过插件、跑过 E2E），读到它会让「默认值」这类
 * 断言红绿都毫无意义。
 */
const savedHome = process.env.DSH_HOME
let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-pet-lite-store-'))
  process.env.DSH_HOME = home
  resetCache()
})

afterEach(() => {
  if (savedHome === undefined)
    delete process.env.DSH_HOME
  else
    process.env.DSH_HOME = savedHome
  resetCache()
  rmSync(home, { recursive: true, force: true })
})

describe('host/store', () => {
  it('defaults to the first built-in preset, disabled', () => {
    const value = state()
    expect(value.enabled).toBe(false)
    expect(value.throw_enabled).toBe(false)
    expect(value.pet_size).toBe(100)
    expect(value.active_pet).length.greaterThan(0)
  })

  it('clamps size into the supported range', () => {
    expect(update({ pet_size: 5 }).pet_size).toBe(50)
    expect(update({ pet_size: 999 }).pet_size).toBe(200)
    expect(update({ pet_size: 120 }).pet_size).toBe(120)
    // 非数字回落到默认值，而不是 NaN。
    expect(update({ pet_size: 'abc' as never }).pet_size).toBe(100)
  })

  it('derives visibility from enabled + a non-empty selection', () => {
    update({ enabled: false, active_pet: 'maid-deepseek-whale' })
    expect(snapshot({ desktopSupported: false, desktopOpen: false }).visible).toBe(false)

    update({ enabled: true })
    expect(snapshot({ desktopSupported: false, desktopOpen: false }).visible).toBe(true)

    update({ active_pet: '' })
    // 无选择时必然不可见：没有内容可渲染，不留空窗口。
    expect(snapshot({ desktopSupported: false, desktopOpen: false }).visible).toBe(false)
  })

  it('carries desktop capability through the snapshot', () => {
    update({ enabled: true })
    const value = snapshot({ desktopSupported: true, desktopOpen: true })
    expect(value.desktop_supported).toBe(true)
    expect(value.desktop_open).toBe(true)
  })

  it('keeps the persisted fields independent', () => {
    update({ throw_enabled: true })
    const value = state()
    expect(value.throw_enabled).toBe(true)
    // 只改一个字段，其它字段保持原值。
    expect(value.pet_size).toBe(100)
  })

  it('round-trips through the settings file', () => {
    update({ enabled: true, pet_size: 130, throw_enabled: true, active_pet: 'dsh-chan-sticker-pet' })
    // 丢弃内存态，强制从磁盘重读 —— 这是「重启后仍然记得」的契约。
    resetCache()
    const value = state()
    expect(value.enabled).toBe(true)
    expect(value.pet_size).toBe(130)
    expect(value.throw_enabled).toBe(true)
    expect(value.active_pet).toBe('dsh-chan-sticker-pet')
  })
})
