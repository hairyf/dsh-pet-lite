import type { PetBubbleHandle, PetBubbleOptions } from 'dsh-pet-component'
import type { PetSessionPayload } from '../../src/shared/types'
import { describe, expect, it, vi } from 'vitest'
import {
  activityCopy,
  bubbleContent,
  createBubbleTracker,
  DONE_BUBBLE_TIMEOUT,
  getLiveActivity,
  isTerminalMotion,
  seedNumber,
  sessionMotion,
  sessionTitle,
  statusCopy,
  taskCopy,
  toolActivityGroup,
} from '../../src/renderer/bubble'

/**
 * 气泡桥接的契约测试。
 *
 * 结构与断言语义逐条对齐上游 `apps/desktop/src/pet/hooks/use-bubble-tracker*.test.ts`
 *（deepseek-harness-desktop v0.30.4）。这里锁三件直接影响用户可见行为的事：
 *
 *   1. **档位推导**：`workStatus` 缺失时必须用 status/activity/phase/pending/running 兜底，
 *      否则只有粗粒度状态的活动会话既没有气泡、动画也不动；
 *   2. **文案选择链**：错误 > 任务 > 实时活动 > 档位兜底；
 *   3. **桥接规则**：子代理静默、终态只播一次、档位消失即收气泡、running 结束补「已完成」、
 *      回到空闲时通知宿主收掉命令层动作（否则动画钉在最后一档）。
 */

function payload(patch: Partial<PetSessionPayload> = {}): PetSessionPayload {
  return { id: 'session-1', ...patch }
}

describe('seedNumber', () => {
  it('resolves numeric strings to the absolute truncated integer', () => {
    expect(seedNumber('12.9')).toBe(12)
    expect(seedNumber('-7')).toBe(7)
    expect(seedNumber(5)).toBe(5)
  })

  it('sums code points for non-numeric strings', () => {
    expect(seedNumber('abc')).toBe(294)
    expect(seedNumber('abd')).toBe(295)
    expect(seedNumber(undefined)).toBe(0)
    expect(seedNumber('')).toBe(0)
  })
})

describe('statusCopy / activityCopy', () => {
  it('selects a stable sentence inside the group by seed', () => {
    expect(statusCopy('thinking', 0)).toBe('正在分析')
    expect(statusCopy('thinking', 0)).toBe(statusCopy('thinking', 0))
  })

  it('falls back to the working group for unknown groups', () => {
    expect(['正在处理任务', '步骤正在进行中', '系统运行中']).toContain(statusCopy('nope', 0))
  })

  it('maps activity categories and falls back for unknown ones', () => {
    expect(['正在检索', '正在项目中进行全面搜索', '正在调阅相关文件']).toContain(activityCopy('searching', 0))
    expect(['正在处理任务', '步骤正在进行中', '系统运行中']).toContain(activityCopy('weird', 0))
  })
})

describe('toolActivityGroup', () => {
  it('classifies tools by intent', () => {
    expect(toolActivityGroup('grep')).toBe('searching')
    expect(toolActivityGroup('read')).toBe('searching')
    expect(toolActivityGroup('write')).toBe('editing')
    expect(toolActivityGroup('run_test')).toBe('testing')
    expect(toolActivityGroup('pwsh')).toBe('commanding')
    expect(toolActivityGroup('think')).toBe('working')
    expect(toolActivityGroup(undefined)).toBe('working')
  })
})

describe('taskCopy', () => {
  it('strips trailing punctuation and keeps 正在/继续 as-is', () => {
    expect(taskCopy('正在写测试。')).toBe('正在写测试')
    expect(taskCopy('继续修改文档')).toBe('继续修改文档')
  })

  it('prefixes action verbs with 正在 and wraps the rest', () => {
    expect(taskCopy('修改 bug')).toBe('正在修改 bug')
    expect(taskCopy('把动画接到气泡')).toBe('正在处理「把动画接到气泡」')
  })

  it('returns undefined for empty tasks', () => {
    expect(taskCopy(undefined)).toBeUndefined()
    expect(taskCopy('   ')).toBeUndefined()
  })
})

