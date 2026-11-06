/**
 * renderer/index.tsx — Electron 桌宠窗口的渲染端。
 *
 * 复刻 apps/desktop `src/pet/app.tsx` 的职责划分：窗口里只渲染 `<Pet>`（来自
 * dsh-pet-component，与 Tauri 桌面端用的是同一个组件），加上
 *   1. 从宿主路由读当前选择与状态；
 *   2. 订阅宿主 SSE 把会话活动映射成 `motion`（思考/工作/成功/失败）；
 *   3. 指针命中判定 → IPC 翻转窗口可交互性；
 *   4. 拖拽 → IPC 移动窗口（窗口跟随宠物，而不是宠物跟随窗口）。
 *
 * 与上游的差异：
 *   - 上游用 Tauri `invoke` / `getCurrentWindow()` / `device-mouse-move` 设备流；
 *     这里用 `fetch` 宿主路由 + `window.petBridge` + DOM `pointermove`。
 *   - 上游做抛掷物理、多显示器夹取、气泡跟踪；本渲染端只保留拖拽与状态映射。
 */

import type { DshPetConfig, MotionInput, PetRef } from 'dsh-pet-component'
import type { PetCatalog, PetRuntimeStatus, PetSessionPayload, PetStatus, PetWorkStatus, PresetPetItem } from '../shared/types'
import { Pet, useControllablePet } from 'dsh-pet-component'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

/** 宿主 origin 与配置地址（由 main.js 经查询串传入）。 */
const params = new URLSearchParams(window.location.search)
const ORIGIN = params.get('origin') ?? ''

/** 宠物基准渲染宽度（px，100% 档位）。 */
const PET_BASE_WIDTH = 200
/** 窗口四周留白（与 main.js 的 WINDOW_MARGIN 一致）。 */
const WINDOW_MARGIN = 48

/** Electron preload 暴露面。 */
interface PetBridge {
  openExternal: (url: string) => void
  setBounds: (x: number, y: number, width: number, height: number) => void
  setInteractive: (interactive: boolean) => void
  setSize: (sizePercent: number) => void
}

declare global {
  interface Window {
    petBridge?: PetBridge
  }
}

/** 工作状态 → 组件动作（与上游 `usePetStatus`/`useBubbleTracker` 同一套档位语义）。 */
const STATUS_MOTION: Record<PetWorkStatus, MotionInput> = {
  thinking: { type: 'thinking', loop: true },
  working: { type: 'working', loop: true },
  result: { type: 'result', loop: true },
  waiting: { type: 'waiting', loop: true },
  success: 'success',
  error: 'failed',
}

