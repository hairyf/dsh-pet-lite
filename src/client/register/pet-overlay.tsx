import type { DshPetConfig, MotionInput, PetRef } from 'dsh-pet-component'
import type { PetAsset, PetStatus, PetWorkStatus } from '../../shared/types'
import type { ClientContext } from '../sdk'
import { Pet, useControllablePet } from 'dsh-pet-component'
import { useEffect, useMemo, useRef, useState } from 'react'
import { PLUGIN_ID } from '../../shared/constants'
import { defineRegister, invoke, useStore } from '../sdk'
import { store } from '../store'

/**
 * register/pet-overlay.ts — 应用内桌宠浮层（`shell.overlay`）。
 *
 * Tauri 桌面端的宠物是**独立窗口**；浏览器里没有独立窗口，因此这里把同一个
 * `dsh-pet-component` 的 `<Pet>` 挂进官方壳层的全屏浮层席位：
 *
 * - `shell.overlay` 是 list 席位、root 作用域、**整层点击穿透**，条目要自己 opt-in 指针事件；
 * - 位置固定右下角，尺寸跟随设置页的 `pet_size`；
 * - 动作跟随会话活动（与 Electron 窗口同一套六档映射）。
 *
 * 这一层与独立窗口并存：`desktop_supported` 为真时用户也可以只开窗口。
 */

const PET_BASE_WIDTH = 220
/** 浮层内边距（右下角留白）。 */
const MARGIN = 24

/** 工作状态 → 组件动作（与 Electron 渲染端同一套档位语义）。 */
const STATUS_MOTION: Record<PetWorkStatus, MotionInput> = {
  thinking: { type: 'thinking', loop: true },
  working: { type: 'working', loop: true },
  result: { type: 'result', loop: true },
  waiting: { type: 'waiting', loop: true },
  success: 'success',
  error: 'failed',
}

function normalizeSize(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return 100
  return Math.min(200, Math.max(50, value))
}

/** 浮层里的桌宠本体。 */
export function PetOverlay(): null | React.ReactElement {
  const petRef = useRef<PetRef>(null)
  const pet = useControllablePet(petRef)
  const { status } = useStore(store.pet)

  const [asset, setAsset] = useState<PetAsset | null>(null)
  const [motion, setMotion] = useState<MotionInput>('idle')
  const [dragging, setDragging] = useState(false)

  const current = status as (PetStatus & { desktop_supported?: boolean }) | null
  const activeId = current?.active_pet ?? ''
  const visible = Boolean(current?.enabled) && activeId !== ''

  // 解析当前宠物的渲染参数（预设直连远端；本地宠物读盘）。
  useEffect(() => {
    if (!activeId) {
      setAsset(null)
      return
    }
    let cancelled = false
    void invoke<PetAsset>('get_pet_asset', { id: activeId })
      .then((next) => {
        if (!cancelled)
          setAsset(next)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.warn('[dsh-pet-lite] overlay asset resolve failed:', error)
          setAsset(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeId])

  // 会话活动 → 动作。
  useEffect(() => {
    const source = new EventSource('/dsh-pet-lite/session/stream')
    source.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as { payload?: { workStatus?: PetWorkStatus } }
        const workStatus = frame.payload?.workStatus
        if (workStatus && workStatus in STATUS_MOTION)
          setMotion(STATUS_MOTION[workStatus])
      }
      catch {
        /* 非法帧：忽略，不打断播放 */
      }
    }
    return () => source.close()
  }, [])

  const config = useMemo<DshPetConfig | string | null>(() => (asset?.kind === 'dsh' ? asset.config : null), [asset])
  const uri = asset?.kind === 'dsh' ? asset.uri : undefined
  const ext = asset?.kind === 'dsh' ? asset.ext : undefined
  const width = (asset?.kind === 'dsh' ? (asset.size ?? PET_BASE_WIDTH) : PET_BASE_WIDTH) * normalizeSize(current?.pet_size) / 100

  if (!visible || !asset || asset.kind !== 'dsh' || !config || !uri)
    return null

  return (
    <div
      style={{
        position: 'fixed',
        right: MARGIN,
        bottom: MARGIN,
        width,
        // 浮层整层穿透，只有宠物本体（命中箱）接收指针事件。
        pointerEvents: 'none',
        cursor: dragging ? 'grabbing' : 'grab',
      }}
    >
      <div style={{ pointerEvents: 'auto' }}>
        <Pet
          ref={petRef}
          kind="dsh"
          config={config}
          uri={uri}
          ext={ext}
          size={width}
          motion={motion}
          dragging={dragging}
          cache
          onDoubleClick={() => pet.motion({ type: 'waving' })}
          onHitboxPointerDown={() => setDragging(true)}
          onHitboxPointerUp={() => setDragging(false)}
          onHitboxPointerCancel={() => setDragging(false)}
          onError={(error: unknown) => console.warn('[dsh-pet-lite] overlay pet error:', error)}
        />
      </div>
    </div>
  )
}

/** 把浮层注册进 `shell.overlay`（官方 list 席位，additive、默认穿透）。 */
export const petOverlayFeature = defineRegister((controller, ctx: ClientContext) => {
  controller.add(ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'dsh-pet-lite-overlay',
      order: 900,
      registrant: PLUGIN_ID,
    } as never,
    PetOverlay as never,
  )))
})
