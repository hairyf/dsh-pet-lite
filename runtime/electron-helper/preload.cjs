/**
 * dsh-pet-lite desktop helper —— preload（contextBridge 暴露面）。
 *
 * 全部走单向 `ipcRenderer.send`：渲染端不需要应答，也不需要读主进程状态。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petBridge', {
  /** 逐帧跟随：窗口内容矩形（屏幕坐标，DIP）。 */
  setBounds(x, y, width, height) {
    ipcRenderer.send('pet:set-bounds', { x, y, width, height })
  },
  /**
   * 拖拽期的窗口落位（屏幕坐标，DIP）。
   *
   * 与 `setBounds` 分开是因为语义不同：拖拽时指针经常在窗口外，主进程不再做命中判定，
   * 只按收到的绝对坐标落窗 —— 这是「能把宠物拖出窗口那一小片」的关键路径。
   */
  moveTo(x, y) {
    ipcRenderer.send('pet:move-to', { x, y })
  },
  /**
   * 拖拽/飞行开始与结束。
   *
   * 期间主进程必须保持窗口可交互 —— 否则指针一出窗口就翻回穿透，`pointermove` /
   * `pointerup` 全部断流，宠物会卡住不动、松手也停不下来。
   */
  setDragging(dragging) {
    ipcRenderer.send('pet:set-dragging', !!dragging)
  },
  /** 指针进/出宠物身体命中区。 */
  setInteractive(interactive) {
    ipcRenderer.send('pet:set-interactive', !!interactive)
  },
  /** 在系统浏览器打开外链。 */
  openExternal(url) {
    ipcRenderer.send('pet:open-external', String(url))
  },
  /** 弹出桌宠右键菜单（显示主界面 / 关闭宠物）。 */
  showMenu(payload) {
    ipcRenderer.send('pet:show-menu', payload ?? {})
  },
  /** 订阅菜单点击（主进程 → 渲染端）。返回取消订阅函数。 */
  onMenuAction(handler) {
    const listener = (_event, action) => handler(String(action))
    ipcRenderer.on('pet:menu-action', listener)
    return () => ipcRenderer.removeListener('pet:menu-action', listener)
  },
})
