/**
 * renderer/bubble.ts — 会话展示态 → dsh-pet-component 气泡的**桥接状态机**（纯逻辑）。
 *
 * 逐条对应上游 `apps/desktop/src/pet/hooks/use-bubble-tracker.{ts,helpers.ts,constants.ts}`
 * （dsh-tauri/deepseek-harness-desktop v0.30.4）：
 *
 * - `sessionMotion()` —— 档位推导。`workStatus` 优先，缺失时用 `status` / `activity` /
 *   `phase` / `pending` / `lastAgentError` / `running` 兜底推出 failed / review / waiting /
 *   `running`。**这一步不能省**：只看 `workStatus` 时，只有粗粒度状态的活动会话会被判成
 *   「空闲」，于是气泡不出现、动画也不动。
 * - `bubbleContent()` —— 标题（含「需授权 ·」「需选择 ·」「子代理 ·」前缀）+ 正文候选链
 *   （错误 > 任务 > 实时活动 > 档位兜底文案）。
 * - `createBubbleTracker()` —— 每个会话一条气泡、原地更新、终态档只播一次、
 *   「running 结束且没有档位」时补一条限时的「已完成」气泡。
 *
 * 保持纯函数（`bubble` 句柄由调用方注入）是为了能在 Node 里单测 —— 这也是上游那三个
 * 文件能配单测的原因。
 */

import type { Motion, PetBubbleHandle, PetBubbleOptions } from 'dsh-pet-component'
import type { PetSessionPayload } from '../shared/types'

// --- 常量（对应上游 use-bubble-tracker.constants.ts） ---------------------

/** 每个档位的兜底文案条数（同 seed 恒定选一条，避免同一会话文案跳变）。 */
const STATUS_COPY: Record<string, number> = {
  thinking: 3,
  working: 3,
  result: 3,
  waiting: 3,
  approval: 3,
  success: 3,
  running: 2,
  review: 2,
  failed: 2,
  error: 3,
}

const STATUS_TEXT: Record<string, readonly string[]> = {
  thinking: ['正在分析', '思考中', '整理结果中'],
  working: ['正在处理任务', '步骤正在进行中', '系统运行中'],
  result: ['正在整理结果', '汇总输出中', '结果就绪'],
  waiting: ['等待中', '等待你的下一步', '挂起等待'],
  approval: ['等待审批', '需要你确认', '等待授权'],
  success: ['已完成', '搞定了', '任务完成'],
  running: ['任务运行中', '正在推进'],
  review: ['正在复核', '复查中'],
  failed: ['出错了', '执行失败'],
  error: ['出错了', '执行失败', '运行异常'],
}

/** 工具活动分类的候选文案（`working` 档按分类选句）。 */
const ACTIVITY_TEXT: Record<string, readonly string[]> = {
  searching: ['正在检索', '正在项目中进行全面搜索', '正在调阅相关文件'],
  editing: ['正在修改', '正在写入变更内容', '正在调整代码实现'],
  testing: ['正在检验', '正在运行测试集进行确认', '正在验证变更有效性'],
  commanding: ['正在执行', '正在启动项目服务', '正在监控指令执行状态'],
}

/** 会显示加载圆环的档位（`ACTIVE_MOTIONS`）：终态档必须是静态图标。 */
const ACTIVE_MOTIONS = new Set<string>(['running', 'thinking', 'working', 'result'])

/** 终态档（会自己收起、且每个会话只播一次）。 */
const TERMINAL_MOTIONS = new Set<string>(['failed', 'review', 'error', 'success'])

/** 该档位是否是一次性终态（组件会用命令面播一次，播完自行归还）。 */
export function isTerminalMotion(motion: string | undefined): boolean {
  return motion !== undefined && TERMINAL_MOTIONS.has(motion)
}

/** 细粒度档位（`workStatus` 的六个值）。 */
const WORK_STATUSES = new Set<string>(['thinking', 'working', 'result', 'waiting', 'success', 'error'])

