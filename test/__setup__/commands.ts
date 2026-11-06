import type { BrowserContext, Page } from 'playwright'
import type { BrowserCommand } from 'vitest/node'
import type { ShellScaffold } from './shell'
import { launchShell, logs } from './shell'
import { exchangeProcessLaunchToken } from './shell.utils'

interface BrowserDshSession {
  scaffold: ShellScaffold
  page?: Page
  errors: () => string[]
}

const sessions = new Map<string, BrowserDshSession>()

/**
 * Playwright provider 的读取面（与 `PlaywrightBrowserProvider` 同形）。
 *
 * `BrowserCommandContext` 自身不带 Playwright 的 `BrowserContext`，provider 才是持有者：
 * 它按 sessionId 维护 `contexts` / `pages` 两张表。这里按同一把 key 取用。
 */
interface PlaywrightProviderLike {
  contexts?: Map<string, BrowserContext>
  pages?: Map<string, Page>
}

function providerOf(context: { provider: unknown }): PlaywrightProviderLike {
  return context.provider as PlaywrightProviderLike
}

export const launchDsh: BrowserCommand<[], { baseUrl: string }> = async (context) => {
  if (context.provider.name !== 'playwright')
    throw new Error('DSH browser tests require the Playwright browser provider')

  const existing = sessions.get(context.sessionId)
  if (existing)
    return { baseUrl: existing.scaffold.baseUrl }

  const scaffold = await launchShell()
  sessions.set(context.sessionId, { scaffold, errors: () => [] })

  const exchange = await exchangeProcessLaunchToken(scaffold.baseUrl, scaffold.processLaunchUrl)
  if (exchange) {
    const browserContext = providerOf(context).contexts?.get(context.sessionId)
    if (browserContext)
      await browserContext.addCookies([exchange.cookie])
  }

  return { baseUrl: scaffold.baseUrl }
}

export const openDshPage: BrowserCommand<[], { url: string }> = async (context) => {
  const session = sessions.get(context.sessionId)
  if (!session)
    throw new Error('DSH shell must be launched before opening the page')

  const browserContext = providerOf(context).contexts?.get(context.sessionId)
  if (!browserContext)
    throw new Error('no Playwright browser context is attached to this session')

  const page = await browserContext.newPage()
  const consoleTripwire = logs(page)

  await page.goto(session.scaffold.baseUrl, { waitUntil: 'load' })
  session.page = page
  session.errors = consoleTripwire.errors
  return { url: page.url() }
}

export const getDshErrors: BrowserCommand<[], string[]> = async (context) => {
  const session = sessions.get(context.sessionId)
  if (!session?.page)
    return []
  return session.errors()
}

export const closeDsh: BrowserCommand<[], void> = async (context) => {
  const session = sessions.get(context.sessionId)
  if (!session)
    return

  sessions.delete(context.sessionId)
  await session.page?.close()
  await session.scaffold.close()
}
