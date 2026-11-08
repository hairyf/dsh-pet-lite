import { describe, expect, it } from 'vitest'
import { clampPetPosition, cornerPetPosition } from '../../src/renderer/placement'

/**
 * 落点契约：宠物包围盒（不是窗口）必须整只落在工作区内。
 *
 * 这两组用例钉的是那个真实回归：宿主启动后宠物落在屏幕右下角，200% 档位下右半边伸到
 * 工作区外，被屏幕边缘裁掉半个身子（本机工作区 2560×1392，宠物 400×225 落在 2350,1207，
 * 右边缘 2750、下边缘 1432，分别溢出 190 / 40）。
 */
const AREA = { x: 0, y: 0, width: 2560, height: 1392 }
/** 宠物高宽比 9/16，与 `PET_ASPECT` 同值。 */
const petHeight = (width: number): number => width * 9 / 16

describe('cornerPetPosition', () => {
  it('sits the pet inside the bottom-right corner with the given inset', () => {
    const width = 400
    const height = petHeight(width)
    const position = cornerPetPosition(width, height, AREA, 24)
    expect(position.x + width).toBe(AREA.width - 24)
    expect(position.y + height).toBe(AREA.height - 24)
  })

  it('keeps the whole pet on screen for every size preset', () => {
    for (const percent of [50, 100, 150, 200]) {
      const width = 200 * percent / 100
      const height = petHeight(width)
      const { x, y } = cornerPetPosition(width, height, AREA, 24)
      expect(x).toBeGreaterThanOrEqual(AREA.x)
      expect(y).toBeGreaterThanOrEqual(AREA.y)
      expect(x + width).toBeLessThanOrEqual(AREA.x + AREA.width)
      expect(y + height).toBeLessThanOrEqual(AREA.y + AREA.height)
    }
  })

  it('falls back to the work-area origin when the pet is larger than the screen', () => {
    const width = 4000
    const height = petHeight(width)
    const position = cornerPetPosition(width, height, AREA, 24)
    expect(position).toEqual({ x: AREA.x + 24, y: AREA.y + 24 })
  })
})

describe('clampPetPosition', () => {
  it('pulls a pet that sticks out of the right / bottom edge back inside', () => {
    const width = 400
    const height = petHeight(width)
    const clamped = clampPetPosition({ x: 2350, y: 1207 }, width, height, AREA, 24)
    expect(clamped.x + width).toBe(AREA.width - 24)
    expect(clamped.y + height).toBe(AREA.height - 24)
  })

  it('leaves a pet that already fits untouched', () => {
    expect(clampPetPosition({ x: 1000, y: 600 }, 200, petHeight(200), AREA, 24)).toEqual({ x: 1000, y: 600 })
  })

  it('honours a work area that does not start at the origin', () => {
    const secondary = { x: 2560, y: 0, width: 1920, height: 1080 }
    const clamped = clampPetPosition({ x: 0, y: 0 }, 200, petHeight(200), secondary)
    expect(clamped).toEqual({ x: 2560, y: 0 })
  })
})
