/**
 * dsh-pet-lite desktop helper —— Electron 主进程。
 *
 * 复刻 apps/desktop 的桌宠窗口语义（`src-tauri/src/desktop/pet.rs` 创建的 webview 窗口）：
 *
 *   - 透明、无边框、置顶（`screen-saver` 层）、不进任务栏、不可缩放、无阴影；
 *   - **整窗点击穿透**（`setIgnoreMouseEvents(true, { forward: true })`），渲染端在指针
 *     进入宠物身体命中区时经 IPC 翻转 —— 透明像素不挡下层应用；
 *   - 窗口 = 宠物包围盒 + 四周留白（气泡/菜单要地方），宠物移动时窗口逐帧跟随；
 *   - `autoplay-policy` 放开，让静音视频无需用户手势即可播放。
 *
 * 与上游的差异（本插件更简）：
 *   - 不用 stdin/stdout bridge 协议：窗口直接 fetch 宿主 HTTP 路由；
 *   - 不做多显示器 DPI 线性化、不做跨窗口碰撞、不做抛掷物理（都在渲染端或不做）；
 *   - 单窗口（上游是多宠物多窗口）。
 */

const path = require('node:path')
const process = require('node:process')
const { app, BrowserWindow, ipcMain, screen } = require('electron')

// 允许无用户手势直接播放（桌宠动画一加载就要动）。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// 显式定名：helper 是被 `electron <main.js>` 直接拉起的，Electron 取不到 app 名会回落成
// "Electron"，userData 便落到所有这么跑的 Electron 脚本的公共目录。必须在任何
// getPath('userData') 之前设置。
app.setName('dsh-pet-lite-helper')

// Windows 透明分层窗口（WS_EX_LAYERED）在 DWM 硬件合成下会出现拖动黑边与内容丢失；
// 桌宠只渲染轻量动画，改走软件合成。非 Windows 保留硬件加速。
if (process.platform === 'win32')
  app.disableHardwareAcceleration()

/** 宠物渲染宽度（px，100% 档位）与窗口四周留白。 */
const PET_BASE_WIDTH = 200
const WINDOW_MARGIN = 48

/** 宿主 origin 与配置地址（由插件 host 半侧注入）。 */
const ORIGIN = process.env.DSH_PET_LITE_ORIGIN || ''
const CATALOG_URL = process.env.DSH_PET_LITE_CONFIG_URL || ''

/** 窗口是否处于「忽略鼠标」态（Electron 没有读取 API，自己镜像）。 */
let ignoring = true

/**
 * 唯一设置点击穿透的入口。
 *
 * `forward: true` 让窗口在被忽略时仍收到 mousemove —— 渲染端正是靠它判定「指针进了
 * 宠物身体」。没有这个参数，整窗一旦穿透就再也没法翻转回来。
 */
function setWindowIgnore(target, value) {
  if (target.isDestroyed())
    return
  if (ignoring === value)
    return
  ignoring = value
  target.setIgnoreMouseEvents(value, { forward: true })
}

/** 窗口尺寸：宠物本体 + 四周留白（按 size 百分比缩放）。 */
function windowSize(sizePercent) {
  const width = Math.round((PET_BASE_WIDTH * sizePercent) / 100)
  const height = Math.round((width * 9) / 16)
  return {
    width: width + WINDOW_MARGIN * 2,
    height: height + WINDOW_MARGIN * 2,
  }
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const { width, height } = windowSize(100)

  const created = new BrowserWindow({
    width,
    height,
    // 初始落在主屏右下角（与上游默认 corner=bottom-right 一致）。
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + workArea.height - height - 24,
    show: false,
    useContentSize: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // 需要可聚焦：右键菜单与气泡里的交互要用。
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  created.setAlwaysOnTop(true, 'screen-saver')
  created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 被其他窗口完全遮挡时不要让渲染停下来（否则宠物「消失」）。
  created.webContents.setBackgroundThrottling(false)
  // 屏蔽 Electron 默认右键菜单：菜单由渲染端自绘（与主界面一致）。
  created.webContents.on('context-menu', event => event.preventDefault())

  // 整窗点击穿透，从创建那一刻就生效。
  ignoring = false
  setWindowIgnore(created, true)

  // 可靠显示：只用 ready-to-show 在部分平台可能永远不触发，因此再补一条 did-finish-load
  // 兜底（上游 issue #55 的同类修复）。
  created.once('ready-to-show', () => created.show())
  created.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!created.isDestroyed() && !created.isVisible())
        created.show()
    }, 400)
  })

  loaded(created)
}