/** 「回合跑完了但没有档位」时那条限时气泡的时长（ms）。 */
export const DONE_BUBBLE_TIMEOUT = 3000

/**
 * 终态档的生效时长（ms）—— 与组件 `BUBBLE_TERMINAL_TIMEOUT` 同值。
 *
 * 用它做「动画归还」的硬上限：终态动画本是命令面播一次、播完由组件归还，但静态图 /
 * 解码失败 / `prefers-reduced-motion` 时那个回调永远不来，动画会钉死在最后一档。
 */
const TERMINAL_TIMEOUT: Record<string, number> = {
  failed: 4000,
  error: 4000,
  success: 3000,
  review: 2500,
}

/** 工具名 → 活动分类（与 reducer 的 `toolActivityOf` 同一组正则）。 */
const TOOL_PATTERNS: Array<[RegExp, string]> = [
  [/search|grep|find|glob|web|read|fetch|open/, 'searching'],
  [/write|edit|patch|replace|create|move|delete/, 'editing'],
  [/test|check|lint|build|verify/, 'testing'],
  [/shell|bash|exec|command|terminal|powershell|pwsh/, 'commanding'],
]

/** 有中文标签的常用工具（其余回落「工具调用 · <名字>」）。 */
const TOOL_LABELS: Record<string, string> = {
  read: '读取',
  read_image: '查看图片',
  write: '写入',
  edit: '编辑',
  str_replace_editor: '编辑',
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  think: '思考',
  skill: '加载技能',
  pwsh: 'Pwsh',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
}

/** 从工具参数里取一个可展示的细节（优先这几组键）。 */
const TOOL_ARG_KEYS: Record<string, readonly string[]> = {
  pwsh: ['command'],
  bash: ['command'],
  grep: ['pattern'],
  glob: ['pattern'],
  read: ['file_path', 'path'],
  read_image: ['file_path', 'path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  str_replace_editor: ['file_path', 'path'],
  web_search: ['queries', 'query'],
  web_fetch: ['url'],
  think: ['thought'],
  skill: ['name'],
}

// --- 纯函数 ---------------------------------------------------------------

/** seed → 稳定非负整数（同一会话的文案不跳变）。 */
export function seedNumber(seed: string | number | undefined): number {
  const value = String(seed ?? '')
  const numeric = Number(value)
  if (Number.isFinite(numeric))
    return Math.abs(Math.trunc(numeric))
  return [...value].reduce((total, char) => total + (char.codePointAt(0) ?? 0), 0)
}

/** 档位兜底文案（未知档位回落 working）。 */
export function statusCopy(group: string, seed?: string | number): string {
  const key = Object.hasOwn(STATUS_COPY, group) ? group : 'working'
  const list = STATUS_TEXT[key] ?? STATUS_TEXT.working!
  return list[seedNumber(seed) % list.length]!
}

/** 活动分类兜底文案（未知分类回落 working）。 */
export function activityCopy(activity: string, seed?: string | number): string {
  const list = ACTIVITY_TEXT[activity]
  return list ? list[seedNumber(seed) % list.length]! : statusCopy('working', seed)
}

function sanitizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, max = 40): string {
  const chars = Array.from(sanitizeText(text))
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('')
}

/** 任务文案：剥掉句末标点，动词开头的补「正在」，其余包进「…」。 */
export function taskCopy(task: string | undefined): string | undefined {
  const value = String(task ?? '').trim().replace(/[。！？.!?]+$/u, '')
  if (!value)
    return undefined
  if (/^(?:正在|继续)/u.test(value))
    return clip(value)
  if (/^(?:准备|检查|验证|修改|修复|测试|构建|整理|分析|梳理|查找|搜索|读取|实现)/u.test(value))
    return clip(`正在${value}`)
  return clip(`正在处理「${value}」`)
}

/** 工具名 → 活动分类。 */
export function toolActivityGroup(tool: string | undefined): string {
  const value = String(tool || '').toLowerCase()
  return TOOL_PATTERNS.find(([pattern]) => pattern.test(value))?.[1] ?? 'working'
}

