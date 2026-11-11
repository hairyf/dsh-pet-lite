import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import extract from '@electron-internal/extract-zip'
import { downloadArtifact } from '@electron/get'

/**
 * host/electron-runtime.ts — Electron 可执行文件解析与桌宠进程守护。
 *
 * 解析优先级**完全照搬 dsh-pet**（`source/dsh-pet/dsh-pet/src/host/helper-process.ts`）：
 *
 *   1. 显式候选（调用方传入）/ `DSH_PET_ELECTRON_PATH` 环境变量
 *   2. 本机已安装的 electron npm 包（`require('electron')` 返回二进制路径）
 *   3. `$DSH_HOME/electron`（`ensureElectronDownload` 的落地路径）
 *
 * 在其之上**前缀一条宿主注入**（在 dsh-pet 之后新增，不替换其它候选）：
 *
 *   0. `DSH_ELECTRON_PATH` — 宿主显式声明的 Electron 可执行文件；
 *      以及 `DSH_NODE` —— dsh-tauri 桌面端把「随包 Electron」的绝对路径放在这里
 *      （`service/workflow/launch.rs` 注入，见 `source/deepseek-harness-desktop`）。
 *
 * 【为什么宿主注入排最前却仍保留 dsh-pet 的全部兜底】宿主注入只是「我们确定这个能用」，
 * 它一旦失效（用户删了 AppData、切换了核心版本），dsh-pet 那三级候选仍然能救回来；
 * 反过来若只认 dsh-pet 的候选，桌面端用户就得多下一个几百 MB 的 Electron —— 而机器上
 * 明明已经有一个。两条路都不放弃，才是既能复用宿主又能独立运行。
 */

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

/** 包根：`dist/` 的上一级。 */
export const packageRoot = resolve(here, '..')

/** 桌宠 Electron 主进程入口（`runtime/electron-helper/main.js`）。 */
export const defaultHelperMain = resolve(packageRoot, 'runtime', 'electron-helper', 'main.cjs')

/** 当前平台标识（win32 / darwin / linux）。 */
const PLAT = process.platform

/** 落地目录下可执行文件的相对路径（按平台）。 */
export const ELECTRON_REL
  = PLAT === 'win32'
    ? 'electron.exe'
    : PLAT === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron'

/** `$DSH_HOME`（默认 `~/.dsh`），与 `ensure-electron.mjs` 的 HOME 计算一致。 */
export function dshHomeDir(): string {
  const userProfile = process.env.USERPROFILE || process.env.HOME || ''
  return process.env.DSH_HOME || join(userProfile, '.dsh')
}

/** Electron 运行时落地目录（`$DSH_HOME/electron`）—— 下载解压的目标，唯一定义处。 */
export function electronLandingDir(): string {
  return join(dshHomeDir(), 'electron')
}

/** Electron 落地路径：`$DSH_HOME/electron/<按平台的可执行文件>`。 */
export function defaultElectronExe(): string {
  return join(electronLandingDir(), ELECTRON_REL)
}

/**
 * 当前进程是否正是「以 Node 模式运行的宿主 Electron」。
 *
 * dsh-tauri 把随包 Electron 同时用作 UI 与 dsh 内核：内核进程就是那个二进制，环境里带
 * `ELECTRON_RUN_AS_NODE=1`、`DSH_NODE` 也指向它自己。此时 `DSH_NODE === process.execPath`
 * 是**正常的宿主注入**，不是自举。
 */
function runningAsNodeModeHost(): boolean {
  return process.env.ELECTRON_RUN_AS_NODE === '1'
}

/**
 * 宿主这份 Electron 是不是「打包过的应用」。
 *
 * 打包后的 Electron 把应用整体塞进 `resources/app.asar`，命令行上再给脚本也不会被当成
 * 入口 —— 它只会启动那个应用。复用这种二进制等于多开一个宿主窗口，桌宠依旧不出现，
 * 所以必须退回自下载的通用 Electron。
 */
function packagedElectronHost(): boolean {
  // `resourcesPath` 只有 Electron 运行时才注入，@types/node 的 Process 上没有它。
  const resources = (process as { resourcesPath?: string }).resourcesPath
  return typeof resources === 'string' && resources !== '' && existsSync(join(resources, 'app.asar'))
}