/** 加载渲染端页面（本地文件 + 宿主地址作为查询参数）。 */
function loaded(target) {
  const query = new URLSearchParams({
    origin: ORIGIN,
    catalog: CATALOG_URL,
  })
  target.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: Object.fromEntries(query),
  })
}

// --- IPC ---------------------------------------------------------------

/**
 * 渲染端逐帧上报窗口位置与尺寸（宠物移动 = 窗口移动）。
 *
 * 去重按「我们自己最后一次请求的矩形」而不是 `getContentBounds()`：后者的往返取整会让
 * 去重永远不命中，把每一帧都变成强制重定位。
 */
const lastRequested = new Map()

ipcMain.on('pet:set-bounds', (event, bounds) => {
  const target = BrowserWindow.fromWebContents(event.sender)
  if (!target || target.isDestroyed())
    return
  const x = Number(bounds?.x)
  const y = Number(bounds?.y)
  const width = Number(bounds?.width)
  const height = Number(bounds?.height)
  if (![x, y, width, height].every(Number.isFinite))
    return
  const rect = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  }
  if (rect.width < 8 || rect.height < 8)
    return
  const key = `${rect.x},${rect.y},${rect.width},${rect.height}`
  if (lastRequested.get(target.id) === key)
    return
  lastRequested.set(target.id, key)
  target.setContentBounds(rect, false)
})

/** 渲染端在指针进/出宠物命中区时翻转可交互性。 */
ipcMain.on('pet:set-interactive', (event, interactive) => {
  const target = BrowserWindow.fromWebContents(event.sender)
  if (!target || target.isDestroyed())
    return
  setWindowIgnore(target, !interactive)
})

/** 渲染端请求调整窗口大小（设置页改变 size 时）。 */
ipcMain.on('pet:set-size', (event, sizePercent) => {
  const target = BrowserWindow.fromWebContents(event.sender)
  if (!target || target.isDestroyed())
    return
  const value = Number(sizePercent)
  if (!Number.isFinite(value))
    return
  const { width, height } = windowSize(value)
  const current = target.getContentBounds()
  lastRequested.delete(target.id)
  target.setContentSize(width, height, false)
  // 尺寸变化后把窗口重新贴回右下角可视区，避免撑出屏幕。
  const display = screen.getDisplayNearestPoint({ x: current.x, y: current.y })
  const workArea = display.workArea
  const x = Math.min(current.x, workArea.x + workArea.width - width)
  const y = Math.min(current.y, workArea.y + workArea.height - height)
  target.setPosition(Math.max(workArea.x, x), Math.max(workArea.y, y), false)
})

/** 渲染端请求在系统浏览器打开外链（社区页等）。 */
ipcMain.on('pet:open-external', (_event, url) => {
  const value = String(url ?? '')
  if (!/^https?:\/\//u.test(value))
    return
  require('node:child_process').spawn(
    process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open',
    process.platform === 'win32' ? ['url.dll,FileProtocolHandler', value] : [value],
    { detached: true, stdio: 'ignore', windowsHide: true },
  ).unref()
})

// --- app lifecycle -----------------------------------------------------

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0)
      createWindow()
  })
})

// 桌宠窗口关了就是用户不要了：helper 退出，宿主重启目录里不再有孤儿进程。
app.on('window-all-closed', () => app.quit())