/** 气泡标题：`title/displayTitle/name`，并按 `phase` / `origin` 加前缀。 */
export function sessionTitle(session: PetSessionPayload): string {
  const base = [session.title, session.displayTitle, session.name]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim() ?? '新会话'

  if (session.phase === 'approval')
    return `需授权 · ${base}`
  if (session.phase === 'user-question' || session.phase === 'blocked')
    return `需选择 · ${base}`
  if (session.origin === 'subagent')
    return `子代理 · ${base}`
  return base
}

/**
 * 会话档位推导 —— **`workStatus` 优先，缺失时用粗粒度字段兜底**。
 *
 * 上游 `sessionMotion()` 的同构实现。缺了这层兜底，只有 `status` / `running` 的活动会话
 * 会被判成「空闲」：气泡不出现，动作也不动。
 */
export function sessionMotion(session: PetSessionPayload): Motion | undefined {
  const work = session.workStatus
  if (work !== undefined && WORK_STATUSES.has(work))
    return work as Motion

  const value = session.status ?? session.activity ?? session.phase
  const agentError = session.lastAgentError

  // 用户主动中止不算失败（reducer 在 aborted 时也会清掉 lastAgentError，这里再兜一层）。
  if (session.running !== true && (value === 'failed' || value === 'error' || (Boolean(agentError) && agentError !== 'aborted')))
    return 'failed'
  if (value === 'review' || value === 'reviewing' || value === 'plan-review')
    return 'review'

  const hasPending = Array.isArray(session.pending) ? session.pending.length > 0 : Boolean(session.pending)
  if (value === 'waiting' || value === 'pending' || value === 'blocked' || Boolean(session.pendingInteraction) || hasPending)
    return 'waiting'
  if (value === 'running' || value === 'working' || value === 'thinking' || session.running === true)
    return 'running'

  return undefined
}

/** 工具参数里的细节（`command` / `file_path` / `pattern` …）。 */
function toolArgDetail(tool: string, args: string | undefined): string | undefined {
  if (!args)
    return undefined
  try {
    const record = JSON.parse(args) as Record<string, unknown>
    if (!record || typeof record !== 'object' || Array.isArray(record))
      return undefined
    const keys = TOOL_ARG_KEYS[tool] ?? ['file_path', 'path']
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.trim())
        return clip(value)
      if (Array.isArray(value)) {
        const first = value.find((item): item is string => typeof item === 'string' && item.trim().length > 0)
        if (first)
          return clip(first)
      }
    }
  }
  catch {
    /* 非 JSON 参数：忽略细节 */
  }
  return undefined
}

/** 实时活动文案（只有进行中的档位才展示）。 */
export function getLiveActivity(session: PetSessionPayload, motion: Motion): string | undefined {
  const live = session.liveActivity
  if (!ACTIVE_MOTIONS.has(motion) || !live || typeof live !== 'object')
    return undefined
  if (live.kind === 'reasoning' && typeof live.text === 'string' && live.text.trim())
    return `思考 · ${clip(live.text)}`
  if (live.kind === 'tool' && typeof live.name === 'string' && live.name) {
    const tool = live.name.toLowerCase()
    const label = TOOL_LABELS[tool]
    // 没有中文名的工具回落「工具调用 · <原始名>」（上游同义：宁可显示名字，也不猜用途）。
    if (!label)
      return `工具调用 · ${clip(live.name)}`
    // 细节来源：rpc 参数（`args`）优先，其次 reducer 已解析好的 `command` / `path`。
    const detail = toolArgDetail(tool, live.args)
      ?? (live.command ? clip(live.command) : undefined)
      ?? (live.path ? clip(live.path) : undefined)
    return detail ? `${label} · ${detail}` : label
  }
  return undefined
}

