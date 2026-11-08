#!/usr/bin/env node
/**
 * scripts/verify-drag.mjs — 在真实 Electron 窗口里验证「能拖着宠物横跨屏幕」。
 *
 * 这个脚本是为两个真实故障写的回归验证：
 *   1. 一拖动就跳到屏幕左上角（把「窗口内偏移 48」当成屏幕坐标用了）；
 *   2. 只能在原地一小片里挪（拿窗口自身尺寸当边界，且指针一出窗口事件就断流）。
 *
 * 做法：拉起 helper（不经 DSH），开远程调试端口用 CDP 派发**真实指针手势**，
 * 读主进程的 `[bounds]` 轨迹确认窗口真的在动、且位移量级正确。
 *
 * 需要一个能返回宠物的宿主路由；不接真 DSH 时用内置的极简假宿主（只供几何验证）。
 *
 * 用法：node scripts/verify-drag.mjs
 */

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import process from 'node:process'

const DEBUG_PORT = 9226
const FAKE_HOST_PORT = 39998
// 同 verify-behavior.mjs：显式注入优先，默认落地目录兜底。
const electronPath = process.env.DSH_PET_ELECTRON_PATH
  || join(process.env.USERPROFILE ?? '', '.dsh', 'electron', 'electron.exe')
const helper = join(process.cwd(), 'runtime', 'electron-helper', 'main.cjs')

if (!existsSync(electronPath)) {
  console.error('electron not found:', electronPath)
  process.exit(1)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 极简假宿主：只为让渲染端拿到一只可渲染的 dsh 宠物（几何验证不需要真素材）。 */
function startFakeHost() {
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/dsh-pet-lite/settings') {
      json({
        active_pet: 'probe',
        enabled: true,
        pet_size: 120,
        throw_enabled: true,
        visible: true,
        desktop_supported: true,
        desktop_open: true,
      })
      return
    }
    if (url.pathname === '/dsh-pet-lite/asset') {
      json({
        kind: 'dsh',
        id: 'probe',
        size: 200,
        config: { motions: { idle: `data:image/gif;base64,${pixel.toString('base64')}` } },
        uri: { default: `http://127.0.0.1:${FAKE_HOST_PORT}/media` },
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
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': ok\n\n')
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise(resolve => server.listen(FAKE_HOST_PORT, '127.0.0.1', () => resolve(server)))
}

const fakeHost = await startFakeHost()

// 【必须摘掉 ELECTRON_RUN_AS_NODE】dsh-tauri 桌面端用它让同一个二进制跑 Node 内核，
// 继承到桌宠窗口就会以 Node 模式执行 main.cjs（`require('electron')` 返回路径、`app` 为
// undefined）—— 进程立刻退出，CDP 端口连不上。宿主侧 `helperChildEnv()` 做同一件事。
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, [helper, `--remote-debugging-port=${DEBUG_PORT}`], {
  env: {
    ...env,
    DSH_PET_LITE_ORIGIN: `http://127.0.0.1:${FAKE_HOST_PORT}`,
    DSH_PET_LITE_CONFIG_URL: `http://127.0.0.1:${FAKE_HOST_PORT}/dsh-pet-lite/catalog`,
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

async function getJson(path) {
  const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}${path}`)
  return response.json()
}

function boundsTrace() {
  return stdout
    .split('\n')
    .filter(line => line.startsWith('[bounds]'))
    .map(line => line.replace('[bounds] ', '').split(',').map(Number))
}

const failures = []

try {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await getJson('/json/list')
      break
    }
    catch {
      await sleep(500)
    }
  }
  await sleep(3000)

  const targets = await getJson('/json/list')
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
    const response = await send('Runtime.evaluate', { expression, returnByValue: true })
    return response.result.result.value
  }
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

  const initialBox = await hitboxCenter()
  if (!initialBox) {
    failures.push('no hitbox rendered (pet never loaded)')
  }
  else {
    // 第一段：右下 → 左上
    stdout = ''
    const before = boundsTrace()
    const start = before.length ? before[before.length - 1] : null
    const box = initialBox
    await mouse('mousePressed', box.x, box.y)
    for (let step = 1; step <= 40; step++) {
      await mouse('mouseMoved', box.x - (1100 * step) / 40, box.y - (700 * step) / 40)
      await sleep(14)
    }
    await sleep(250)
    await mouse('mouseReleased', box.x - 1100, box.y - 700)
    await sleep(1200)

    const leg1 = boundsTrace()
    if (leg1.length < 2) {
      failures.push('window never repositioned during drag')
    }
    else {
      const first = start ?? leg1[0]
      const last = leg1[leg1.length - 1]
      const dx = last[0] - first[0]
      const dy = last[1] - first[1]
      console.log(`drag to top-left: dx=${dx} dy=${dy} (${leg1.length} updates)`)
      // 回归 1：不能跳回原点。
      if (last[0] === 0 && last[1] === 0)
        failures.push('window snapped to origin (0,0)')
      // 回归 2：必须能跨越大距离，而不是缩在原地一小片。
      if (dx > -400)
        failures.push(`drag moved too little horizontally (dx=${dx})`)
      if (dy > -200)
        failures.push(`drag moved too little vertically (dy=${dy})`)
    }

    // 第二段：左上 → 右下（证明夹取只在贴边时生效）
    stdout = ''
    const box2 = await hitboxCenter()
    if (!box2) {
      failures.push('hitbox lost after first drag')
    }
    else {
      await mouse('mousePressed', box2.x, box2.y)
      for (let step = 1; step <= 40; step++) {
        await mouse('mouseMoved', box2.x + (1100 * step) / 40, box2.y + (700 * step) / 40)
        await sleep(14)
      }
      await sleep(250)
      await mouse('mouseReleased', box2.x + 1100, box2.y + 700)
      await sleep(1200)

      const leg2 = boundsTrace()
      if (leg2.length >= 2) {
        const dx = leg2[leg2.length - 1][0] - leg2[0][0]
        const dy = leg2[leg2.length - 1][1] - leg2[0][1]
        console.log(`drag to bottom-right: dx=${dx} dy=${dy} (${leg2.length} updates)`)
        if (dx < 400)
          failures.push(`return drag moved too little horizontally (dx=${dx})`)
        if (dy < 200)
          failures.push(`return drag moved too little vertically (dy=${dy})`)
      }
      else {
        failures.push('window did not move on the return drag')
      }
    }
  }

  socket.close()
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
console.log('\nOK: drag works across the screen in both directions')
