import { describe, expect, it } from 'vitest'
import {
  DEAD_ZONE_SPEED,
  DEFAULT_PHYSICS,
  estimateReleaseVelocity,
  MAX_STEP_DT,
  MAX_THROW_SPEED,
  softClampSpeed,
  springStep,
  throwBounds,
  throwBoundsIn,
  throwStep,
  trimTrail,
} from '../../src/renderer/physics'

/**
 * 拖动 / 甩抛物理的契约测试。
 *
 * 这些公式**逐字移植自 dsh-pet**，因此断言也按 dsh-pet 的物理语义写：
 * 弹簧单调收敛、软钳速渐近不超上限、释放初速有死区、抛掷会落地并静止。
 * 数值一旦被改动（手感变了），这些用例就应该红。
 */
describe('springStep', () => {
  it('pulls toward the target monotonically and converges', () => {
    let v = 0
    let x = 0
    const target = 100
    let last = -1
    for (let i = 0; i < 400; i++) {
      v = springStep(v, x, target, 1 / 60, DEFAULT_PHYSICS.throwPower)
      x += v / 60
      expect(x).toBeGreaterThanOrEqual(last * 0.99)
      last = x
    }
    expect(x).toBeCloseTo(target, 0)
  })

  it('scales with throwPower (larger power converges faster)', () => {
    const slow = springStep(0, 0, 100, 1 / 60, 0.5)
    const fast = springStep(0, 0, 100, 1 / 60, 2)
    expect(Math.abs(fast)).toBeGreaterThan(Math.abs(slow))
  })
})

describe('softClampSpeed', () => {
  it('is monotonic and asymptotically bounded by the ceiling', () => {
    let previous = -1
    // 注意上限是**渐近**的：浮点下 `1 - e^(-s/cap)` 在极大输入时会精确等于 1，
    // 因此断言用 `<=`（与 dsh-pet 的实现语义一致：任意速度都单调可区分且不超过上限）。
    for (const speed of [0, 100, 1000, 5000, 50_000, 1e9]) {
      const clamped = softClampSpeed(speed)
      expect(clamped).toBeGreaterThanOrEqual(previous)
      expect(clamped).toBeLessThanOrEqual(MAX_THROW_SPEED)
      previous = clamped
    }
    // 中等输入必须严格低于上限（渐近而非硬夹）。
    expect(softClampSpeed(1000)).toBeLessThan(MAX_THROW_SPEED)
  })

  it('returns 0 for non-positive input', () => {
    expect(softClampSpeed(0)).toBe(0)
    expect(softClampSpeed(-10)).toBe(0)
  })
})

describe('trimTrail', () => {
  it('drops samples older than the retention window', () => {
    const trail = [
      { t: 0, x: 0, y: 0 },
      { t: 500, x: 10, y: 0 },
      { t: 900, x: 20, y: 0 },
    ]
    expect(trimTrail(trail, 1000).map(sample => sample.t)).toEqual([900])
  })

  it('keeps everything inside the window', () => {
    const trail = [{ t: 950, x: 0, y: 0 }, { t: 990, x: 1, y: 0 }]
    expect(trimTrail(trail, 1000)).toHaveLength(2)
  })
})

describe('estimateReleaseVelocity', () => {
  it('returns null when the trail is empty', () => {
    expect(estimateReleaseVelocity([], 1000)).toBeNull()
  })

  it('returns null when the release is stale', () => {
    const trail = [{ t: 0, x: 0, y: 0 }, { t: 100, x: 300, y: 0 }]
    // 松手时间远晚于最后一次采样 → 不跨窗口拼接速度。
    expect(estimateReleaseVelocity(trail, 1000)).toBeNull()
  })

  it('returns null when the trail is nearly still (gentle drop)', () => {
    const now = 1000
    const trail = Array.from({ length: 6 }, (_, index) => ({ t: now - 100 + index * 20, x: index * 0.1, y: 0 }))
    expect(estimateReleaseVelocity(trail, now)).toBeNull()
  })

  it('gives a fast rightward throw for a fast rightward drag', () => {
    const now = 1000
    const trail = [
      { t: now - 80, x: 0, y: 0 },
      { t: now - 60, x: 100, y: 0 },
      { t: now - 40, x: 220, y: 0 },
      { t: now - 20, x: 360, y: 0 },
    ]
    const velocity = estimateReleaseVelocity(trail, now)
    expect(velocity).not.toBeNull()
    expect(velocity!.vx).toBeGreaterThan(DEAD_ZONE_SPEED)
    expect(Math.abs(velocity!.vy)).toBeLessThan(1)
  })

  it('keeps the throw direction when dragging diagonally', () => {
    const now = 1000
    const trail = [
      { t: now - 60, x: 0, y: 0 },
      { t: now - 40, x: 100, y: 100 },
      { t: now - 20, x: 200, y: 200 },
    ]
    const velocity = estimateReleaseVelocity(trail, now)
    expect(velocity).not.toBeNull()
    // 右下方向：vx 与 vy 同号且量级接近。
    expect(velocity!.vx).toBeGreaterThan(0)
    expect(velocity!.vy).toBeGreaterThan(0)
    expect(Math.abs(velocity!.vx - velocity!.vy)).toBeLessThan(velocity!.vx * 0.2)
  })
})

