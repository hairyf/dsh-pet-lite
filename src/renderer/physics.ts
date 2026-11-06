/**
 * renderer/physics.ts — 跟手弹簧、释放初速、抛掷积分与接触求解。
 *
 * **逐字移植自 dsh-pet**（`source/dsh-pet/dsh-pet/src/shared/physics/*`）：
 *   - `spring.ts`    → `springStep` / `softClampSpeed`
 *   - `release.ts`   → `trimTrail` / `estimateReleaseVelocity`
 *   - `throw.ts`     → `throwBounds` / `throwStep`
 *   - `contact.ts`   → `resolveContact` / `isRestingOnContacts`
 *   - `constants.ts` → 下面的全部调参常量
 *
 * 常量与公式一个字都没改 —— 手感一致的前提是数值一致。只去掉了 dsh-pet 里本插件用不到的
 * 部分（多屏抛掷空间、弹弓、触感反馈、姿态重力）。
 */

// --- 与 dsh-pet 相同的调参常量 -------------------------------------------

/** 拖拽成立阈值（px）。 */
export const DRAG_THRESHOLD = 5
/** 采样保留窗口（ms）。 */
export const TRAIL_KEEP_MS = 200
/** 释放速度取样窗口（ms）。 */
export const RELEASE_WINDOW_MS = 150
/** 超过它视为松手（ms），不跨窗口拼接速度。 */
export const RELEASE_STALE_MS = 150
/** 取样窗口最短跨度（ms）。 */
export const MIN_SPAN_MS = 20
/** 分段速度的最小 dt（ms）：过密采样向前合并。 */
export const SEG_MIN_DT_MS = 8
/** 释放初速死区（px/s）：低于它按温柔放下处理。 */
export const DEAD_ZONE_SPEED = 500
/** 端点平均与峰值加权。 */
export const PEAK_WEIGHT = 0.5
/** 末段加速度参考值（px/s²）。 */
export const ACCEL_REF = 8000
/** 加速度最大增益。 */
export const ACCEL_GAIN_MAX = 0.6

/** 过阻尼弹簧系数（刚度 / 阻尼）。 */
export const SPRING_K = 200
export const SPRING_C = 30
/** 总力度默认量。 */
export const DEFAULT_THROW_POWER = 1
/** 软钳速上限（px/s）。 */
export const MAX_THROW_SPEED = 3600
/** 单步最大 dt（s）：防后台卡顿恢复后的巨帧跳变。 */
export const MAX_STEP_DT = 0.05

/** 重力（px/s²）、恢复系数、地面摩擦。 */
export const GRAVITY = 1400
export const RESTITUTION = 0.78
export const GROUND_FRICTION = 2.5

/** 接触面法向速度低于它即贴住（px/s）。 */
export const REST_NORMAL = 40
/** 接触面切向速度低于它认为已静止（px/s）。 */
export const REST_TANGENT = 15
/** 判静止时法向速度容差（px/s）。 */
export const REST_NORMAL_EPS = 1

export interface PhysicsParams {
  ceilingBounce: boolean
  gravity: number
  groundFriction: number
  restitution: number
  throwPower: number
}

export const DEFAULT_PHYSICS: PhysicsParams = {
  ceilingBounce: true,
  gravity: GRAVITY,
  groundFriction: GROUND_FRICTION,
  restitution: RESTITUTION,
  throwPower: DEFAULT_THROW_POWER,
}

/** 一次轨迹采样（t = `performance.now()` ms；x/y = 指针绝对坐标 px）。 */
export interface DragSample {
  t: number
  x: number
  y: number
}

/** 抛掷边界：包围盒左上角的允许活动范围。 */
export interface ThrowBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** 抛体状态（包围盒左上角 px + 速度 px/s）。 */
export interface ThrowState {
  x: number
  y: number
  vx: number
  vy: number
}

export type ContactEdge = 'ceiling' | 'floor' | 'left' | 'right'

// --- 弹簧 ---------------------------------------------------------------

/**
 * 过阻尼弹簧单轴速度步进：调用方随后 `x += v*dt`。
 *
 * power 乘在 (K, C) 上：系统形态不变、收敛速度快 p 倍（更跟手或更松）。
 */
export function springStep(v: number, x: number, target: number, dt: number, power = DEFAULT_THROW_POWER): number {
  return v + ((target - x) * SPRING_K - v * SPRING_C) * power * dt
}