/** 归一化大小百分比（缺省 / 非法 / 越界收敛进合法区间）。 */
function normalizeSize(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return 100
  return Math.min(200, Math.max(50, value))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 在页面底部显示一条错误（透明窗口里「什么都没有」与「坏了」观感相同）。 */
function showError(text: string): void {
  const node = document.getElementById('error')
  if (!node)
    return
  node.textContent = text
  node.style.display = 'block'
}

function clearError(): void {
  const node = document.getElementById('error')
  if (node)
    node.style.display = 'none'
}

/** 读取宿主状态（选择 / 启用 / 大小）。 */
async function fetchStatus(): Promise<PetStatus> {
  const response = await fetch(`${ORIGIN}/dsh-pet-lite/settings`, { cache: 'no-store' })
  if (!response.ok)
    throw new Error(`PET_STATUS_FAILED: ${response.status}`)
  return (await response.json()) as PetRuntimeStatus
}

/** 读取预设清单并解析出当前宠物的渲染参数。 */
async function fetchPreset(activeId: string): Promise<PresetPetItem | null> {
  const response = await fetch(`${ORIGIN}/dsh-pet-lite/catalog`, { cache: 'no-store' })
  if (!response.ok)
    throw new Error(`PET_CATALOG_FAILED: ${response.status}`)
  const catalog = (await response.json()) as PetCatalog
  return catalog.presetPets.find(item => item.id === activeId) ?? null
}

/**
 * 预设配置：把清单条目转成 `<Pet>` 的 props。
 *
 * `config` 走宿主代理（`/dsh-pet-lite/config?id=…`）而不是远端直连 —— 页面是 `file://`，
 * 直连会撞 CORS，且远端可能被墙。素材（webm/mov）由 `<video>` 直接加载，不受 CORS 限制。
 */
function petConfigSource(item: PresetPetItem): string {
  return `${ORIGIN}/dsh-pet-lite/config?id=${encodeURIComponent(item.id)}`
}

function App(): React.ReactElement | null {
  const petRef = useRef<PetRef>(null)
  const pet = useControllablePet(petRef)
  const hitboxRef = useRef<HTMLDivElement>(null)

  const [status, setStatus] = useState<PetStatus | null>(null)
  const [preset, setPreset] = useState<PresetPetItem | null>(null)
  const [motion, setMotion] = useState<MotionInput>('idle')
  const [dragging, setDragging] = useState(false)

  // --- 状态与清单 ------------------------------------------------------

  useEffect(() => {
    let cancelled = false
    void fetchStatus()
      .then((next) => {
        if (cancelled)
          return
        setStatus(next)
        clearError()
      })
      .catch(error => showError(`无法读取宠物状态：${messageOf(error)}`))
    return () => {
      cancelled = true
    }
  }, [])

  const activeId = status?.active_pet ?? ''
  useEffect(() => {
    if (!activeId) {
      setPreset(null)
      return
    }
    let cancelled = false
    void fetchPreset(activeId)
      .then((item) => {
        if (cancelled)
          return
        setPreset(item)
        if (!item)
          showError(`找不到宠物：${activeId}`)
        else
          clearError()
      })
      .catch(error => showError(`无法读取宠物清单：${messageOf(error)}`))
    return () => {
      cancelled = true
    }
  }, [activeId])

  // 尺寸变化时让主进程重设窗口大小。
  const sizePercent = normalizeSize(status?.pet_size)
  useEffect(() => {
    window.petBridge?.setSize(sizePercent)
  }, [sizePercent])

  // --- 会话状态 → 动作 -------------------------------------------------

  useEffect(() => {
    if (!ORIGIN)
      return
    const source = new EventSource(`${ORIGIN}/dsh-pet-lite/session/stream`)
    source.onmessage = (event) => {
      try {
        const root = JSON.parse(event.data) as { action?: string, payload?: PetSessionPayload }
        const workStatus = root.payload?.workStatus
        if (workStatus && workStatus in STATUS_MOTION)
          setMotion(STATUS_MOTION[workStatus])
      }
      catch {
        /* 非法帧：忽略，不打断播放 */
      }
    }
    return () => source.close()
  }, [])

  // --- 命中判定 → 点击穿透 ---------------------------------------------

  const setInteractive = useCallback((next: boolean) => {
    window.petBridge?.setInteractive(next)
  }, [])

  /**
   * 指针进/出宠物身体时才翻转可交互性。
   *
   * 窗口整窗穿透（`setIgnoreMouseEvents(true, {forward: true})`）时仍会收到 `mousemove`，
   * 这里据此判定 —— 与上游 `useOmitIgnoreCursorEvents` 同一套思路，但省掉了屏幕坐标换算：
   * 窗口内容坐标就是 `clientX/clientY`，命中箱的 `getBoundingClientRect()` 直接可比。
   */
  useEffect(() => {
    function handlePointerMove(event: PointerEvent): void {
      if (dragging)
        return
      const element = hitboxRef.current
      if (!element) {
        setInteractive(false)
        return
      }
      const rect = element.getBoundingClientRect()
      const inside
        = event.clientX >= rect.left
          && event.clientX <= rect.right
          && event.clientY >= rect.top
          && event.clientY <= rect.bottom
      setInteractive(inside)
    }
    function handleLeave(): void {
      if (!dragging)
        setInteractive(false)
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerleave', handleLeave)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerleave', handleLeave)
    }
  }, [dragging, setInteractive])

  // --- 拖拽 → 移动窗口 -------------------------------------------------

  const dragRef = useRef<{ pointerId: number, startX: number, startY: number } | null>(null)

  const onHitboxPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0)
      return
    dragRef.current = { pointerId: event.pointerId, startX: event.screenX, startY: event.screenY }
    setDragging(true)
    setInteractive(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [setInteractive])

  const onHitboxPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId)
      return
    // 窗口跟随指针：用屏幕坐标差值直接下发窗口左上角，避免「窗口动 → clientX 变」的回环。
    const dx = event.screenX - drag.startX
    const dy = event.screenY - drag.startY
    drag.startX = event.screenX
    drag.startY = event.screenY
    moveWindowBy(dx, dy)
  }, [])

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId)
      return
    dragRef.current = null
    setDragging(false)
  }, [])

  // --- 渲染 ------------------------------------------------------------

  const config = useMemo<DshPetConfig | string | null>(() => {
    if (!preset)
      return null
    // 上游把 `config` 当远端地址交给组件（组件自带 JSONC 解析 + 缓存）；
    // 这里改走宿主代理地址，解析器与缓存行为一致。
    return petConfigSource(preset)
  }, [preset])

  const uri = preset?.uri ?? { default: '' }
  const ext = preset?.ext ?? { default: 'webm', mac: 'mov' }
  const width = (preset?.size ?? PET_BASE_WIDTH) * sizePercent / 100

  if (!status || !preset || !config)
    return null

  return (
    <div
      style={{
        position: 'absolute',
        left: WINDOW_MARGIN,
        top: WINDOW_MARGIN,
        pointerEvents: 'none',
        cursor: dragging ? 'grabbing' : 'grab',
      }}
    >
      <Pet
        ref={petRef}
        kind={preset.kind === 'codex' ? 'codex' : 'dsh'}
        config={config}
        uri={uri}
        ext={ext}
        size={width}
        motion={motion}
        dragging={dragging}
        cache={false}
        hitboxRef={hitboxRef}
        onHitboxPointerDown={onHitboxPointerDown}
        onHitboxPointerMove={onHitboxPointerMove}
        onHitboxPointerUp={endDrag}
        onHitboxPointerCancel={endDrag}
        onDoubleClick={() => pet.motion({ type: 'waving' })}
        onError={error => showError(`宠物素材加载失败：${messageOf(error)}`)}
      />
    </div>
  )
}

