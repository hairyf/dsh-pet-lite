/**
 * renderer/index.tsx — Electron 桌宠窗口的渲染端。
 *
 * 拖动 / 甩抛 / 落地手感**逐字移植自 dsh-pet**（`source/dsh-pet/dsh-pet/runtime/
 * electron-helper/sprite/{input,motion}.js` + `src/shared/physics/*`）：
 *
 *   1. 按下：记下**屏幕坐标**起点与宠物当前位置（`clientX` 会随窗口移动变化，屏幕坐标稳定）；
 *   2. 移动：位移 < `DRAG_THRESHOLD` 不算拖拽；建立后把「起点 + 屏幕增量」作为弹簧目标，
 *      由 rAF 以过阻尼弹簧追赶（不再硬贴指针，抹平高频抖动）；
 *   3. 松手：按最近 150ms 轨迹估算初速，够快就甩出（重力 + 撞边反弹 + 地面摩擦），
 *      否则原地放下并记住相对视口的位置比例。
 *
 * 与 dsh-pet 的唯一差异是坐标系：dsh-pet 走 `toLocal()`/`toScreen()` 在 CSS px 与物理像素
 * 之间换算（它还带 DPI 线性化）；这里 `devicePixelRatio` 就是唯一换算点。
 */

import type { DshPetConfig, MotionInput, PetRef } from 'dsh-pet-component'
import type { PetAsset, PetRuntimeStatus, PetSessionPayload, PetStatus, PetWorkStatus } from '../shared/types'
import type { DragSample, PhysicsParams, ThrowBounds, ThrowState } from './physics'
import { Pet, useControllablePet } from 'dsh-pet-component'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  DEFAULT_PHYSICS,
  DRAG_THRESHOLD,
  estimateReleaseVelocity,
  MAX_STEP_DT,
  springStep,
  throwBoundsIn,
  throwStep,
  trimTrail,
} from './physics'

const params = new URLSearchParams(window.location.search)
const ORIGIN = params.get('origin') ?? ''

/** 宠物基准渲染宽度（px，100% 档位）。 */
const PET_BASE_WIDTH = 200
/** 宠物包围盒宽高比（dsh-pet 画布 640×360）。 */
const PET_ASPECT = 9 / 16

/** 主进程下发的初始几何（全部是屏幕坐标 / DIP）。 */
function num(key: string, fallback: number): number {
  const value = Number(params.get(key))
  return Number.isFinite(value) ? value : fallback
}

/** 窗口四周留白（主进程下发，与 main.cjs 的 WINDOW_MARGIN 同源）。 */
const WINDOW_MARGIN = num('margin', 48)
/** 窗口内容区左上角（屏幕坐标）。 */
const WIN_X = num('winX', 0)
const WIN_Y = num('winY', 0)
/** 工作区（屏幕坐标）—— 拖拽与抛掷的边界都按它算，不是按窗口自身尺寸。 */
const AREA = {
  x: num('areaX', 0),
  y: num('areaY', 0),
  width: num('areaWidth', window.screen.availWidth || 1920),
  height: num('areaHeight', window.screen.availHeight || 1080),
}

interface PetBridge {
  setBounds: (x: number, y: number, width: number, height: number) => void
  /** 拖拽期落位（屏幕坐标）：指针在窗口外也能继续拖。 */
  moveTo: (x: number, y: number) => void
  /** 拖拽/飞行开关：让主进程期间保持可交互。 */
  setDragging: (dragging: boolean) => void
  setInteractive: (interactive: boolean) => void
  setSize: (sizePercent: number) => void
}

declare global {
  interface Window {
    petBridge?: PetBridge
  }
}

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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

async function fetchStatus(): Promise<PetStatus> {
  const response = await fetch(`${ORIGIN}/dsh-pet-lite/settings`, { cache: 'no-store' })
  if (!response.ok)
    throw new Error(`PET_STATUS_FAILED: ${response.status}`)
  return (await response.json()) as PetRuntimeStatus
}