/** 软钳速：`cap×(1-e^(-s/cap))`，任意速度下单调可区分、渐近不超过 cap。 */
export function softClampSpeed(speed: number): number {
  if (speed <= 0)
    return 0
  return MAX_THROW_SPEED * (1 - Math.exp(-speed / MAX_THROW_SPEED))
}

// --- 释放初速 -----------------------------------------------------------

/** 剔除保留窗口外的旧采样（采样按时间追加，只需从头裁）。 */
export function trimTrail(trail: DragSample[], now: number): DragSample[] {
  const cutoff = now - TRAIL_KEEP_MS
  let index = 0
  while (index < trail.length && trail[index]!.t < cutoff)
    index++
  return index === 0 ? trail : trail.slice(index)
}

/**
 * 由拖拽轨迹估算松手初速 (vx, vy)，px/s。
 *
 * 方向取窗口首末端点位移（抗抖）；大小 = 端点平均与峰值按 PEAK_WEIGHT 加权，末段仍在加速时
 * 按 ACCEL_REF 给增益，再过软钳速并乘 `physics.throwPower`。
 *
 * @returns null = 温柔放下（轨迹为空 / 停留过久 / 窗口太短 / 峰值低于死区），调用方不抛。
 */
export function estimateReleaseVelocity(
  trail: DragSample[],
  now: number,
  physics: PhysicsParams = DEFAULT_PHYSICS,
): { vx: number, vy: number } | null {
  if (trail.length === 0)
    return null
  const last = trail[trail.length - 1]!
  if (now - last.t > RELEASE_STALE_MS)
    return null
  const win = trail.filter(sample => now - sample.t <= RELEASE_WINDOW_MS)
  if (win.length < 2)
    return null
  const t0 = win[0]!.t
  const x0 = win[0]!.x
  const y0 = win[0]!.y
  const t1 = win[win.length - 1]!.t
  const x1 = win[win.length - 1]!.x
  const y1 = win[win.length - 1]!.y
  const spanMs = t1 - t0
  if (spanMs < MIN_SPAN_MS)
    return null
  const baseVx = ((x1 - x0) / spanMs) * 1000
  const baseVy = ((y1 - y0) / spanMs) * 1000
  const baseSpeed = Math.hypot(baseVx, baseVy)
  if (baseSpeed < 1e-6)
    return null

  // 分段速度（过密采样向前合并，dt 下限 SEG_MIN_DT_MS）。
  const segSpeeds: Array<{ speed: number, tEnd: number }> = []
  let px = x0
  let py = y0
  let pt = t0
  for (const sample of win.slice(1)) {
    const dt = sample.t - pt
    if (dt >= SEG_MIN_DT_MS) {
      segSpeeds.push({ speed: (Math.hypot(sample.x - px, sample.y - py) / dt) * 1000, tEnd: sample.t })
      px = sample.x
      py = sample.y
      pt = sample.t
    }
  }
  const peakSpeed = segSpeeds.length ? Math.max(...segSpeeds.map(seg => seg.speed)) : baseSpeed

  // 末段加速度：末段峰值相对首段的斜率，仍在加速的甩动据此放大初速。
  let accel = 0
  if (segSpeeds.length >= 2) {
    const lastSeg = segSpeeds[segSpeeds.length - 1]!
    const firstSeg = segSpeeds[0]!
    accel = (lastSeg.speed - firstSeg.speed) / Math.max((lastSeg.tEnd - firstSeg.tEnd) / 1000, MIN_SPAN_MS / 1000)
  }
  const speedBeforeClamp
    = ((1 - PEAK_WEIGHT) * baseSpeed + PEAK_WEIGHT * peakSpeed)
      * (1 + Math.min(Math.max(accel, 0) / ACCEL_REF, 1) * ACCEL_GAIN_MAX)
  const speed = softClampSpeed(speedBeforeClamp) * physics.throwPower
  if (speed < DEAD_ZONE_SPEED)
    return null
  return { vx: (baseVx / baseSpeed) * speed, vy: (baseVy / baseSpeed) * speed }
}

// --- 抛掷 ---------------------------------------------------------------