/** 让窗口按屏幕坐标增量移动（读当前 bounds 由主进程负责，这里只发增量）。 */
let lastBounds: { x: number, y: number, width: number, height: number } | null = null

function moveWindowBy(dx: number, dy: number): void {
  if (!lastBounds)
    return
  const next = {
    x: Math.round(lastBounds.x + dx),
    y: Math.round(lastBounds.y + dy),
    width: lastBounds.width,
    height: lastBounds.height,
  }
  lastBounds = next
  window.petBridge?.setBounds(next.x, next.y, next.width, next.height)
}

/**
 * 初始化窗口尺寸上报。
 *
 * 渲染端不知道窗口当前在哪：先按自己算出的尺寸与「右下角锚点」发一次完整矩形，主进程
 * 据此落位；此后拖拽只发改动量（`moveWindowBy`）。
 */
function seedBounds(): void {
  const width = PET_BASE_WIDTH + WINDOW_MARGIN * 2
  const height = Math.round((PET_BASE_WIDTH * 9) / 16) + WINDOW_MARGIN * 2
  // 屏幕坐标由 `window.screenX/screenY` 提供（Electron 下即窗口左上角）。
  const x = window.screenX
  const y = window.screenY
  lastBounds = { x, y, width, height }
  window.petBridge?.setBounds(x, y, width, height)
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('DSH_PET_LITE_LAYOUT_MISSING: #root was not found')
}
createRoot(container).render(<App />)
seedBounds()