/**
 * 宿主注入的 Electron 路径候选。
 *
 * `DSH_ELECTRON_PATH` 是本插件自己的显式约定；`DSH_NODE` 是 dsh-tauri 桌面端已有的注入
 * （它指向「随包 Electron」，桌面端用它以 `ELECTRON_RUN_AS_NODE=1` 跑 dsh 内核）。
 *
 * 【为什么排除「正在运行的自己」】若桌宠 helper 自己再拉起 helper，会把同一个二进制当成
 * 「可复用的宿主 Electron」递归使用 —— 它缺少 Node 模式的 wrapper，行为不可预期。
 * 但判据不能只看路径相等：dsh-tauri 下当前进程本来就是宿主 Electron（Node 模式），
 * 路径相等恰恰证明「机器上已经有一个能用的 Electron」，排除它只会让桌面端白白再下几百 MB。
 * 自举场景由 `ELECTRON_RUN_AS_NODE` 区分（helper 子进程的环境已由 `helperChildEnv` 摘掉它），
 * 打包应用再按 `resources/app.asar` 排除，因此这里的放宽不会让 helper 复用自己、
 * 也不会把「官方桌面端的壳」当成通用 Electron 拉起来。
 */
export function hostInjectedCandidates(): string[] {
  const list: string[] = []
  // 路径等于 `process.execPath` 只有在这两件事都成立时才是安全信号：当前进程是 Node 模式的
  // 宿主内核，且那个二进制是通用 Electron（不是打包应用）。否则它可能是 helper 自己。
  const reuseSelfPath = runningAsNodeModeHost() && !packagedElectronHost()
  const push = (value: string | undefined): void => {
    const trimmed = value?.trim()
    if (!trimmed || !existsSync(trimmed))
      return
    if (!reuseSelfPath && resolve(trimmed) === resolve(process.execPath))
      return
    list.push(trimmed)
  }
  push(process.env.DSH_ELECTRON_PATH)
  push(process.env.DSH_NODE)
  return list
}

/**
 * 解析 Electron 可执行文件。
 *
 * @param candidates - 调用方显式候选（最高优先，排在最前）。
 * @returns 第一个存在的可执行文件路径；都不存在时 undefined。
 */
export function resolveElectronPath(candidates: Array<string | undefined> = []): string | undefined {
  const seen = new Set<string>()
  const list: string[] = []
  const push = (value: string | undefined | null): void => {
    if (!value || seen.has(value))
      return
    seen.add(value)
    list.push(value)
  }
  // 1. 显式候选 / DSH_PET_ELECTRON_PATH
  for (const value of candidates)
    push(value)
  if (process.env.DSH_PET_ELECTRON_PATH)
    push(process.env.DSH_PET_ELECTRON_PATH)
  // 0. 宿主注入（本插件新增的一条，排在 dsh-pet 兜底候选之前）。
  for (const value of hostInjectedCandidates())
    push(value)
  // 2. 本机 electron npm 包
  try {
    const resolved = require('electron')
    if (typeof resolved === 'string' && resolved)
      push(resolved)
  }
  catch {
    /* electron 未安装时跳过 */
  }
  // 3. 自己的落地路径（不探测 npm 全局目录 / Program Files / /usr/bin 等别处）
  push(defaultElectronExe())
  return list.find(value => existsSync(value))
}

/**
 * 判断当前环境能否真的跑起 Electron 图形窗口。
 *
 * Linux 无显示环境（服务器 / 容器 / 纯 CLI）下 Electron 能下载并 spawn，但初始化图形栈
 * 时立刻崩溃；配合守护循环会变成「拉起 → 崩溃 → 重启」，几小时堆出几十 GB core dump。
 * 因此必须在拉起之前判断。
 */
