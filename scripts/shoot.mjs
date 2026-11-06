#!/usr/bin/env node
/**
 * scripts/shoot.mjs — 对真实 DSH 实例截屏（设置页 + 桌宠浮层）。
 *
 * 用法：DSH_LAUNCH_URL=... node scripts/shoot.mjs <baseUrl> <outDir>
 *
 * 三个必踩的前置（都来自官方壳层的真实行为，不是本插件的）：
 *   1. 全新 DSH_HOME 首屏会弹**首次配置向导**（模态 + 遮罩），不关掉的话侧栏按钮点不到；
 *      用「稍后配置」跳过。
 *   2. 还有「预览版说明」弹窗；统一按 Escape / 跳过按钮处理。
 *   3. `settings.section` 只在**设置面板打开时**才被声明 —— 不打开设置，宠物分区永远
 *      不会挂载（`slots.inject` 的回调不会触发）。这是 vivo 验证过的关键事实。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const baseUrl = process.argv[2]
const outDir = process.argv[3] ?? '.tmp-shot'
if (!baseUrl) {
  console.error('usage: node scripts/shoot.mjs <baseUrl> [outDir]')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

/** 换启动 token → 会话 Cookie。 */
async function exchangeToken(launchUrl) {
  const url = new URL(launchUrl)
  if (!url.searchParams.get('token'))
    return null
  const response = await fetch(url.href, { redirect: 'manual' })
  const pair = (response.headers.get('set-cookie') ?? '').split(';')[0]
  const index = pair.indexOf('=')
  if (index <= 0)
    throw new Error(`token exchange returned no cookie (status ${response.status})`)
  return { name: pair.slice(0, index), value: pair.slice(index + 1) }
}

/** 反复关掉首屏向导 / 说明弹窗，直到没有模态遮罩。 */
async function dismissOnboarding(page) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const skip = page.getByRole('button', { name: /稍后配置|稍后|Skip|Later/ }).first()
    if (await skip.count() && await skip.isVisible().catch(() => false)) {
      await skip.click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(900)
      continue
    }
    const cont = page.getByRole('button', { name: /继续|Continue|知道了|Got it/ }).first()
    if (await cont.count() && await cont.isVisible().catch(() => false)) {
      await cont.click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(900)
      continue
    }
    const masks = await page.locator('div[aria-hidden="true"][class*="mask"]').count()
    if (masks === 0)
      return true
    await page.keyboard.press('Escape')
    await page.waitForTimeout(700)
  }
  return (await page.locator('div[aria-hidden="true"][class*="mask"]').count()) === 0
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

const token = await exchangeToken(process.env.DSH_LAUNCH_URL ?? baseUrl)
if (token) {
  await context.addCookies([{
    ...token,
    url: `${new URL(baseUrl).origin}/`,
    httpOnly: true,
    secure: false,
    sameSite: 'Strict',
    expires: Math.floor(Date.now() / 1000) + 3600,
  }])
  console.log('cookie seeded')
}

const page = await context.newPage()
const errors = []
page.on('console', msg => msg.type() === 'error' && errors.push(msg.text()))
page.on('pageerror', err => errors.push(String(err)))

await page.goto(baseUrl, { waitUntil: 'load' })
await page.waitForTimeout(6000)

const clean = await dismissOnboarding(page)
console.log('onboarding dismissed:', clean)

// 1) 主界面 + 桌宠浮层
await page.screenshot({ path: join(outDir, '01-app.png') })
console.log('shot 01-app')

const overlay = page.locator('[data-shell-overlay]').first()
if (await overlay.count()) {
  await overlay.screenshot({ path: join(outDir, '02-overlay.png') }).catch(() => {})
  console.log('shot 02-overlay')
}

// 2) 打开设置（此时才声明 settings.section）
await page.locator('button[aria-label="设置"], button[aria-label="Settings"]').first().click({ timeout: 15_000 })
await page.waitForTimeout(3000)

// 3) 进入「宠物」分区。
//
// 设置面板的左侧导航是**按钮列表**（不是 role=tab），分区文案来自各注册项的 `label`。
// 用文本定位，并限定在对话框内，避免命中侧栏同名元素。
const dialog = page.locator('[role="dialog"]').first()
const navItem = dialog.getByRole('button', { name: /^宠物$|^Pets$/ }).first()
if (await navItem.count()) {
  await navItem.click({ timeout: 15_000 })
}
else {
  // 兜底：按文本找（某些版本渲染成 span/li）
  await dialog.getByText(/^宠物$|^Pets$/).first().click({ timeout: 15_000 })
}
await page.waitForTimeout(4500)
await page.screenshot({ path: join(outDir, '03-pet-settings.png') })
console.log('shot 03-pet-settings')

const panel = page.locator('[data-pet-page="1"]').first()
if (await panel.count()) {
  await panel.screenshot({ path: join(outDir, '04-pet-settings-panel.png') })
  console.log('shot 04-pet-settings-panel')
}

const diag = await page.evaluate(() => ({
  hasPetPage: !!document.querySelector('[data-pet-page="1"]'),
  overlayChildren: document.querySelector('[data-slot="shell.overlay"]')?.childElementCount ?? -1,
  bodyHasPetText: /宠物/.test(document.body.textContent ?? ''),
}))
console.log('DIAG', JSON.stringify(diag))
console.log('ERRORS', errors.length ? JSON.stringify(errors.slice(0, 5)) : '(none)')

await browser.close()
