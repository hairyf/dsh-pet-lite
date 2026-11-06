import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commands } from 'vitest/browser'

declare module 'vitest/browser' {
  interface BrowserCommands {
    launchDsh: () => Promise<{ baseUrl: string }>
    openDshPage: () => Promise<{ url: string }>
    getDshErrors: () => Promise<string[]>
    closeDsh: () => Promise<void>
  }
}

describe('dSH shell browser mode smoke test', () => {
  let openedUrl = ''

  beforeAll(async () => {
    await commands.launchDsh()
    openedUrl = (await commands.openDshPage()).url
  })

  afterAll(async () => {
    await commands.closeDsh()
  })

  it('opens the authenticated DSH shell in Chromium', async () => {
    const url = new URL(openedUrl)
    expect(url.protocol).toMatch(/^https?:$/u)
    expect(url.pathname).toBe('/')
    expect(await commands.getDshErrors()).toEqual([])
  })
})