async function fetchAsset(id: string): Promise<PetAsset> {
  const response = await fetch(`${ORIGIN}/dsh-pet-lite/asset?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
  if (!response.ok)
    throw new Error(`PET_ASSET_FAILED: ${response.status}`)
  return (await response.json()) as PetAsset
}

/**
 * 视图几何 —— **全部是屏幕坐标 / DIP**（与 Electron `setContentBounds` 同一坐标系）。
 *
 * 这是本文件最容易搞错的地方，因此写死约定：
 *   - `x` / `y`  = **宠物包围盒左上角**在屏幕上的位置（不是窗口位置，也不是窗口内坐标）；
 *   - 窗口位置 = 宠物位置 − `WINDOW_MARGIN`；
 *   - 宠物在窗口内的 DOM 偏移恒为 `WINDOW_MARGIN`，宠物移动时 DOM 不动、窗口动
 *     （与 dsh-pet 的 sprite 固定在内边距、由 `sendBounds` 移动窗口完全一致）。
 *
 * 边界取自主进程下发的**工作区**（`AREA`），不是窗口自身尺寸 —— 后者只有几百 px，
 * 拿它当边界就会「只能拖出一小片」。
 */
interface View {
  /** 宠物包围盒左上角（屏幕坐标）。 */
  x: number
  y: number
  /** 宠物宽高（px，DIP）。 */
  width: number
  height: number
}

/** 拖拽会话状态（对应 dsh-pet `this.dragState`）。 */
interface DragState {
  active: boolean
  dragging: boolean
  /** 按下时的指针屏幕坐标。 */
  sx: number
  sy: number
  /** 按下时的宠物位置。 */
  petX: number
  petY: number
}

/** 拖拽跟随的目标（弹簧追赶）。 */
interface DragTarget {
  x: number
  y: number
}

function App(): React.ReactElement | null {
  const petRef = useRef<PetRef>(null)
  const pet = useControllablePet(petRef)
  const hitboxRef = useRef<HTMLDivElement>(null)

  const [status, setStatus] = useState<PetStatus | null>(null)
  const [asset, setAsset] = useState<PetAsset | null>(null)
  const [motion, setMotion] = useState<MotionInput>('idle')
  const [dragging, setDragging] = useState(false)

  const physics = useMemo<PhysicsParams>(() => ({ ...DEFAULT_PHYSICS }), [])

  // --- 状态与素材 ------------------------------------------------------

  useEffect(() => {
    let cancelled = false
    void fetchStatus()
      .then((next) => {
        if (!cancelled) {
          setStatus(next)
          clearError()
        }
      })
      .catch(error => showError(`无法读取宠物状态：${messageOf(error)}`))
    return () => {
      cancelled = true
    }
  }, [])

  const activeId = status?.active_pet ?? ''
  useEffect(() => {
    if (!activeId) {
      setAsset(null)
      return
    }
    let cancelled = false
    void fetchAsset(activeId)
      .then((next) => {
        if (cancelled)
          return
        setAsset(next)
        clearError()
      })
      .catch(error => showError(`无法读取宠物：${messageOf(error)}`))
    return () => {
      cancelled = true
    }
  }, [activeId])

  const sizePercent = normalizeSize(status?.pet_size)

  // --- 会话活动 → 动作 --------------------------------------------------

  useEffect(() => {
    if (!ORIGIN)
      return
    const source = new EventSource(`${ORIGIN}/dsh-pet-lite/session/stream`)
    source.onmessage = (event) => {
      try {
        const root = JSON.parse(event.data) as { payload?: PetSessionPayload }
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

  const width = (asset?.kind === 'dsh' ? (asset.size ?? PET_BASE_WIDTH) : PET_BASE_WIDTH) * sizePercent / 100
  const height = width * PET_ASPECT

  useEffect(() => {
    window.petBridge?.setSize(sizePercent)
  }, [sizePercent])

  // --- 拖动 / 抛掷 ------------------------------------------------------
  //
  // 位置全部收敛在 `viewRef`（屏幕坐标）：任何位移最后都经 `applyPosition` 落到窗口上。
  //
  // 初值来自主进程下发的真实窗口位置：宠物包围盒左上角 = 窗口内容区左上角 + 留白。
  // 早期版本把「窗口内偏移（48）」当成屏幕坐标用，于是窗口被算到 `48-48=0` ——
  // 一拖动就跳到屏幕左上角，并且只能在那一片里挪。这就是那个 bug 的根。
  const viewRef = useRef<View>({
    x: WIN_X + WINDOW_MARGIN,
    y: WIN_Y + WINDOW_MARGIN,
    width: PET_BASE_WIDTH,
    height: PET_BASE_WIDTH * PET_ASPECT,
  })

  // 尺寸变化必须同步进几何：抛掷边界与弹簧目标都按它算，不更新会用到旧包围盒。
  useEffect(() => {
    viewRef.current.width = width
    viewRef.current.height = height
  }, [width, height])
  const dragStateRef = useRef<DragState>({ active: false, dragging: false, sx: 0, sy: 0, petX: 0, petY: 0 })
  const dragTargetRef = useRef<DragTarget | null>(null)
  const dragVelRef = useRef({ vx: 0, vy: 0 })
  const dragFollowRef = useRef<number | null>(null)
  const dragTrailRef = useRef<DragSample[]>([])
  const throwRef = useRef<{ token: number } | null>(null)

  /** 把宠物包围盒左上角落到窗口上（唯一出口）。 */
  const applyPosition = useCallback((x: number, y: number) => {
    const view = viewRef.current
    // 夹进工作区（与 dsh-pet 的 fitWindow 同义）：身体四周各留 24px 可挂出去，
    // 再往外就让用户够不到了 —— 只能看见宠物贴在屏幕外缘却拖不回来。
    const clamp = throwBoundsIn(AREA, view.width, 24)
    view.x = Math.round(Math.min(clamp.maxX, Math.max(clamp.minX, x)))
    view.y = Math.round(Math.min(clamp.maxY, Math.max(clamp.minY, y)))
    // 窗口 = 宠物包围盒 + 四周留白。
    //
    // **不要乘 devicePixelRatio**：Electron 的 `setContentBounds` 收的就是 DIP（与 CSS px
    // 同一刻度），再乘一次会让窗口以 1.5×/2× 的速度偏离指针。
    const winX = view.x - WINDOW_MARGIN
    const winY = view.y - WINDOW_MARGIN
    if (dragStateRef.current.active || throwRef.current !== null) {
      // 拖拽 / 飞行：走 moveTo。这条路径在指针位于窗口外时仍然有效，
      // 是「能把宠物拖过整个屏幕」的关键；setBounds 只在稳态（尺寸变化、初始落位）用。
      window.petBridge?.moveTo(winX, winY)
      return
    }
    window.petBridge?.setBounds(winX, winY, view.width + WINDOW_MARGIN * 2, view.height + WINDOW_MARGIN * 2)
  }, [])

  /** 停止弹簧跟随（位置定格在当前位置）。 */
  const stopDragFollow = useCallback(() => {
    if (dragFollowRef.current !== null) {
      cancelAnimationFrame(dragFollowRef.current)
      dragFollowRef.current = null
    }
    dragTargetRef.current = null
    dragVelRef.current = { vx: 0, vy: 0 }
  }, [])

  /** rAF 弹簧跟随：窗口朝拖拽目标过阻尼追赶，抹平高频抖动。 */
  const startDragFollow = useCallback(() => {
    if (dragFollowRef.current !== null)
      return
    let last = performance.now()
    const step = (): void => {
      const target = dragTargetRef.current
      if (!target) {
        dragFollowRef.current = null
        return
      }
      const now = performance.now()
      const dt = Math.min((now - last) / 1000, MAX_STEP_DT)
      last = now
      const vel = dragVelRef.current
      const view = viewRef.current
      vel.vx = springStep(vel.vx, view.x, target.x, dt, physics.throwPower)
      vel.vy = springStep(vel.vy, view.y, target.y, dt, physics.throwPower)
      applyPosition(view.x + vel.vx * dt, view.y + vel.vy * dt)
      dragFollowRef.current = requestAnimationFrame(step)
    }
    dragFollowRef.current = requestAnimationFrame(step)
  }, [applyPosition, physics.throwPower])

  /** 停止抛掷（定格在当前落点）。 */
  const stopThrow = useCallback(() => {
    throwRef.current = null
  }, [])

  /** 甩出：重力积分 + 撞边反弹，静止即停。 */
  const startThrow = useCallback((x: number, y: number, vx: number, vy: number) => {
    stopDragFollow()
    const token = (throwRef.current?.token ?? 0) + 1
    throwRef.current = { token }
    let state: ThrowState = { x, y, vx, vy }
    let last = performance.now()
    // 边界取**工作区**（屏幕坐标），不是窗口自身尺寸。
    const bounds: ThrowBounds = throwBoundsIn(AREA, viewRef.current.width, 24)
    const step = (): void => {
      if (throwRef.current?.token !== token)
        return
      const now = performance.now()
      const dt = Math.min((now - last) / 1000, MAX_STEP_DT)
      last = now
      const next = throwStep(state, dt, bounds, physics)
      state = { x: next.x, y: next.y, vx: next.vx, vy: next.vy }
      applyPosition(state.x, state.y)
      if (next.atRest) {
        throwRef.current = null
        // 落地：把输入交还给命中判定（飞行全程是锁定的，见 onHitboxPointerDown）。
        window.petBridge?.setDragging(false)
        return
      }
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [applyPosition, physics, stopDragFollow])

  const onHitboxPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0)
      return
    const view = viewRef.current
    dragStateRef.current = {
      active: true,
      dragging: false,
      sx: event.screenX,
      sy: event.screenY,
      petX: view.x,
      petY: view.y,
    }
    dragTrailRef.current = []
    stopThrow()
    stopDragFollow()
    // 【关键】拖拽期间窗口必须保持可交互，且主进程要知道「我正在用输入」。
    //
    // 窗口只有宠物那么大（几百 px），拖动时指针很快跑到窗口外。整窗是
    // `setIgnoreMouseEvents(true, {forward:true})` 的：一旦命中判定翻回穿透，
    // `pointermove` / `pointerup` 就彻底断流 —— 弹簧目标卡在窗口边缘，宠物再也追不上
    // 指针，表现就是「拖不出这一小片」。dsh-pet 用 `syncInputBusy()` 解决同一问题。
    window.petBridge?.setDragging(true)
    window.petBridge?.setInteractive(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [stopDragFollow, stopThrow])

  const onHitboxPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current
    if (!drag.active)
      return
    // 阈值与目标都用**屏幕坐标**增量：clientX 会随窗口移动变化，屏幕坐标稳定。
    const dx = event.screenX - drag.sx
    const dy = event.screenY - drag.sy
    if (!drag.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD)
        return
      drag.dragging = true
      setDragging(true)
    }
    const now = performance.now()
    dragTrailRef.current.push({ t: now, x: event.screenX, y: event.screenY })
    dragTrailRef.current = trimTrail(dragTrailRef.current, now)
    // 弹簧目标 = 按下时的宠物位置 + 屏幕增量（窗口怎么动都不影响坐标）。
    dragTargetRef.current = { x: drag.petX + dx, y: drag.petY + dy }
    startDragFollow()
  }, [startDragFollow])

  const endDrag = useCallback(() => {
    const drag = dragStateRef.current
    const wasDragging = drag.dragging
    drag.active = false
    drag.dragging = false
    setDragging(false)
    stopDragFollow()
    // 交还输入：主进程恢复命中判定（下一次 pointermove 会重新算可交互性）。
    if (!wasDragging) {
      window.petBridge?.setDragging(false)
      return
    }

    const view = viewRef.current
    const velocity = estimateReleaseVelocity(dragTrailRef.current, performance.now(), physics)
    dragTrailRef.current = []
    if (velocity) {
      // 飞行期间仍然需要 moveTo 路径，因此 dragging 状态保持到落地。
      startThrow(view.x, view.y, velocity.vx, velocity.vy)
      return
    }
    window.petBridge?.setDragging(false)
  }, [physics, startDragFollow, stopDragFollow, startThrow])

  // 命中判定 → 整窗点击穿透翻转。
  useEffect(() => {
    function handlePointerMove(event: PointerEvent): void {
      // 拖拽/飞行期间不做命中判定：此时必须保持可交互，否则事件断流（见 onHitboxPointerDown）。
      if (dragStateRef.current.active)
        return
      const element = hitboxRef.current
      if (!element) {
        window.petBridge?.setInteractive(false)
        return
      }
      const rect = element.getBoundingClientRect()
      const inside
        = event.clientX >= rect.left
          && event.clientX <= rect.right
          && event.clientY >= rect.top
          && event.clientY <= rect.bottom
      window.petBridge?.setInteractive(inside)
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerleave', () => {
      if (!dragStateRef.current.active)
        window.petBridge?.setInteractive(false)
    })
    return () => window.removeEventListener('pointermove', handlePointerMove)
  }, [])

  // --- 渲染 ------------------------------------------------------------

  const config = useMemo<DshPetConfig | string | null>(() => {
    if (!asset || asset.kind !== 'dsh')
      return null
    return asset.config
  }, [asset])

  const uri = asset?.kind === 'dsh' ? asset.uri : undefined
  const ext = asset?.kind === 'dsh' ? asset.ext : undefined

  if (!status || !asset || asset.kind !== 'dsh' || !config || !uri)
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
        kind="dsh"
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

/**
 * 初始化：把窗口对齐到主进程下发的真实位置。
 *
 * 主进程用 `winX/winY/area*` 告诉我们窗口在哪、工作区多大，因此这里**不需要猜**：
 * 宠物包围盒左上角 = 窗口内容区左上角 + 留白，随后按该几何把窗口吸附一次
 * （主进程可能把它落在工作区边缘，吸附会把它夹回可视区）。
 */
function seedWindow(): void {
  window.petBridge?.setSize(100)
  window.petBridge?.setBounds(
    WIN_X,
    WIN_Y,
    PET_BASE_WIDTH + WINDOW_MARGIN * 2,
    PET_BASE_WIDTH * PET_ASPECT + WINDOW_MARGIN * 2,
  )
}

const container = document.getElementById('root')
if (!container)
  throw new Error('DSH_PET_LITE_LAYOUT_MISSING: #root was not found')
createRoot(container).render(<App />)
seedWindow()