describe('sessionTitle', () => {
  it('prefers title / displayTitle / name', () => {
    expect(sessionTitle(payload({ title: '修复宠物' }))).toBe('修复宠物')
    expect(sessionTitle(payload({ displayTitle: '修复宠物' }))).toBe('修复宠物')
    expect(sessionTitle(payload({ name: '修复宠物' }))).toBe('修复宠物')
  })

  it('falls back to 新会话 instead of leaking the session id', () => {
    const title = sessionTitle(payload({ id: 'session-2a2abd15' }))
    expect(title).toBe('新会话')
    expect(title).not.toContain('session-')
  })

  it('keeps attention prefixes on top of the fallback', () => {
    expect(sessionTitle(payload({ phase: 'approval', title: '会话' }))).toBe('需授权 · 会话')
    expect(sessionTitle(payload({ phase: 'blocked', title: '会话' }))).toBe('需选择 · 会话')
    expect(sessionTitle(payload({ origin: 'subagent', title: '会话' }))).toBe('子代理 · 会话')
  })
})

describe('sessionMotion', () => {
  it('prefers the fine-grained workStatus over the coarse status', () => {
    expect(sessionMotion(payload({ workStatus: 'success', status: 'error' }))).toBe('success')
    expect(sessionMotion(payload({ workStatus: 'waiting', status: 'failed' }))).toBe('waiting')
  })

  it('derives failed from status / activity / lastAgentError when workStatus is missing', () => {
    expect(sessionMotion(payload({ status: 'failed' }))).toBe('failed')
    expect(sessionMotion(payload({ activity: 'error' }))).toBe('failed')
    expect(sessionMotion(payload({ lastAgentError: 'boom' }))).toBe('failed')
  })

  it('treats an aborted error as a non-failure', () => {
    expect(sessionMotion(payload({ lastAgentError: 'aborted' }))).toBeUndefined()
  })

  it('keeps a running session out of the failed tier', () => {
    expect(sessionMotion(payload({ status: 'failed', running: true }))).toBe('running')
    expect(sessionMotion(payload({ lastAgentError: 'boom', running: true }))).toBe('running')
  })

  it('derives review and waiting tiers', () => {
    expect(sessionMotion(payload({ status: 'review' }))).toBe('review')
    expect(sessionMotion(payload({ activity: 'reviewing' }))).toBe('review')
    expect(sessionMotion(payload({ phase: 'plan-review' }))).toBe('review')
    expect(sessionMotion(payload({ status: 'waiting' }))).toBe('waiting')
    expect(sessionMotion(payload({ phase: 'blocked' }))).toBe('waiting')
    expect(sessionMotion(payload({ pendingInteraction: { id: 'q1' } }))).toBe('waiting')
    expect(sessionMotion(payload({ pending: ['x'] }))).toBe('waiting')
  })

  it('derives running from the coarse fields and idle when nothing indicates work', () => {
    expect(sessionMotion(payload({ status: 'running' }))).toBe('running')
    expect(sessionMotion(payload({ activity: 'thinking' }))).toBe('running')
    expect(sessionMotion(payload({ running: true }))).toBe('running')
    // 中止后：running=false、无错误、无等待 —— 必须回落空闲，气泡才会收起、动画才会停。
    expect(sessionMotion(payload({ running: false }))).toBeUndefined()
    expect(sessionMotion(payload())).toBeUndefined()
  })
})

describe('getLiveActivity', () => {
  it('only projects live activity for active motions', () => {
    const session = payload({ liveActivity: { kind: 'reasoning', text: '解析' } })
    expect(getLiveActivity(session, 'success')).toBeUndefined()
    expect(getLiveActivity(session, 'waiting')).toBeUndefined()
    expect(getLiveActivity(session, 'thinking')).toBe('思考 · 解析')
  })

  it('sanitizes the reasoning tail', () => {
    expect(getLiveActivity(payload({ liveActivity: { kind: 'reasoning', text: '  解析\n  代码  ' } }), 'thinking'))
      .toBe('思考 · 解析 代码')
    expect(getLiveActivity(payload({ liveActivity: { kind: 'reasoning', text: '   ' } }), 'thinking')).toBeUndefined()
  })

  it('renders the tool label with its argument detail', () => {
    expect(getLiveActivity(payload({ liveActivity: { kind: 'tool', name: 'pwsh', args: '{"command":"ls -la"}' } }), 'working'))
      .toBe('Pwsh · ls -la')
    expect(getLiveActivity(payload({ liveActivity: { kind: 'tool', name: 'read', args: '{"file_path":["a.ts","b.ts"]}' } }), 'working'))
      .toBe('读取 · a.ts')
  })

  it('falls back to the raw tool name', () => {
    expect(getLiveActivity(payload({ liveActivity: { kind: 'tool', name: 'custom_tool' } }), 'working'))
      .toBe('工具调用 · custom_tool')
    expect(getLiveActivity(payload({ liveActivity: { kind: 'tool', name: 'grep', args: 'not-json' } }), 'working'))
      .toBe('Grep')
  })
})