describe('throwBounds', () => {
  it('allows the body to hang off the sides but not below the floor', () => {
    const bounds = throwBounds({ W: 1000, H: 800, size: 200, sideAllow: 24 })
    expect(bounds.minX).toBe(-24)
    expect(bounds.maxX).toBe(1000 - 200 + 24)
    expect(bounds.minY).toBe(0)
    // 高度 = 宽 × 9/16
    expect(bounds.maxY).toBe(800 - (200 * 9) / 16)
  })
})

describe('throwBoundsIn', () => {
  it('uses the work area origin, not a zero origin', () => {
    // 副屏工作区原点在 (1920, 200)：宠物必须能到那块屏，而不是被夹回首屏。
    const area = { x: 1920, y: 200, width: 1280, height: 1024 }
    const bounds = throwBoundsIn(area, 200, 24)
    expect(bounds.minX).toBe(1920 - 24)
    expect(bounds.maxX).toBe(1920 + 1280 - 200 + 24)
    expect(bounds.minY).toBe(200)
    expect(bounds.maxY).toBe(200 + 1024 - (200 * 9) / 16)
  })

  it('covers a full work area (regression: dragging only moved within a tiny patch)', () => {
    // 这个 bug 的本质是拿窗口自身尺寸当边界。工作区应当让宠物横跨整个屏幕宽度：
    // 跨度 = 屏宽 − 宠物宽 + 两侧各 24px 余量 = 2560 − 200 + 48。
    const area = { x: 0, y: 0, width: 2560, height: 1400 }
    const bounds = throwBoundsIn(area, 200, 24)
    expect(bounds.maxX - bounds.minX).toBe(2560 - 200 + 48)
  })
})

describe('throwStep', () => {
  const bounds = throwBounds({ W: 1000, H: 800, size: 200, sideAllow: 24 })

  it('applies gravity and moves the body', () => {
    const next = throwStep({ x: 100, y: 100, vx: 0, vy: 0 }, 1 / 60, bounds)
    expect(next.vy).toBeGreaterThan(0)
    expect(next.y).toBeGreaterThan(100)
  })

  it('clamps the step to MAX_STEP_DT so a stalled tab cannot teleport', () => {
    const short = throwStep({ x: 0, y: 0, vx: 0, vy: 0 }, 1 / 240, bounds)
    const huge = throwStep({ x: 0, y: 0, vx: 0, vy: 0 }, 10, bounds)
    // 巨帧只按 MAX_STEP_DT 积分，不会直接把宠物甩到地板。
    expect(huge.y).toBeLessThan(1 + 0.5 * DEFAULT_PHYSICS.gravity * MAX_STEP_DT * MAX_STEP_DT + 1)
    expect(short.y).toBeGreaterThan(0)
  })

  it('bounces off the floor and eventually comes to rest', () => {
    let state = { x: 100, y: 100, vx: 0, vy: 0 }
    let bounced = false
    let rested = false
    for (let i = 0; i < 2000 && !rested; i++) {
      const next = throwStep(state, 1 / 60, bounds)
      state = { x: next.x, y: next.y, vx: next.vx, vy: next.vy }
      if (next.bounced)
        bounced = true
      if (next.atRest)
        rested = true
    }
    expect(bounced).toBe(true)
    expect(rested).toBe(true)
    // 静止时贴在底部边界上。
    expect(state.y).toBeCloseTo(bounds.maxY, 0)
  })

  it('keeps the body inside the horizontal bounds', () => {
    let state = { x: 500, y: 100, vx: 4000, vy: 0 }
    for (let i = 0; i < 600; i++) {
      const next = throwStep(state, 1 / 60, bounds)
      state = { x: next.x, y: next.y, vx: next.vx, vy: next.vy }
      expect(state.x).toBeGreaterThanOrEqual(bounds.minX)
      expect(state.x).toBeLessThanOrEqual(bounds.maxX)
    }
  })
})
