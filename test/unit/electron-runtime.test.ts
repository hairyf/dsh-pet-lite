import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultElectronExe,
  electronLandingDir,
  HELPER_STABLE_MS,
  helperRunIsStable,
  resolveElectronPath,
  restartBackoffDelayMs,
  shouldCircuitBreak,
} from '../../src/host/electron-runtime'

/**
 * Electron 路径解析优先级 —— 完全照搬 dsh-pet 的三级候选，外加本插件新增的宿主注入
 * （`DSH_ELECTRON_PATH` / `DSH_NODE`）。
 *
 * 测试必须屏蔽宿主机状态：开发机上可能真的装了 `~/.dsh/electron`，那会让「都不存在」
 * 这类断言变绿或变红都毫无意义。因此每个用例都清掉相关环境变量，并把 `DSH_HOME`
 * 指到一个不存在的临时路径。
 */
const ENV_KEYS = [
  'DSH_ELECTRON_PATH',
  'DSH_NODE',
  'DSH_PET_ELECTRON_PATH',
] as const

const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  process.env.DSH_HOME = '/nonexistent/dsh-pet-lite-test-home'
})

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined)
      delete process.env[key]
    else
      process.env[key] = value
  }
  saved.clear()
})

describe('resolveElectronPath', () => {
  it('returns undefined when nothing exists', () => {
    expect(resolveElectronPath(['/definitely/missing-1', '/definitely/missing-2'])).toBeUndefined()
  })

  it('skips missing candidates and empty values', () => {
    expect(resolveElectronPath(['', undefined, '/definitely/missing'])).toBeUndefined()
  })

  it('honours the landing path definition', () => {
    // 唯一定义处：解析与下载都走这里，避免两处字面量漂移。
    expect(defaultElectronExe().startsWith(electronLandingDir())).toBe(true)
    expect(electronLandingDir().endsWith('electron')).toBe(true)
  })

  it('ignores a host-injected path that does not exist', () => {
    process.env.DSH_ELECTRON_PATH = '/definitely/missing-host-electron'
    process.env.DSH_NODE = '/also/missing/host-node'
    expect(resolveElectronPath()).toBeUndefined()
  })
})

/** 重启退避与熔断（上游同值：750ms 起 2× 封顶 30s，连续 12 次熔断）。 */
describe('helper restart policy', () => {
  it('backs off exponentially up to a 30s ceiling', () => {
    expect(restartBackoffDelayMs(0)).toBe(750)
    expect(restartBackoffDelayMs(1)).toBe(1500)
    expect(restartBackoffDelayMs(2)).toBe(3000)
    expect(restartBackoffDelayMs(10)).toBe(30_000)
    expect(restartBackoffDelayMs(50)).toBe(30_000)
  })

  it('trips the circuit breaker at 12 consecutive crashes', () => {
    expect(shouldCircuitBreak(11)).toBe(false)
    expect(shouldCircuitBreak(12)).toBe(true)
  })

  it('treats a 3-minute run as stable', () => {
    expect(helperRunIsStable(HELPER_STABLE_MS - 1)).toBe(false)
    expect(helperRunIsStable(HELPER_STABLE_MS)).toBe(true)
  })
})
