import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 发布清单守卫 —— issue #1 的回归护栏。
 *
 * v0.2.0 的 `postinstall` 调用了只写在 devDependencies 里的 `skills-npm`：脚本随包发到
 * 用户机器上执行，`skills-npm` 却不会被安装，于是 `pnpm add dsh-pet-lite` 直接以
 * "'skills-npm' is not recognized as an internal or external command" 失败。
 *
 * 本包是**库**，没有任何安装期任务要做（构建走 `prepack`，在发包机本地执行）。因此清单
 * 层面禁止任何 install 生命周期脚本回来，也禁止脚本再调用 skills 工具链。
 */
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as {
  scripts?: Record<string, string>
  files?: string[]
}

/** npm 在「安装这个包」时会尝试执行的脚本。`prepare` 只对 git 依赖生效，不在此列。 */
const INSTALL_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall']

describe('package manifest', () => {
  it('declares no install lifecycle scripts', () => {
    const declared = Object.keys(manifest.scripts ?? {})
      .filter(name => INSTALL_LIFECYCLE_SCRIPTS.includes(name))
    expect(declared).toEqual([])
  })

  it('never shells out to the skills toolchain', () => {
    const offenders = Object.entries(manifest.scripts ?? {})
      .filter(([, command]) => /\bskills\b/u.test(command))
      .map(([name]) => name)
    expect(offenders).toEqual([])
  })

  /** 桌宠窗口由 `dist` 之外的 runtime 目录提供，漏发就是「装上但开不出窗口」。 */
  it('ships the Electron helper runtime', () => {
    expect(manifest.files).toContain('runtime/electron-helper')
  })
})