/** 由 W/H/size 计算抛掷碰撞边界：身体贴屏幕边缘才反弹。 */
export function throwBounds(o: { W: number, H: number, size: number, sideAllow: number }): ThrowBounds {
  const height = (o.size * 9) / 16
  return {
    minX: -o.sideAllow,
    minY: 0,
    maxX: o.W - o.size + o.sideAllow,
    maxY: o.H - height,
  }
}

/** 工作区矩形（屏幕坐标，原点不必是 0）。 */
export interface AreaRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 同 {@link throwBounds}，但基于任意一块工作区矩形（原点不必是 0）。
 *
 * 对应 dsh-pet `throwBoundsIn`：桌宠窗口是**屏幕坐标**里的一个局部窗口，边界必须按显示器
 * 工作区算，而不是按窗口自身的几百 px 尺寸 —— 后者会把宠物困在原地一小片。
 */
export function throwBoundsIn(area: AreaRect, size: number, sideAllow: number): ThrowBounds {
  const height = (size * 9) / 16
  return {
    minX: area.x - sideAllow,
    minY: area.y,
    maxX: area.x + area.width - size + sideAllow,
    maxY: area.y + area.height - height,
  }
}

const CONTACT_NORMALS: Readonly<Record<ContactEdge, { nx: number, ny: number }>> = {
  left: { nx: 1, ny: 0 },
  right: { nx: -1, ny: 0 },
  ceiling: { nx: 0, ny: 1 },
  floor: { nx: 0, ny: -1 },
}

/** 一次接触求解：法向按恢复系数反弹（低于阈值即贴住归零），切向只按摩擦衰减。 */
export function resolveContact(
  speed: { vx: number, vy: number },
  edge: ContactEdge,
  physics: PhysicsParams,
  dt: number,
): { vx: number, vy: number } {
  const { nx, ny } = CONTACT_NORMALS[edge]
  const tx = -ny
  const ty = nx
  const vn = speed.vx * nx + speed.vy * ny
  const vt = speed.vx * tx + speed.vy * ty
  const normalSpeed = Math.abs(vn) < REST_NORMAL ? 0 : Math.abs(vn) * physics.restitution
  const tangentSpeed = vt * Math.max(0, 1 - physics.groundFriction * dt)
  return {
    vx: normalSpeed * nx + tangentSpeed * tx,
    vy: normalSpeed * ny + tangentSpeed * ty,
  }
}

/** 本步接触是否都已静止：每个接触面法向≈0 且切向低速。 */
function isRestingOnContacts(edges: readonly ContactEdge[], speed: { vx: number, vy: number }): boolean {
  if (edges.length === 0)
    return false
  return edges.every((edge) => {
    const { nx, ny } = CONTACT_NORMALS[edge]
    const normal = Math.abs(speed.vx * nx + speed.vy * ny)
    const tangent = Math.abs(speed.vx * -ny + speed.vy * nx)
    return normal < REST_NORMAL_EPS && tangent < REST_TANGENT
  })
}

/**
 * 抛体单步积分与边界反弹。
 *
 * @returns 下一帧状态 + `bounced`（本步是否碰边/落地）+ `atRest`（可停止循环）。
 */
export function throwStep(
  state: ThrowState,
  dtRaw: number,
  bounds: ThrowBounds,
  physics: PhysicsParams = DEFAULT_PHYSICS,
): ThrowState & { bounced: boolean, atRest: boolean } {
  const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT)
  let { x, y, vx, vy } = state
  vy += physics.gravity * dt
  x += vx * dt
  y += vy * dt

  let bounced = false
  const contacts: ContactEdge[] = []
  const settle = (edge: ContactEdge): void => {
    contacts.push(edge)
    const out = resolveContact({ vx, vy }, edge, physics, dt)
    vx = out.vx
    vy = out.vy
    bounced = true
  }

  if (x < bounds.minX) {
    x = bounds.minX
    settle('left')
  }
  else if (x > bounds.maxX) {
    x = bounds.maxX
    settle('right')
  }
  if (y < bounds.minY) {
    // ceilingBounce=false：顶部无边界，不夹不弹 —— 飞出屏幕顶部，靠重力落回。
    if (physics.ceilingBounce) {
      y = bounds.minY
      settle('ceiling')
    }
  }
  else if (y >= bounds.maxY) {
    y = bounds.maxY
    settle('floor')
  }

  return { x, y, vx, vy, bounced, atRest: isRestingOnContacts(contacts, { vx, vy }) }
}
