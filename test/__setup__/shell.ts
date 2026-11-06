import type { Page } from 'playwright'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { x } from 'tinyexec'
import { dshCommand, exchangeProcessLaunchToken, freePort, stop, trustedProcessLaunchUrl } from './shell.utils'

export const HAS_DSH = dshCommand()

export interface ShellScaffold {
  baseUrl: string
  processLaunchUrl: string
  home: string
  api: (path: string, init?: RequestInit) => Promise<Response>
  close: () => Promise<void>
}

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export async function openShellPage(page: Page, scaffold: Pick<ShellScaffold, 'baseUrl' | 'processLaunchUrl'>): Promise<void> {
  const exchange = await exchangeProcessLaunchToken(scaffold.baseUrl, scaffold.processLaunchUrl)
  if (exchange) {
    await page.context().addCookies([exchange.cookie])
  }
  await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
}

export function logs(page: Page): { errors: () => string[] } {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const location = msg.location().url
      if (!msg.text().includes('401') && !msg.text().includes('Unauthorized'))
        errors.push(location ? `${msg.text()} (${location})` : msg.text())
    }
  })
  page.on('response', (response) => {
    if (response.status() >= 400 && response.status() !== 401)
      errors.push(`${response.status()} ${response.url()}`)
  })
  page.on('pageerror', err => errors.push(String(err)))
  return { errors: () => [...errors] }
}

export async function launchShell(): Promise<ShellScaffold> {
  const command = dshCommand()
  if (!command)
    throw new Error('no dsh available — set DSH_E2E_DSH or put dsh on PATH')

  const home = mkdtempSync(join(tmpdir(), 'dsh-e2e-home-'))
  const env = { ...process.env, DSH_HOME: home, CI: 'true' }
  await x('pnpm', ['run', 'build'], {
    timeout: 300_000,
    throwOnError: true,
    nodeOptions: { cwd: REPO_ROOT, env, stdio: 'inherit' },
  })
  await x('pnpm', ['pack', '--pack-destination', home], {
    timeout: 300_000,
    throwOnError: true,
    nodeOptions: { cwd: REPO_ROOT, env, stdio: 'inherit' },
  })
  const tarball = join(home, readdirSync(home).find(name => name.endsWith('.tgz'))!)
  await x(command, ['plugin', '--profile', 'web', 'add', '--ignore-scripts', tarball], {
    timeout: 300_000,
    throwOnError: true,
    nodeOptions: { cwd: REPO_ROOT, env, stdio: 'inherit' },
  })

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const cwd = process.env.DSH_E2E_DSH_CWD ?? REPO_ROOT
  const processResult = x(command, ['--profile', 'web', '--port', String(port), '--no-open'], {
    nodeOptions: {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
    persist: true,
  })
  const child = processResult.process
  if (!child)
    throw new Error('failed to start dsh web process')

  let processLaunchUrl = ''
  let startupOutput = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk: Uint8Array) => {
      startupOutput = (startupOutput + chunk.toString()).slice(-8192)
      for (const line of startupOutput.split(/\r?\n/u)) {
        const match = /^dsh web:\s+(https?:\/\/\S+)\s*$/u.exec(line)
        if (match && trustedProcessLaunchUrl(baseUrl, match[1]!) !== null) {
          processLaunchUrl = match[1]!
        }
      }
    })
  }

  const deadline = Date.now() + 120_000
  let statusReady = false
  for (; ;) {
    if (statusReady) {
      if (!processLaunchUrl)
        processLaunchUrl = baseUrl
      break
    }
    if (child.exitCode !== null)
      throw new Error(`dsh exited ${child.exitCode}:\n${startupOutput.slice(-2000)}`)
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(2000) })
      statusReady = response.ok || response.status === 401
    }
    catch {
      statusReady = false
    }
    if (Date.now() > deadline)
      throw new Error(`dsh boot timeout (status=${statusReady}, startup URL=${!processLaunchUrl ? 'missing' : 'ready'})`)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  const session = await exchangeProcessLaunchToken(baseUrl, processLaunchUrl)
  const cookieHeader = session ? `${session.cookie.name}=${session.cookie.value}` : undefined
  let closed = false

  return {
    baseUrl,
    processLaunchUrl,
    home,
    api: async (path: string, init: RequestInit = {}) => fetch(
      new URL(path, baseUrl).href,
      {
        ...init,
        headers: {
          ...init.headers,
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
        signal: init.signal ?? AbortSignal.timeout(30_000),
      },
    ),
    close: async () => {
      if (closed)
        return
      closed = true
      await stop(child)
      rmSync(home, { recursive: true, force: true })
    },
  }
}
