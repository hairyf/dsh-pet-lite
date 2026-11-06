/**
 * dsh-pet-lite desktop helper —— preload（contextBridge 暴露面）。
 *
 * 只暴露渲染端真正需要的四个动作：窗口跟随、可交互性翻转、尺寸调整、外链打开。
 * 全部走单向 `ipcRenderer.send`：渲染端不需要应答，也不需要读主进程状态。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petBridge', {
  /** 逐帧跟随：窗口内容矩形（屏幕坐标，物理像素）。 */
  setBounds(x, y, width, height) {
    ipcRenderer.send('pet:set-bounds', { x, y, width, height })
  },
  /** 指针进/出宠物身体命中区。 */
  setInteractive(interactive) {
    ipcRenderer.send('pet:set-interactive', !!interactive)
  },
  /** 调整窗口大小（size 百分比 50–200）。 */
  setSize(sizePercent) {
    ipcRenderer.send('pet:set-size', sizePercent)
  },
  /** 在系统浏览器打开外链。 */
  openExternal(url) {
    ipcRenderer.send('pet:open-external', String(url))
  },
})
