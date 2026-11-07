#!/usr/bin/env node
/**
 * scripts/verify-behavior.mjs — 在真实 Electron 窗口里验证三个用户可见行为。
 *
 * 这三个都是「只在真窗口里才看得见」的回归，必须在真 DOM / 真 IPC 上跑：
 *
 *   1. **气泡**：会话进行中必须有气泡，成功 / 失败也要有（早先渲染端从不调用 `pet.bubble`）；
 *   2. **停止**：会话中止（`workStatus` 回落空闲）后气泡收起、动画回到 `idle`
 *      （早先 `if (workStatus && ...)` 直接跳过，动画永远停在上一个思考/工作档）；
 *   3. **大小**：设置变更后窗口与宠物一起变（早先只在挂载时读一次，滑条等于没接线）；
 *   4. **抛射开关**：`throw_enabled=false` 时松手即定住，不甩出。
 *
 * 做法与 verify-drag 一致：拉起 helper（不经 DSH），开远程调试端口用 CDP 派发真实指针
 * 手势 / 读 DOM，宿主侧是一个可编程的极简假宿主（同进程，直接改状态并广播 SSE）。
 *
 * 用法：node scripts/verify-behavior.mjs
 */

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import process from 'node:process'

const DEBUG_PORT = 9227
const HOST_PORT = 39999
const electronPath = join(process.env.USERPROFILE ?? '', '.dsh', 'electron', 'electron.exe')
const helper = join(process.cwd(), 'runtime', 'electron-helper', 'main.cjs')

if (!existsSync(electronPath)) {
  console.error('electron not found:', electronPath)
  process.exit(1)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// --- 可编程假宿主 -------------------------------------------------------

/** 当前权威状态（设置页会改它）。 */
const status = {
  active_pet: 'probe',
  enabled: true,
  pet_size: 100,
  throw_enabled: false,
  visible: true,
  desktop_supported: true,
  desktop_open: true,
  open_url: '',
}

/** 已接入的 SSE 消费者。 */
const settingsSinks = new Set()
const sessionSinks = new Set()

function broadcast(sinks, frame) {
  for (const sink of sinks)
    sink(frame)
}

/** 推一帧设置（= `PUT /settings` 之后的 publishSettings）。 */
function pushSettings() {
  broadcast(settingsSinks, JSON.stringify({ action: 'settings', payload: status }))
}

/** 推一帧会话展示态。 */
function pushSession(action, payload) {
  broadcast(sessionSinks, JSON.stringify({ action, payload: { id: 'session-1', ...payload } }))
}

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'connection': 'keep-alive' })
  return (frame) => {
    res.write(`data: ${frame}\n\n`)
  }
}

function startFakeHost() {
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/dsh-pet-lite/settings') {
      json(status)
      return
    }
    if (url.pathname === '/dsh-pet-lite/settings/stream') {
      const push = sse(res)
      settingsSinks.add(push)
      // 与真路由一致：接上先给一帧当前状态。
      push(JSON.stringify({ action: 'settings', payload: status }))
      req.on('close', () => settingsSinks.delete(push))
      return
    }
    if (url.pathname === '/dsh-pet-lite/asset') {
      json({
        kind: 'dsh',
        id: 'probe',
        size: 200,
        config: { motions: { idle: 'idle', thinking: 'idle', working: 'idle', result: 'idle', waiting: 'idle', success: 'idle', failed: 'idle' } },
        uri: { default: `http://127.0.0.1:${HOST_PORT}/media` },
        ext: { default: 'gif' },
      })
      return
    }
    if (url.pathname.startsWith('/media')) {
      res.writeHead(200, { 'content-type': 'image/gif' })
      res.end(pixel)
      return
    }
    if (url.pathname === '/dsh-pet-lite/session/stream') {
      const push = sse(res)
      sessionSinks.add(push)
      req.on('close', () => sessionSinks.delete(push))
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise(resolve => server.listen(HOST_PORT, '127.0.0.1', () => resolve(server)))
}

