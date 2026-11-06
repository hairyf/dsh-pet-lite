import type { Page } from 'playwright'
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

export const launchDsh: BrowserCommand<[], { baseUrl: string }> = async (context) => {
  if (context.provider.name !== 'playwright')
    throw new Error('DSH browser tests require the Playwright browser provider')

  const existing = sessions.get(context.sessionId)
  if (existing)
    return { baseUrl: existing.scaffold.baseUrl }

  const scaffold = await launchShell()
  sessions.set(context.sessionId, { scaffold, errors: () => [] })

  const exchange = await exchangeProcessLaunchToken(scaffold.baseUrl, scaffold.processLaunchUrl)
  if (exchange)
    await context.context.addCookies([exchange.cookie])

  return { baseUrl: scaffold.baseUrl }
}

export const openDshPage: BrowserCommand<[], { url: string }> = async (context) => {
  const session = sessions.get(context.sessionId)
  if (!session)
    throw new Error('DSH shell must be launched before opening the page')

  const page = await context.context.newPage()
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