/** 气泡内容：标题 + 正文候选链 + 加载态。 */
export function bubbleContent(session: PetSessionPayload, motion: Motion): { title: string, description: string, loading: boolean } {
  const seed = session.id
  const fallbackCopy = motion === 'waiting'
    ? statusCopy(session.phase === 'approval' ? 'approval' : 'waiting', seed)
    : motion === 'working'
      ? activityCopy(toolActivityGroup(session.liveActivity?.name), seed)
      : statusCopy(motion, seed)

  const candidates = [
    session.lastAgentError ? `失败：${clip(String(session.lastAgentError))}` : undefined,
    taskCopy(session.task),
    getLiveActivity(session, motion),
    fallbackCopy,
    session.description,
    session.message,
  ]

  const description = candidates
    .find((item): item is string => typeof item === 'string' && item.trim().length > 0)
    ?.trim() ?? '新会话'

  return { title: sessionTitle(session), description, loading: ACTIVE_MOTIONS.has(motion) }
}

// --- 桥接状态机 -----------------------------------------------------------

/** 桥接命令面：只需要 `pet.bubble` 这一支。 */
export type BubbleHandle = PetBubbleHandle

/** 状态机选项。 */
export interface BubbleTrackerOptions {
  /**
   * 全部气泡都消失时回调。
   *
   * 渲染端在这里做 `pet.clear()`（清除**命令层动作**，不是清气泡）：终态档
   * （success / failed）由组件用命令面播一次，命令层的归还依赖「动画播完」。素材是静态图、
   * 解码失败、或 `prefers-reduced-motion` 时那个回调永远不来 —— 动画就会钉在最后一档
   * （用户报告「停止后还在循环播放」）。这里主动收掉，回落 `motion` prop 的 `idle`。
   */
  onIdle?: () => void
}

/** 一次会话的桥接状态机（对应上游 `createBubbleTracker`）。 */
export interface BubbleTracker {
  /** 收到一帧会话展示态（create / update / remove）。 */
  apply: (payload: PetSessionPayload, action: 'create' | 'update' | 'remove') => void
  /** 重放所有已追踪会话（语言切换、组件刚挂载时补齐）。 */
  flush: () => void
  /** 作废全部气泡与追踪状态（宿主累计态归零）。 */
  clear: () => void
  /** 卸载：清空但不额外发帧。 */
  dispose: () => void
}

/**
 * 创建会话 → 气泡的桥接状态机。
 *
 * 三条与上游一致的规则：
 * 1. **子代理静默**：父会话的气泡已经表达了整件事；
 * 2. **档位没了就收气泡**，若上一档是 `running` 则补一条限时的「已完成」气泡；
 * 3. **终态档只播一次**，直到会话离开终态档 —— 否则每帧都会重播一遍庆祝动画。
 */