const fakeHost = await startFakeHost()
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electronPath, [helper, `--remote-debugging-port=${DEBUG_PORT}`], {
  env: {
    ...env,
    DSH_PET_LITE_ORIGIN: `http://127.0.0.1:${HOST_PORT}`,
    DSH_PET_LITE_CONFIG_URL: `http://127.0.0.1:${HOST_PORT}/dsh-pet-lite/catalog`,
    DSH_PET_LITE_TRACE_BOUNDS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let stdout = ''
child.stdout.on('data', (chunk) => {
  stdout += String(chunk)
})
child.stderr.on('data', () => {})

const failures = []
function check(ok, message) {
  if (!ok)
    failures.push(message)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`)
}

function boundsTrace() {
  return stdout.split('\n').filter(line => line.startsWith('[bounds]'))
}

async function main() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then(r => r.json())
      break
    }
    catch {
      await sleep(500)
    }
  }
  await sleep(3500)

  const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then(r => r.json())
  const page = targets.find(target => target.type === 'page')
  if (!page)
    throw new Error('no page target')

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let messageId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const resolve = pending.get(message.id)
    if (resolve) {
      pending.delete(message.id)
      resolve(message)
    }
  })
  const send = (method, params) => {
    const id = ++messageId
    return new Promise((resolve) => {
      pending.set(id, resolve)
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.result.exceptionDetails)
      throw new Error(JSON.stringify(response.result.exceptionDetails))
    return response.result.result.value
  }

  const snapshot = () => evaluate(`(() => {
    const pet = document.querySelector('.dsh-pet')
    const bubbles = [...document.querySelectorAll('.dsh-pet__bubble')]
    const rect = pet ? pet.getBoundingClientRect() : null
    const bubbleRect = bubbles[0] ? bubbles[0].getBoundingClientRect() : null
    return {
      motion: pet?.getAttribute('data-motion') ?? null,
      bubbleCount: bubbles.length,
      bubbleText: bubbles.map(node => node.textContent ?? '').join(' | '),
      bubbleClasses: bubbles.map(node => node.className).join(' '),
      petWidth: rect ? Math.round(rect.width) : 0,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      // 气泡必须**完整落在窗口内**：窗口只有宠物 + 留白时气泡会被裁掉（用户看到「没有气泡」）。
      bubbleInsideWindow: bubbleRect
        ? bubbleRect.top >= 0 && bubbleRect.bottom <= window.innerHeight
          && bubbleRect.left >= 0 && bubbleRect.right <= window.innerWidth
        : null,
    }
  })()`)

  // --- 0. 首屏：宠物已挂载、无气泡 ---------------------------------------
  const boot = await snapshot()
  check(boot.motion === 'idle', `初始动作是 idle（实际 ${boot.motion}）`)
  check(boot.bubbleCount === 0, `初始没有气泡（实际 ${boot.bubbleCount}）`)
  check(boot.petWidth === 200, `100% 档位下宠物宽 200（实际 ${boot.petWidth}）`)

  // --- 1. 进行中：气泡必须出现 -------------------------------------------
  pushSession('update', { workStatus: 'thinking', displayTitle: '会话标题', liveActivity: { kind: 'reasoning', text: '正在分析代码' } })
  await sleep(900)
  const thinking = await snapshot()
  check(thinking.bubbleCount === 1, `thinking 时出现 1 条气泡（实际 ${thinking.bubbleCount}）`)
  check(thinking.bubbleInsideWindow === true, `气泡完整落在窗口内（不被裁掉，实际 ${thinking.bubbleInsideWindow}）`)
  check(thinking.bubbleText.includes('会话标题'), `气泡标题取自会话（实际「${thinking.bubbleText}」）`)
  check(thinking.motion === 'thinking', `thinking 时动作是 thinking（实际 ${thinking.motion}）`)

  // 原地更新（同一 id）：不新增气泡，只换文案。
  pushSession('update', { workStatus: 'working', toolActivity: 'commanding', liveActivity: { kind: 'tool', name: 'pwsh', command: 'pnpm test' } })
  await sleep(900)
  const working = await snapshot()
  check(working.bubbleCount === 1, `working 原地更新不新增气泡（实际 ${working.bubbleCount}）`)
  check(working.bubbleText.includes('pnpm test'), `气泡正文跟着工具变化（实际「${working.bubbleText}」）`)
  check(working.motion === 'working', `working 时动作是 working（实际 ${working.motion}）`)

  // --- 2. 成功：终态气泡 + 语义色 ----------------------------------------
  // 收起进行中的那条，只看终态气泡（否则多条并存，断言不好定位）。
  pushSession('remove', {})
  await sleep(700)
  pushSession('update', { id: 'session-ok', title: '成功的会话', workStatus: 'success', task: '跑通了' })
  await sleep(900)
  const success = await snapshot()
  check(success.bubbleCount === 1, `success 时出现气泡（实际 ${success.bubbleCount}）`)
  check(success.bubbleInsideWindow === true, `终态气泡也在窗口内（实际 ${success.bubbleInsideWindow}）`)
  check(success.bubbleClasses.includes('dsh-pet__bubble--success'), `success 气泡带成功语义色（实际「${success.bubbleClasses}」）`)

  // --- 3. 失败：danger 语义色 --------------------------------------------
  pushSession('remove', { id: 'session-ok' })
  await sleep(700)
  pushSession('update', { id: 'session-bad', title: '失败的会话', workStatus: 'error', lastAgentError: '命令失败' })
  await sleep(900)
  const failure = await snapshot()
  check(failure.bubbleCount === 1, `error 时出现气泡（实际 ${failure.bubbleCount}）`)
  check(failure.bubbleClasses.includes('dsh-pet__bubble--danger'), `error 气泡带危险语义色（实际「${failure.bubbleClasses}」）`)
  pushSession('remove', { id: 'session-bad' })
  await sleep(700)

  // --- 3.5 只有粗粒度状态也要出气泡（上游 sessionMotion 的兜底） ----------
  pushSession('update', { id: 'session-coarse', title: '粗粒度会话', workStatus: undefined, running: true, status: 'running' })
  await sleep(900)
  const coarse = await snapshot()
  check(coarse.bubbleCount === 1, `没有 workStatus 但 running 时仍有气泡（实际 ${coarse.bubbleCount}）`)
  check(coarse.motion === 'running', `粗粒度状态推到 running 档（实际 ${coarse.motion}）`)

  // --- 4. 中止：气泡收起、动作回落 idle ----------------------------------
  pushSession('update', { id: 'session-coarse', workStatus: undefined, running: false, status: undefined })
  await sleep(1200)
  const stopped = await snapshot()
  // 上游语义：running 掉到空闲会补一条 3s 的「已完成」气泡（id 为 `<id>:done`），
  // 这里等它自己收起后再断言「气泡全没了、动画回 idle」。
  const stoppedMessage = `中止后先给出「已完成」或已收起（实际「${stopped.bubbleText}」）`
  check(stopped.bubbleText.includes('已完成') || stopped.bubbleCount === 0, stoppedMessage)
  await sleep(3200)
  const settled = await snapshot()
  check(settled.bubbleCount === 0, `中止后气泡最终全部收起（实际 ${settled.bubbleCount}）`)
  check(settled.motion === 'idle', `中止后动作回落 idle（实际 ${settled.motion}）`)

  // --- 5. remove 帧：直接收起 --------------------------------------------
  pushSession('update', { id: 'session-rm', workStatus: 'thinking', running: true })
  await sleep(700)
  check((await snapshot()).bubbleCount === 1, 'remove 前有一条气泡')
  pushSession('remove', { id: 'session-rm' })
  await sleep(1000)
  const removed = await snapshot()
  check(removed.bubbleCount === 0, `remove 帧收起气泡（实际 ${removed.bubbleCount}）`)
  check(removed.motion === 'idle', `remove 帧后动作回落 idle（实际 ${removed.motion}）`)

  // --- 6. 大小：设置推送必须立刻改变窗口与宠物 ---------------------------
  // 窗口宽度有下限（PET_BUBBLE_MIN_WIDTH=420），所以用高度与宠物宽度断言「确实变大了」。
  const before = await snapshot()
  status.pet_size = 150
  pushSettings()
  await sleep(1200)
  const resized = await snapshot()
  check(resized.petWidth === 300, `150% 档位下宠物宽 300（实际 ${resized.petWidth}）`)
  check(resized.windowWidth >= before.windowWidth, `窗口宽度不小于原来的下限（${before.windowWidth} → ${resized.windowWidth}）`)
  check(resized.windowHeight > before.windowHeight, `窗口高度跟着变大（${before.windowHeight} → ${resized.windowHeight}）`)

  // 缩回到 50%：窗口下限让它不再变小，但宠物确实缩小了。
  status.pet_size = 50
  pushSettings()
  await sleep(1200)
  const shrunk = await snapshot()
  check(shrunk.petWidth === 100, `50% 档位下宠物宽 100（实际 ${shrunk.petWidth}）`)
  check(shrunk.windowWidth === 420, `窗口宽度保留下限 420（实际 ${shrunk.windowWidth}）`)
  status.pet_size = 100
  pushSettings()
  await sleep(1000)

  // --- 7. 抛射开关：关闭时松手定住 --------------------------------------
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
    pointerType: 'mouse',
  })
  const hitboxCenter = () => evaluate(`(() => {
    const element = document.querySelector('.dsh-pet__hitbox')
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })()`)

  /** 快速甩一下（保证估算初速远超死区），返回松手后的窗口位移条数。 */
  async function flingAndCountMoves() {
    const box = await hitboxCenter()
    if (!box)
      return -1
    stdout = ''
    await mouse('mousePressed', box.x, box.y)
    for (let step = 1; step <= 12; step++) {
      await mouse('mouseMoved', box.x - (520 * step) / 12, box.y - (320 * step) / 12)
      await sleep(8)
    }
    await mouse('mouseReleased', box.x - 520, box.y - 320)
    // 等弹簧把窗口追到目标：拖拽本身也会继续发 moveTo，先让它收敛再计飞行帧。
    await sleep(700)
    const atRelease = boundsTrace().length
    await sleep(1400)
    // 松手后的增量 = 飞行帧；关闭抛射时应当只有落位那一下。
    return boundsTrace().length - atRelease
  }

  status.throw_enabled = false
  pushSettings()
  await sleep(800)
  const idleFlight = await flingAndCountMoves()
  check(idleFlight >= 0, `抛射关闭时能完成一次拖拽（帧数 ${idleFlight}）`)
  check(idleFlight <= 6, `抛射关闭时松手不飞行（松手后位移帧 ${idleFlight}，只允许落位那几下）`)

  // 打开抛射后同样的手势必须飞出去（否则说明「关掉没飞」只是因为手势太轻）。
  status.throw_enabled = true
  pushSettings()
  await sleep(800)
  const flying = await flingAndCountMoves()
  check(flying > idleFlight + 10, `抛射开启时松手会飞行（关闭 ${idleFlight} 帧 / 开启 ${flying} 帧）`)

  socket.close()
}

try {
  await main()
}
finally {
  child.kill()
  fakeHost.close()
}

if (failures.length) {
  console.error('\nFAILED:')
  for (const line of failures)
    console.error(' -', line)
  process.exit(1)
}
console.log('\nOK: bubbles, stop-to-idle, live size and throw switch all behave')
