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

import type { DshPetConfig, PetRef } from 'dsh-pet-component'
import type { PetAsset, PetRuntimeStatus, PetSessionFrame, PetSettingsFrame } from '../shared/types'
import type { DragSample, PhysicsParams, ThrowBounds, ThrowState } from './physics'
import { Pet, useControllablePet } from 'dsh-pet-component'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  PET_ASPECT,
  PET_BASE_WIDTH,
  PET_BUBBLE_HEADROOM,
  PET_BUBBLE_MIN_WIDTH,
  PET_SIZE_MAX,
  PET_SIZE_MIN,
} from '../shared/constants'
import { createBubbleTracker } from './bubble'
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

/** 主进程下发的初始几何（全部是屏幕坐标 / DIP）。 */
function num(key: string, fallback: number): number {
  const value = Number(params.get(key))
  return Number.isFinite(value) ? value : fallback
}

/**
 * 窗口四周留白（主进程下发，与 `shared/constants.ts` 的 `PET_WINDOW_MARGIN` 同源）。
 *
 * 左右与下方是「宠物贴边时仍能抓到」的余量；上方另加 `BUBBLE_HEADROOM`（气泡画布）。
 */
const WINDOW_MARGIN = num('margin', 48)
/** 气泡画布高度（窗口上方额外留白，主进程下发）。 */
const BUBBLE_HEADROOM = num('headroom', PET_BUBBLE_HEADROOM)
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
  /** 弹出右键菜单（显示主界面 / 关闭宠物）。 */
  showMenu: (payload: { openUrl?: string, showLabel?: string, closeLabel?: string }) => void
  /** 订阅菜单点击。返回取消订阅函数。 */
  onMenuAction: (handler: (action: string) => void) => () => void
}

declare global {
  interface Window {
    petBridge?: PetBridge
  }
}

/**
 * 气泡画布高度：随宠物宽度等比缩放（气泡本身按 `--dsh-pet-size` 缩放）。
 *
 * 200px 基准下是 120px —— 放得下 3 条堆叠气泡（组件 `maxVisible` 默认 3）。
 */
function bubbleHeadroomFor(petWidth: number): number {
  return Math.round(BUBBLE_HEADROOM * (petWidth / PET_BASE_WIDTH))
}

/**
 * 窗口尺寸（宠物 + 留白 + 上方气泡画布，宽度另有下限）。
 *
 * 与上游 `usePetWindowSize()` 同义：
 * - **宽度取 `max(宠物宽 + padX, BUBBLE_MIN_WIDTH)`** —— 宠物缩小时窗口不跟着缩到气泡
 *   放不下，否则气泡被压成两行甚至裁掉；
 * - 高度 = 宠物高 + 上下留白 + 气泡画布。
 *
 * **渲染端是窗口几何的唯一真值**：宠物素材自带 `size`（预设多为 220），主进程只知道
 * 200 的基准宽，让它自己按百分比算窗口就会算窄、把宠物裁掉。因此主进程只做「应用给定
 * 矩形」，尺寸一律由这里经 `setBounds` 下发（这也是「改了大小窗口不变」的修法之一）。
 */
function windowSizeFor(petWidth: number, petHeight: number): { width: number, height: number } {
  return {
    width: Math.max(petWidth + WINDOW_MARGIN * 2, PET_BUBBLE_MIN_WIDTH),
    height: petHeight + WINDOW_MARGIN * 2 + bubbleHeadroomFor(petWidth),
  }
}
/**
 * 宠物在窗口内的水平偏移：窗口比宠物宽时居中（气泡层按 `left: 50%` 定位在宠物身上）。
 */
function petOffsetXFor(petWidth: number): number {
  return Math.round((windowSizeFor(petWidth, 0).width - petWidth) / 2)
}