describe('bubbleContent', () => {
  it('carries the title, the task copy and the loading flag', () => {
    expect(bubbleContent(payload({ title: '会话一', task: '修复登录' }), 'working'))
      .toEqual({ title: '会话一', description: '正在修复登录', loading: true })
  })

  it('prefers the agent error over any task copy', () => {
    expect(bubbleContent(payload({ title: '会话一', task: '修复登录', lastAgentError: 'boom' }), 'failed'))
      .toEqual({ title: '会话一', description: '失败：boom', loading: false })
  })

  it('prefers live activity over the motion copy', () => {
    expect(bubbleContent(payload({ title: '会话一', liveActivity: { kind: 'reasoning', text: '解析' } }), 'thinking'))
      .toEqual({ title: '会话一', description: '思考 · 解析', loading: true })
  })

  it('uses the approval copy and keeps the title prefix', () => {
    // seed 取 id：id='0' 时固定选中该组第 0 句。
    expect(bubbleContent({ id: '0', phase: 'approval', title: '会话一' }, 'waiting'))
      .toEqual({ title: '需授权 · 会话一', description: '等待审批', loading: false })
  })

  it('renders the tool label with its command detail', () => {
    // `command` / `path` 由 reducer 解析好；`args` 是原始 JSON，两者都支持。
    expect(bubbleContent({ id: '0', title: '会话一', liveActivity: { kind: 'tool', name: 'pwsh', command: 'pnpm test' } }, 'working').description)
      .toBe('Pwsh · pnpm test')
    expect(bubbleContent({ id: '0', title: '会话一', liveActivity: { kind: 'tool', name: 'grep' } }, 'working').description)
      .toBe('Grep')
    expect(bubbleContent({ id: '0', title: '会话一', liveActivity: { kind: 'tool', name: 'no_such_tool' } }, 'working').description)
      .toBe('工具调用 · no_such_tool')
  })

  it('falls back to the untitled title and motion copy', () => {
    expect(bubbleContent({ id: '0' }, 'thinking')).toEqual({ title: '新会话', description: '正在分析', loading: true })
  })
})

describe('isTerminalMotion', () => {
  it('marks only the one-shot terminal gears', () => {
    for (const motion of ['success', 'failed', 'error', 'review'] as const)
      expect(isTerminalMotion(motion)).toBe(true)
    for (const motion of ['thinking', 'working', 'waiting', 'running', 'result', undefined] as const)
      expect(isTerminalMotion(motion)).toBe(false)
  })
})

// --- 桥接状态机 -----------------------------------------------------------

type Call
  = | { type: 'show', options: PetBubbleOptions }
    | { type: 'close', id: string | undefined }
    | { type: 'clear' }

/** 假命令面：`mounted` 控制 `pet.bubble` 返回 key 还是空串（组件未挂载）。 */
function createFakeBubble(initiallyMounted = true) {
  const calls: Call[] = []
  const state = { mounted: initiallyMounted }
  const bubble = ((options: PetBubbleOptions) => {
    calls.push({ type: 'show', options })
    return state.mounted ? options.id ?? `auto-${calls.length}` : ''
  }) as PetBubbleHandle
  bubble.close = (id?: string) => {
    calls.push({ type: 'close', id })
  }
  bubble.clear = () => {
    calls.push({ type: 'clear' })
  }
  return { bubble, calls, state }
}

function shows(calls: Call[]): PetBubbleOptions[] {
  return calls.filter(call => call.type === 'show').map(call => call.options)
}