export function hasGraphicalDisplay(): boolean {
  if (process.platform !== 'linux')
    return true
  if (process.env.DSH_PET_DESKTOP_FORCE === '1')
    return true
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

export interface EnsureElectronOptions {
  /** Electron 版本号（默认 43.3.0，可被 `DSH_PET_ELECTRON_VERSION` 覆盖）。 */
  version?: string
  /** 下载镜像（默认 npmmirror，可被 `DSH_PET_ELECTRON_MIRROR` 覆盖）。 */
  mirror?: string
  /** 单次下载超时（默认 10 分钟）。 */
  timeoutMs?: number
}

/**
 * 进程内下载并解压 Electron 到 `$DSH_HOME/electron`。
 *
 * 不 spawn 子进程：在 CLI node 与 Electron 宿主里都可用。已存在则原样返回；
 * 失败返回 undefined（不影响 DSH 与浏览器内浮层）。
 */
export async function ensureElectronDownload(options: EnsureElectronOptions = {}): Promise<string | undefined> {
  const version = options.version || process.env.DSH_PET_ELECTRON_VERSION || '43.3.0'
  const mirror = options.mirror || process.env.DSH_PET_ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
  const targetDir = electronLandingDir()
  const exe = defaultElectronExe()
  if (existsSync(exe))
    return exe

  const log = (message: string): void => {
    process.stdout.write(`[dsh-pet-lite] ${message}\n`)
  }
  const startedAt = Date.now()
  log(`Electron not found, downloading v${version} (${PLAT}-${process.arch}) ...`)
  mkdirSync(targetDir, { recursive: true })

  try {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error(`Electron download timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    timer.unref?.()
    try {
      const zipPath = await downloadArtifact({
        version: `v${version}`,
        artifactName: 'electron',
        mirrorOptions: { mirror: `${mirror.replace(/\/$/, '')}/` },
        downloadOptions: { signal: controller.signal, quiet: true },
      })
      log(`download complete (${((Date.now() - startedAt) / 1000).toFixed(1)}s), extracting to ${targetDir} ...`)
      await extract(zipPath, { dir: targetDir })
      if (!existsSync(exe))
        throw new Error(`Electron zip extracted, but ${ELECTRON_REL} not found`)
      log(`ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${exe}`)
      return exe
    }
    finally {
      clearTimeout(timer)
    }
  }
  catch (error) {
    console.warn(`[dsh-pet-lite] ensure failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** 拉起参数：`command = <electron> args = [main.js]`（与 dsh-pet 一致）。 */
export function defaultLaunch(options: { electronPath?: string, helperPath?: string } = {}): { command: string, args: string[] } {
  const electronPath = resolveElectronPath([options.electronPath])
  if (!electronPath)
    throw new Error('dsh-pet-lite: cannot resolve Electron executable. Set DSH_PET_ELECTRON_PATH or install electron.')
  return { command: electronPath, args: [options.helperPath || defaultHelperMain] }
}

/** 重启退避：750ms 起 2× 封顶 30s。 */
export function restartBackoffDelayMs(consecutiveFailures: number, baseMs = 750): number {
  return Math.min(baseMs * 2 ** Math.max(0, consecutiveFailures), 30_000)
}

/** 熔断：连续崩溃 12 次后停止重启。 */
export function shouldCircuitBreak(consecutiveFailures: number, limit = 12): boolean {
  return consecutiveFailures >= limit
}

/** 稳定运行 3 分钟后清零崩溃计数。 */
export const HELPER_STABLE_MS = 3 * 60 * 1000

export function helperRunIsStable(elapsedMs: number): boolean {
  return elapsedMs >= HELPER_STABLE_MS
}

export interface HelperOptions {
  electronPath?: string
  helperPath?: string
  cwd?: string
  env?: Record<string, string | undefined>
  /** 行缓冲 stdout 里的日志出口（协议行不经过它）。 */
  onLog?: (line: string) => void
}

export interface HelperLogger {
  debug?: (message: string) => void
  error?: (message: string) => void
  info?: (message: string) => void
  warn?: (message: string) => void
}

/**
 * 桌宠子进程的环境。
 *
 * 【必须摘掉 `ELECTRON_RUN_AS_NODE`】dsh-tauri 桌面端把 `DSH_NODE` 指向随包 Electron 时，
 * **同时**注入了 `ELECTRON_RUN_AS_NODE=1`（它要用那个二进制跑 dsh 内核）。这个变量会沿
 * `process.env` 继承到我们拉起的窗口 —— 于是 Electron 不进 Chromium、而是以 Node 模式
 * 执行 `main.js`：`require('electron')` 返回路径字符串，`app` 是 `undefined`，进程立刻
 * 崩掉并进入重启循环。桌宠窗口要的是 GUI，所以在这里显式删除。
 *
 * 同时把 `DSH_PET_LITE_*` 之外的调用方注入原样并上，保持其它行为不变。
 */
export function helperChildEnv(extra: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return { ...env, ...extra }
}

/**
 * Electron 桌宠进程守护。
 *
 * 与 dsh-pet 的差异：本插件的桌宠窗口**不走** bridge 管道（不注册自定义 scheme、
 * 不用 stdin/stdout JSON 协议、不需要本地 HTTP 回调）—— 窗口直接 `fetch` 宿主 HTTP 路由。
 * 该管道在 dsh-pet 里存在只因为上游宿主网关会拦插件自拉进程的裸 HTTP；本插件的路由
 * 走同一 webServer 且不需要鉴权头，因此直接 HTTP 更简单、也少一层可失败组件。
 * 保留的是守护逻辑本身：异常退出自动重启 + 指数退避 + 熔断。
 */
export class HelperProcess {
  readonly options: HelperOptions
  readonly logger: HelperLogger
  private child?: ReturnType<typeof spawn>
  private stopping = false
  private restartTimer?: NodeJS.Timeout
  private restartFailures = 0
  private lastStartAt = 0

  constructor(options: HelperOptions = {}, logger: HelperLogger = console) {
    this.options = options
    this.logger = logger
  }

  get running(): boolean {
    return this.child !== undefined
  }

  start(): void {
    if (this.child || this.stopping)
      return
    this.lastStartAt = Date.now()
    const launch = defaultLaunch(this.options)
    const child = spawn(launch.command, launch.args, {
      cwd: this.options.cwd || packageRoot,
      env: helperChildEnv(this.options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
    })
    this.child = child

    child.once('error', (error) => {
      this.logger.error?.(`dsh-pet-lite desktop helper failed to start: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child)
        return
      this.child = undefined
      if (this.stopping)
        return
      this.logger.warn?.(`dsh-pet-lite desktop helper exited (code=${String(code)}, signal=${String(signal)}); restarting`)
      this.scheduleRestart()
    })
    child.stdout?.on('data', chunk => this.onStdout(String(chunk)))
    child.stderr?.on('data', (chunk) => {
      const line = String(chunk).trim()
      if (line)
        this.logger.warn?.(`[dsh-pet-lite desktop helper] ${line}`)
    })
    this.logger.info?.(`dsh-pet-lite desktop helper started (${launch.command})`)
  }

  /** stdout 按行缓冲：逐行交给日志出口（没有协议行要分流）。 */
  private onStdout(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const nl = this.buffer.indexOf('\n')
      if (nl < 0)
        break
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line)
        continue
      if (this.options.onLog)
        this.options.onLog(line)
      else
        this.logger.debug?.(`[dsh-pet-lite desktop helper] ${line}`)
    }
  }

  private buffer = ''

  stop(reason = 'plugin-disposed'): void {
    this.stopping = true
    if (this.restartTimer)
      clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    this.logger.debug?.(`dsh-pet-lite desktop helper stopping (${reason})`)
    const child = this.child
    this.child = undefined
    this.buffer = ''
    if (!child)
      return
    try {
      child.kill()
    }
    catch {
      /* 进程已退出 */
    }
  }

  /** 允许再次 start（stop 之后复用同一实例）。 */
  reset(): void {
    this.stopping = false
    this.restartFailures = 0
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping)
      return
    if (helperRunIsStable(Date.now() - this.lastStartAt))
      this.restartFailures = 0
    else
      this.restartFailures += 1
    if (shouldCircuitBreak(this.restartFailures)) {
      this.logger.error?.(
        `dsh-pet-lite desktop helper crashed ${this.restartFailures} consecutive times; circuit breaker tripped`,
      )
      return
    }
    const delay = restartBackoffDelayMs(this.restartFailures - 1)
    this.logger.warn?.(`dsh-pet-lite desktop helper restarting in ${Math.round(delay)}ms (attempt ${this.restartFailures})`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.start()
    }, delay)
    this.restartTimer.unref?.()
  }
}
