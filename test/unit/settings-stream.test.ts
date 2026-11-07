import type { PetRuntimeStatus, SessionStreamSink } from '../../src/shared/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attachSettings,
  publishSettings,
  resetSettingsStream,
  settingsSinkCount,
} from '../../src/host/settings-stream'

/**
 * 设置推送流的契约测试。
 *
 * 这条流存在的唯一理由是「已经打开的桌宠窗口要立刻知道设置变了」：
 * 大小滑条、抛射开关、换宠物三项在改动前都只能等窗口重启才生效
 * （用户报告：「拖了大小不变」「明明关了抛射还是会飞」）。
 */
function sink(): SessionStreamSink & { frames: string[] } {
  const frames: string[] = []
  return {
    frames,
    push: (frame) => {
      frames.push(frame)
    },
    close: () => {},
  }
}

const status: PetRuntimeStatus = {
  active_pet: 'claude',
  enabled: true,
  pet_size: 150,
  throw_enabled: false,
  visible: true,
  desktop_supported: true,
  desktop_open: true,
  open_url: 'dsh://open',
}

afterEach(() => {
  resetSettingsStream()
})

describe('settingsStream', () => {
  it('broadcasts the authoritative status as a settings frame', () => {
    const consumer = sink()
    attachSettings(consumer)

    publishSettings(status)

    expect(consumer.frames).toHaveLength(1)
    const frame = JSON.parse(consumer.frames[0]!) as { action: string, payload: PetRuntimeStatus }
    expect(frame.action).toBe('settings')
    expect(frame.payload.pet_size).toBe(150)
    // 抛射开关必须原样透传：渲染端据此决定松手后是否甩出。
    expect(frame.payload.throw_enabled).toBe(false)
  })

  it('does nothing when nobody is listening', () => {
    expect(settingsSinkCount()).toBe(0)
    expect(() => publishSettings(status)).not.toThrow()
  })

  it('stops delivering after detach', () => {
    const consumer = sink()
    const detach = attachSettings(consumer)
    publishSettings(status)
    detach()
    publishSettings(status)
    expect(consumer.frames).toHaveLength(1)
    expect(settingsSinkCount()).toBe(0)
  })

  it('delivers to every attached window', () => {
    const first = sink()
    const second = sink()
    attachSettings(first)
    attachSettings(second)
    publishSettings(status)
    expect(first.frames).toHaveLength(1)
    expect(second.frames).toHaveLength(1)
  })

  it('closes consumers on reset (test helper)', () => {
    const consumer = sink()
    attachSettings(consumer)
    resetSettingsStream()
    expect(settingsSinkCount()).toBe(0)
  })
})