function normalizeSize(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return 100
  return Math.min(PET_SIZE_MAX, Math.max(PET_SIZE_MIN, value))
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

async function fetchStatus(): Promise<PetRuntimeStatus> {
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

  const [status, setStatus] = useState<PetRuntimeStatus | null>(null)
  const [asset, setAsset] = useState<PetAsset | null>(null)
  const [dragging, setDragging] = useState(false)
  /**
   * 会话 → 气泡的桥接状态机（逐条复刻上游 `use-bubble-tracker`）。
   *
   * 用 ref 持有实例：它内部保存「上一次档位 / 终态是否已播」这些跨帧状态，
   * 每次渲染重建会让终态动画反复重播。
   */
  const trackerRef = useRef<ReturnType<typeof createBubbleTracker> | null>(null)

  const physics = useMemo<PhysicsParams>(() => ({ ...DEFAULT_PHYSICS }), [])

  // --- 状态与素材 ------------------------------------------------------
  //
  // 状态有**两条**来源，缺一不可：
  //   1. 挂载时 `GET /settings` 一次 —— 首屏值，SSE 还没连上时也不至于空白
  //      （也是 `scripts/verify-drag.mjs` 的假宿主唯一实现的端点）；
  //   2. 之后全程由 `/settings/stream` 推送 —— 设置页改大小 / 抛射 / 选择后**立刻**生效。
  //
  // 早期只有第 1 条：滑条拖完窗口不知道（大小不变）、抛射关了窗口不知道（还在飞）、
  // 换宠物要等重启。第 2 条就是这三个症状的共同根因。
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

  useEffect(() => {
    if (!ORIGIN)
      return
    const source = new EventSource(`${ORIGIN}/dsh-pet-lite/settings/stream`)
    source.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as PetSettingsFrame
        if (frame?.payload) {
          setStatus(frame.payload)
          clearError()
        }
      }
      catch {
        /* 非法帧：保留上一次的权威值 */
      }
    }
    return () => source.close()
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
  /** 抛射开关（默认关闭）：关着时松手即定住，不做重力积分与撞边反弹。 */
  const throwEnabled = Boolean(status?.throw_enabled)

  // --- 会话活动 → 气泡 --------------------------------------------------
  //
  // 【为什么走气泡而不是 `pet.motion(...)`】气泡就是动作的**载体**：组件把所有常驻气泡的
  // `motion` 按 `BUBBLE_MOTION_PRIORITY` 聚合成 `motion` prop。于是：
  //   - 状态在，动画就在（thinking / working / waiting 循环）；
  //   - 气泡关掉，动画自动回落 `idle` —— 会话中止时「不再循环思考」不需要额外逻辑；
  //   - success / error 这些**限时**气泡由组件用命令面播一次，播完自己收，不会把动画掐断。
  //
  // 早期版本只做 `setMotion(STATUS_MOTION[workStatus])`、从不调 `pet.bubble`：
  // 既没有气泡（用户看到的「一个气泡都没有」），中止时 workStatus 变回 undefined
  // 又让那个 `if` 直接跳过，动画就永远停在上一个思考/工作档（「停止后还在播」）。
  useEffect(() => {
    if (!ORIGIN)
      return

    // 桥接状态机在 `renderer/bubble.ts`：它自己管「每个会话一条气泡、终态只播一次、
    // 档位没了就收」这些跨帧状态，这里只管把 SSE 帧喂给它。
    //
    // `onIdle` 是「命令层动作」的归还点：终态档（success / failed）由组件用命令面播一次，
    // 归还依赖动画播完；静态图 / 素材缺失 / 减少动态效果时那个回调永远不来，动画会钉死。
    const tracker = createBubbleTracker(pet.bubble, { onIdle: () => pet.clear() })
    trackerRef.current = tracker

    const source = new EventSource(`${ORIGIN}/dsh-pet-lite/session/stream`)

    source.onmessage = (event) => {
      let frame: PetSessionFrame
      try {
        frame = JSON.parse(event.data) as PetSessionFrame
      }
      catch {
        return
      }
      if (frame?.payload) {
        tracker.apply(frame.payload, frame.action)
        return
      }
      // remove 帧的载荷只有 id：补成最少字段再交给状态机。
      const id = (frame as { payload?: { id?: string } })?.payload?.id
      if (typeof id === 'string' && id)
        tracker.apply({ id }, 'remove')
    }

    // 重连 = 宿主那边的累计态可能已经被丢弃（`state-lost`）：旧气泡一律作废。
    // SSE 注释帧拿不到，用连接打开这个等价信号。
    source.onopen = () => {
      tracker.clear()
    }

    return () => {
      source.close()
      tracker.dispose()
      trackerRef.current = null
    }
  }, [pet])

  const width = (asset?.kind === 'dsh' ? (asset.size ?? PET_BASE_WIDTH) : PET_BASE_WIDTH) * sizePercent / 100
  const height = width * PET_ASPECT
  /** 宠物在窗口内的垂直偏移：上方先让出气泡画布（DOM 与窗口几何必须同源）。 */
  const petOffsetY = WINDOW_MARGIN + bubbleHeadroomFor(width)
  /** 宠物在窗口内的水平偏移：窗口可能比宠物宽（气泡最小宽度），此时宠物居中。 */
  const petOffsetX = petOffsetXFor(width)

  // --- 拖动 / 抛掷 ------------------------------------------------------
  //
  // 位置全部收敛在 `viewRef`（屏幕坐标）：任何位移最后都经 `applyPosition` 落到窗口上。
  //
  // 初值来自主进程下发的真实窗口位置：宠物包围盒左上角 = 窗口内容区左上角 + 垂直偏移。
  // 早期版本把「窗口内偏移（48）」当成屏幕坐标用，于是窗口被算到 `48-48=0` ——
  // 一拖动就跳到屏幕左上角，并且只能在那一片里挪。这就是那个 bug 的根。
  const viewRef = useRef<View>({
    x: WIN_X + petOffsetXFor(PET_BASE_WIDTH),
    y: WIN_Y + WINDOW_MARGIN + bubbleHeadroomFor(PET_BASE_WIDTH),
    width: PET_BASE_WIDTH,
    height: PET_BASE_WIDTH * PET_ASPECT,
  })

  /** 宠物在窗口内的偏移（`applyPosition` 读它，必须与 DOM 偏移同源）。 */
  const offsetRef = useRef({ x: petOffsetX, y: petOffsetY })
  offsetRef.current = { x: petOffsetX, y: petOffsetY }

  // 尺寸变化必须同步进几何：抛掷边界与弹簧目标都按它算，不更新会用到旧包围盒。
  useEffect(() => {
    viewRef.current.width = width
    viewRef.current.height = height
  }, [width, height])

  /**
   * 尺寸变化 → 立刻把窗口改成新大小。
   *
   * 这是「拖动大小滑条宠物不变」的修法：窗口尺寸**只由这里决定**（主进程不做百分比换算，
   * 它不知道宠物素材自带的 `size`）。窗口位置也要跟着调 —— 气泡画布在宠物上方，
   * 尺寸一变宠物包围盒的 y 就不该再贴着旧的离线位置。
   */
  useEffect(() => {
    const size = windowSizeFor(width, height)
    window.petBridge?.setBounds(
      viewRef.current.x - offsetRef.current.x,
      viewRef.current.y - offsetRef.current.y,
      size.width,
      size.height,
    )
  }, [width, height, petOffsetX, petOffsetY])

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
    // 窗口 = 宠物包围盒 + 留白（上方另加气泡画布）。
    //
    // **不要乘 devicePixelRatio**：Electron 的 `setContentBounds` 收的就是 DIP（与 CSS px
    // 同一刻度），再乘一次会让窗口以 1.5×/2× 的速度偏离指针。
    const winX = view.x - offsetRef.current.x
    const winY = view.y - offsetRef.current.y
    if (dragStateRef.current.active || throwRef.current !== null) {
      // 拖拽 / 飞行：走 moveTo。这条路径在指针位于窗口外时仍然有效，
      // 是「能把宠物拖过整个屏幕」的关键；setBounds 只在稳态（尺寸变化、初始落位）用。
      window.petBridge?.moveTo(winX, winY)
      return
    }
    const size = windowSizeFor(view.width, view.height)
    window.petBridge?.setBounds(winX, winY, size.width, size.height)
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
    // 【抛射开关】`throw_enabled` 默认关闭。关闭时**不做重力积分、不甩出**：松手就定住，
    // 宠物只是被挪到新位置。早期版本无条件按轨迹估速甩出，于是「明明关了抛射还是会飞」。
    const velocity = throwEnabled
      ? estimateReleaseVelocity(dragTrailRef.current, performance.now(), physics)
      : null
    dragTrailRef.current = []
    if (velocity) {
      // 飞行期间仍然需要 moveTo 路径，因此 dragging 状态保持到落地。
      startThrow(view.x, view.y, velocity.vx, velocity.vy)
      return
    }
    window.petBridge?.setDragging(false)
  }, [physics, startThrow, stopDragFollow, throwEnabled])

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

  // --- 右键菜单 --------------------------------------------------------
  //
  // 两项与 Tauri 桌面端 `pet_show_context_menu` 对齐（见 main.cjs 的 `pet:show-menu`）：
  //   - 显示主界面 → 打开宿主给的 `open_url`（官方桌面端是 `dsh://open`）；
  //   - 关闭宠物 → 走内部设置写入，和设置页里点「关闭宠物」同一条路径。
  const onContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    // 刚拖完不弹菜单：dsh-pet 同样用 `justDragged` 挡这一下，避免松手误触。
    if (dragStateRef.current.active)
      return
    window.petBridge?.showMenu({
      openUrl: status?.open_url ?? '',
      showLabel: '显示主界面',
      closeLabel: '关闭宠物',
    })
  }, [status?.open_url])

  /** 菜单里选「关闭宠物」：写持久化设置，宿主随即注销窗口。 */
  const closePet = useCallback(async () => {
    try {
      await fetch(`${ORIGIN}/dsh-pet-lite/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
    }
    catch (error) {
      showError(`关闭宠物失败：${messageOf(error)}`)
    }
  }, [])

  useEffect(() => {
    const dispose = window.petBridge?.onMenuAction((action) => {
      if (action === 'close-pet')
        void closePet()
    })
    return () => dispose?.()
  }, [closePet])

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
        // 窗口可能比宠物宽（气泡最小宽度）：宠物在这块画布里居中。
        left: petOffsetX,
        // 上方先让出气泡画布：气泡挂在宠物头顶，窗口顶边必须比宠物更高。
        top: petOffsetY,
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
        // `motion` 只作**回落值**：会话档位全部由气泡聚合驱动（见上方 SSE effect），
        // 这里保持 idle，气泡一收动画就自然停下。
        motion="idle"
        dragging={dragging}
        cache={false}
        hitboxRef={hitboxRef}
        onHitboxPointerDown={onHitboxPointerDown}
        onHitboxPointerMove={onHitboxPointerMove}
        onHitboxPointerUp={endDrag}
        onHitboxPointerCancel={endDrag}
        onDoubleClick={() => pet.motion({ type: 'waving' })}
        onContextMenu={onContextMenu}
        onError={error => showError(`宠物素材加载失败：${messageOf(error)}`)}
      />
    </div>
  )
}

/**
 * 初始化：把窗口对齐到主进程下发的真实位置。
 *
 * 主进程用 `winX/winY/area*` 告诉我们窗口在哪、工作区多大，因此这里**不需要猜**：
 * 宠物包围盒左上角 = 窗口内容区左上角 + 垂直偏移，随后按该几何把窗口吸附一次
 * （主进程可能把它落在工作区边缘，吸附会把它夹回可视区）。
 *
 * 【不要再`setSize(100)`】早先这里硬编码 100%，把已经持久化的 `pet_size` 顶掉了 ——
 * 用户拖了滑条、重开窗口又变回 100%。尺寸**只由 App 里那条 effect**下发（它读的是宿主
 * 权威状态），这里只负责把窗口位置对齐到主进程给的坐标。
 */
function seedWindow(): void {
  const size = windowSizeFor(PET_BASE_WIDTH, PET_BASE_WIDTH * PET_ASPECT)
  window.petBridge?.setBounds(WIN_X, WIN_Y, size.width, size.height)
}

const container = document.getElementById('root')
if (!container)
  throw new Error('DSH_PET_LITE_LAYOUT_MISSING: #root was not found')
createRoot(container).render(<App />)
seedWindow()