export function createBubbleTracker(bubble: BubbleHandle, options: BubbleTrackerOptions = {}): BubbleTracker {
  const sessions = new Map<string, PetSessionPayload>()
  const previousMotion = new Map<string, Motion | undefined>()
  /** 已经播过终态档的会话（离开终态档后才允许再播一次）。 */
  const terminalShown = new Set<string>()
  /** 挂在组件上的气泡：id → 它当前的档位（用来决定「归还命令层」要不要等动画播完）。 */
  const live = new Map<string, Motion>()
  /** 待执行的「归还命令层」计时器（终态档要等动画播完）。 */
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 命令层当前是否被某个终态档占着（占着才需要主动归还）。 */
  let commandHeld = false

  const clearIdleTimer = (id: string): void => {
    const timer = idleTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      idleTimers.delete(id)
    }
  }

  /**
   * 通知宿主收掉**命令层动作**（`pet.clear()`），回落到 `motion` prop 的 `idle`。
   *
   * 终态档要**等动画播完**再说：命令面播的是「庆祝 / 失败」那一次性动作，立刻 clear 会把
   * 它掐成 idle。组件自己靠视频 `ended` 归还，但静态图 / 解码失败 / 减少动态效果时那个
   * 回调永远不来 —— 于是动画钉死在最后一档（用户报告「停止后还在循环播放」）。
   * 这里按组件同款的终态时长兜一个硬上限。
   */
  const armIdle = (id: string, motion: Motion | undefined): void => {
    if (live.size > 0)
      return
    clearIdleTimer(id)
    const wait = motion === undefined ? 0 : TERMINAL_TIMEOUT[motion] ?? 0
    if (wait <= 0) {
      if (commandHeld) {
        commandHeld = false
        options.onIdle?.()
      }
      return
    }
    const timer = setTimeout(() => {
      idleTimers.delete(id)
      if (live.size === 0 && commandHeld) {
        commandHeld = false
        options.onIdle?.()
      }
    }, wait)
    idleTimers.set(id, timer)
  }

  const forget = (id: string): void => {
    sessions.delete(id)
    previousMotion.delete(id)
    terminalShown.delete(id)
  }

  const reset = (): void => {
    sessions.clear()
    previousMotion.clear()
    terminalShown.clear()
    live.clear()
    for (const timer of idleTimers.values())
      clearTimeout(timer)
    idleTimers.clear()
    commandHeld = false
    bubble.clear()
  }

  const sync = (session: PetSessionPayload): void => {
    const { id } = session
    const motion = sessionMotion(session)
    const previous = previousMotion.get(id)

    if (motion === undefined) {
      forget(id)
      bubble.close(id)
      live.delete(id)
      // 回合跑完了，但 reducer 把 workStatus 清成了空（中止 / 收尾）：给一条会自己收起的
      // 「已完成」，而不是让气泡凭空消失。
      if (previous === 'running') {
        bubble({
          id: `${id}:done`,
          title: sessionTitle(session).trim(),
          description: '已完成',
          variant: 'success',
          timeout: DONE_BUBBLE_TIMEOUT,
        })
      }
      // 上一档若是终态（success / failed），动画还在命令层播着：等它播完的硬上限再归还。
      armIdle(id, previous)
      return
    }

    if (TERMINAL_MOTIONS.has(motion)) {
      if (terminalShown.has(id))
        return
    }
    else {
      terminalShown.delete(id)
    }

    previousMotion.set(id, motion)
    const content = bubbleContent(session, motion)
    const bubbleOptions: PetBubbleOptions = {
      id,
      title: content.title,
      description: content.description,
      loading: content.loading,
      motion,
    }
    const key = bubble(bubbleOptions)
    if (key !== '')
      live.set(id, motion)
    if (key !== '' && TERMINAL_MOTIONS.has(motion)) {
      terminalShown.add(id)
      // 终态档由组件用命令面播一次：从现在起命令层被占着，归还要么等动画播完、
      // 要么由下一次「有活干 / 掉空闲」兜底清掉。
      commandHeld = true
    }

    // 新档位（非终态）一到就归还命令层：命令层是**全局**的（一个 <Pet> 只有一个命令面），
    // 里面可能还压着任一会话上一轮的 success / failed 一次性动画（素材是静态图时它永远
    // 不会自己结束）。不清掉的话，新一轮的思考/工作会被那条旧动画盖住 —— 真实现场就是
    // 「上一个会话报错了，下一个会话一直在播失败动作」。
    if (!TERMINAL_MOTIONS.has(motion) && commandHeld) {
      commandHeld = false
      for (const key of [...idleTimers.keys()])
        clearIdleTimer(key)
      options.onIdle?.()
    }
  }

  return {
    apply(payload, action) {
      const id = payload?.id
      if (typeof id !== 'string' || id.length === 0)
        return
      if (action === 'remove' || payload.origin === 'subagent') {
        if (action === 'remove' || sessions.has(id)) {
          const previous = previousMotion.get(id)
          forget(id)
          bubble.close(id)
          live.delete(id)
          // 会话消失（归档 / 关窗）也要归还命令层，否则动画留在最后那一档。
          armIdle(id, previous)
        }
        return
      }
      sessions.set(id, payload)
      sync(payload)
    },

    flush() {
      for (const session of [...sessions.values()])
        sync(session)
    },

    clear: reset,
    dispose: reset,
  }
}
