import type { PetRuntimeStatus, PetSettingsFrame, SessionStreamSink } from '../shared/types'

/**
 * host/settings-stream.ts — 设置变更推送流（给**已打开**的桌宠窗口）。
 *
 * 【为什么必须有】桌宠窗口只在挂载时 `GET /settings` 一次，而设置页的写入路径
 * （`PUT /settings`）只改持久层。没有推送通道时：
 *
 * - 拖动大小滑条 → 持久层变了、窗口的 `<Pet size>` 却还是旧值（用户报告「拖了也不变」）；
 * - 关掉抛射 → 窗口仍按 `throw_enabled=true` 处理（用户报告「明明关了还是会飞」）；
 * - 换宠物 / 启用关闭 → 窗口要等下次重启才跟上。
 *
 * 这条流与 `/session/stream` **刻意分开**：后者是会话增量投影（reducer 逐字复刻上游），
 * 把设置帧混进去会让那份契约漂移。两条流的帧形状也各自独立（`PetSessionFrame` /
 * `PetSettingsFrame`）。
 *
 * 消费模型与 session-stream 一致：**没有消费者就没有状态**，断开即移除。
 */

/** 已接入的设置消费者（断连即移除）。 */
const sinks = new Set<SessionStreamSink>()

/** 当前设置流消费者数量（诊断 / 测试用）。 */
export function settingsSinkCount(): number {
  return sinks.size
}

/** 接入一个设置消费者；返回 detach（幂等）。 */
export function attachSettings(sink: SessionStreamSink): () => void {
  sinks.add(sink)
  return () => {
    sinks.delete(sink)
  }
}

/**
 * 把最新设置推给所有已打开的窗口。
 *
 * 写失败不在这里处理：断连由各自的 `close` 回调清理（与 session-stream 的 publish 同义）。
 */
export function publishSettings(status: PetRuntimeStatus): void {
  if (sinks.size === 0)
    return
  const frame: PetSettingsFrame = { action: 'settings', payload: status }
  const body = JSON.stringify(frame)
  for (const sink of sinks)
    sink.push(body)
}

/** 测试用：清空消费者。 */
export function resetSettingsStream(): void {
  for (const sink of [...sinks]) {
    sinks.delete(sink)
    sink.close()
  }
}