describe('createBubbleTracker', () => {
  it('maps a session snapshot to a bubble carrying its own motion', () => {
    const { bubble, calls } = createFakeBubble()
    createBubbleTracker(bubble).apply(payload({ title: '会话一', workStatus: 'working', task: '修复登录' }), 'create')

    expect(shows(calls)).toEqual([
      { id: 'session-1', title: '会话一', description: '正在修复登录', loading: true, motion: 'working' },
    ])
  })

  it('shows a bubble for a session that only carries the coarse status', () => {
    // 关键回归：没有 workStatus 时也必须出气泡（否则「会话进行中一个气泡都没有」）。
    const { bubble, calls } = createFakeBubble()
    createBubbleTracker(bubble).apply(payload({ title: '会话一', running: true }), 'update')

    expect(shows(calls)).toHaveLength(1)
    expect(shows(calls)[0]?.motion).toBe('running')
  })

  it('keeps every subagent session silent', () => {
    const { bubble, calls } = createFakeBubble()
    const tracker = createBubbleTracker(bubble)
    tracker.apply(payload({ origin: 'subagent', title: '子代理', workStatus: 'working' }), 'create')
    tracker.apply(payload({ origin: 'subagent', title: '子代理', workStatus: 'result' }), 'update')
    expect(calls).toEqual([])
  })

  it('closes the bubble when the session is removed or falls back to no motion', () => {
    const { bubble, calls } = createFakeBubble()
    const tracker = createBubbleTracker(bubble)
    tracker.apply(payload({ workStatus: 'thinking' }), 'create')
    tracker.apply(payload(), 'update')
    tracker.apply({ id: 'session-2', workStatus: 'thinking' }, 'create')
    tracker.apply({ id: 'session-2' }, 'remove')

    expect(calls.filter(call => call.type === 'close')).toEqual([
      { type: 'close', id: 'session-1' },
      { type: 'close', id: 'session-2' },
    ])
  })

  it('leaves the command layer alone for a session that never showed a terminal gear', () => {
    // 普通工作档走的是声明式 motion prop，没占用命令层 —— 不需要也不该 clear。
    let idle = 0
    const { bubble } = createFakeBubble()
    const tracker = createBubbleTracker(bubble, { onIdle: () => {
      idle += 1
    } })
    tracker.apply(payload({ workStatus: 'thinking' }), 'create')
    tracker.apply(payload(), 'update')
    tracker.apply(payload(), 'remove')
    expect(idle).toBe(0)
  })

  it('returns the command layer on remove after a terminal gear', () => {
    vi.useFakeTimers()
    try {
      let idle = 0
      const { bubble } = createFakeBubble()
      const tracker = createBubbleTracker(bubble, { onIdle: () => {
        idle += 1
      } })
      tracker.apply(payload({ workStatus: 'success' }), 'update')
      tracker.apply(payload(), 'remove')
      expect(idle).toBe(0)

      vi.advanceTimersByTime(3000)
      expect(idle).toBe(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('delays the command-layer return while a terminal gear is still playing', () => {
    // 终态动画由命令面播一次：立刻 clear 会把它掐成 idle，所以要等组件同款的时长。
    vi.useFakeTimers()
    try {
      let idle = 0
      const { bubble } = createFakeBubble()
      const tracker = createBubbleTracker(bubble, { onIdle: () => {
        idle += 1
      } })
      tracker.apply(payload({ workStatus: 'success' }), 'update')
      tracker.apply(payload(), 'update')
      expect(idle).toBe(0)

      vi.advanceTimersByTime(3000)
      expect(idle).toBe(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('shows a terminal motion only once until the session leaves it', () => {
    const { bubble, calls } = createFakeBubble()
    const tracker = createBubbleTracker(bubble)
    tracker.apply(payload({ workStatus: 'success' }), 'update')
    tracker.apply(payload({ workStatus: 'success' }), 'update')
    expect(shows(calls)).toHaveLength(1)

    tracker.apply(payload({ workStatus: 'thinking' }), 'update')
    tracker.apply(payload({ workStatus: 'success' }), 'update')
    expect(shows(calls)).toHaveLength(3)
  })

  it('appends a one-shot done bubble when a running turn ends without a work status', () => {
    const { bubble, calls } = createFakeBubble()
    const tracker = createBubbleTracker(bubble)
    tracker.apply(payload({ title: '会话一', running: true }), 'create')
    tracker.apply(payload({ title: '会话一', running: false }), 'update')

    expect(shows(calls).at(-1)).toEqual({
      id: 'session-1:done',
      title: '会话一',
      description: '已完成',
      variant: 'success',
      timeout: DONE_BUBBLE_TIMEOUT,
    })
  })

  it('clears tracked sessions without forgetting future updates', () => {
    const { bubble, calls } = createFakeBubble()
    const tracker = createBubbleTracker(bubble)
    tracker.apply(payload({ workStatus: 'working' }), 'create')
    tracker.clear()
    expect(calls.at(-1)).toEqual({ type: 'clear' })

    tracker.apply(payload({ workStatus: 'thinking' }), 'create')
    expect(shows(calls).at(-1)?.motion).toBe('thinking')
  })

  it('drops state and clears component bubbles on dispose', () => {
    const { bubble, calls } = createFakeBubble()
    const tracker = createBubbleTracker(bubble)
    tracker.apply(payload({ workStatus: 'working' }), 'create')
    tracker.dispose()
    tracker.flush()

    expect(calls.at(-1)).toEqual({ type: 'clear' })
    expect(shows(calls)).toHaveLength(1)
  })
})
