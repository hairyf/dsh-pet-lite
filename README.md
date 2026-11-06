<p align='center'>
  <img src='public/hero.png' alt='dsh-pet-lite' />
</p>

<h1 align='center'>dsh-pet-lite</h1>

<p align='center'>
轻量桌宠插件：把 Tauri 桌面端的 pet 功能抽离成独立插件 —— 设置页分区、会话活动驱动的动画、
以及一个透明置顶的 Electron 桌宠窗口。
<br>
<br>
<a href="https://github.com/hairyf/dsh-pet-lite"><strong>Repository</strong></a>
</p>

[![License][license-src]][license-href]

## 这是什么

从 [`deepseek-harness-desktop`](https://github.com/dsh-tauri-desk/deepseek-harness-desktop)
的 `packages/builtin-plugin-pet` 抽离出来的独立插件。**功能与交互逐条复刻 Tauri 桌面端**，
只把宿主边界换掉（见下方「与 Tauri 桌面端的差异」）。

- **设置页分区** —— `settings.section` 里的桌宠页：预设卡片、启用/取消选择、大小滑条、抛射开关。
- **会话活动动画** —— 订阅宿主 `session/event` 等总线事件，按六档工作状态
  （thinking / working / result / waiting / success / error）切换宠物动作。
- **透明置顶窗口** —— Electron 拉起的无边框透明窗口，整窗点击穿透，指针进宠物身体才可交互，
  拖动时窗口跟随指针。
- **渲染层复用同一组件** —— 窗口与 Tauri 桌面端使用**同一个** `dsh-pet-component`，
  因此动作池、点击反馈、气泡、镜像是同一套实现。

## 与 Tauri 桌面端的差异

抽离时必须替换的只有**宿主边界**，业务语义一行没改：

| 能力 | Tauri 桌面端 | dsh-pet-lite |
| --- | --- | --- |
| 前端调后端 | Tauri `invoke('get_pet_status')` | 同名命令 → `${ROUTE_PREFIX}/*` HTTP 路由 |
| 窗口 | Rust 创建 webview 窗口 | Electron `BrowserWindow`（同透明/置顶/穿透属性） |
| 会话状态 | 宿主 SSE → Rust `emit_to('pet')` | 直接消费宿主 SSE（`/session/stream`） |
| 指针流 / 屏幕坐标 | `device-mouse-move` 原生设备流 | DOM `pointermove`（`clientX/clientY` 即窗口内容坐标） |
| 状态容器 | valtio-define | 官方 `@deepseek-ai/dsh-client-store` |
| UI 组件 | dsh-tauri-ui | 官方 `@deepseek-ai/dsh-client-ui-primitives` |
| 设置持久化 | Rust `tauri-plugin-store` | `$DSH_HOME/pet-lite/pet.json`（原子写） |

### 未实现（设置页会明确报错，不假装成功）

远端仓库登记、zip 导入、更新检查、外链打开、强制 XWayland 开关 —— 这些在上游由 Rust 侧能力
承担。本插件的宿主没有对应后端，因此对应动作用 `PET_UNSUPPORTED_COMMAND` 明确失败而不是静默
返回成功。

## Electron 运行时从哪来

这是本插件与 `dsh-pet` 一致的地方。解析顺序（`src/host/electron-runtime.ts`）：

1. `DSH_ELECTRON_PATH` —— 本插件自己的显式约定；
2. `DSH_NODE` —— **宿主注入**：dsh-tauri 桌面端把「随包 Electron」的绝对路径放在这里
   （`service/workflow/launch.rs`），直接复用，不必再下一次；
3. 显式候选 / `DSH_PET_ELECTRON_PATH`；
4. 本机 `electron` npm 包（`require('electron')`）；
5. `$DSH_HOME/electron` —— 都没有时由 `@electron/get` 自动下载（默认 v43.3.0，npmmirror 镜像）。

第 1–2 条是本插件在 `dsh-pet` 三级候选之上**新增**的宿主注入；3–5 条与
`dsh-pet` 的 `resolveElectronPath` 逐字一致。选这个顺序是因为：宿主注入是「我们确定能用」的
最优解，但它一旦失效（用户删了 AppData、切了核心版本），`dsh-pet` 那几级候选仍能救回来。

纯浏览器访问 DSH 时没有 Electron，`desktop_supported` 为 `false`，设置页不会出现窗口开关。

## 安装

```bash
dsh plugin --profile web add dsh-pet-lite
```

或从源码装：

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm pack --pack-destination .tmp
DSH_HOME=$(mktemp -d) dsh plugin --profile web add ./.tmp/*.tgz
DSH_HOME="$DSH_HOME" dsh --profile web
```

## HTTP 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/dsh-pet-lite/settings` | 当前状态快照（选择 / 启用 / 大小 / 抛射 / 桌面可用性） |
| `PUT` | `/dsh-pet-lite/settings` | 更新上述字段，回吐**权威**状态并同步窗口开合 |
| `GET` | `/dsh-pet-lite/catalog` | 预设清单 + 状态（设置页一次拿齐） |
| `GET` | `/dsh-pet-lite/asset?id=` | 单个预设的渲染参数 |
| `GET` | `/dsh-pet-lite/config?id=` | 预设配置代理（`file://` 页面避免 CORS） |
| `GET` | `/dsh-pet-lite/session/stream` | 会话活动 SSE（`data:` 帧 + 心跳 + `state-lost`） |

SSE 帧格式与上游逐字对齐；`retry: 1000` 只随首帧发出。

## 目录

```
src/
  index.ts                  # host 半侧：路由注册 + 桌面窗口生命周期
  shared/                   # 三端共享常量与协议类型
  host/
    routes.ts               # 业务路由（原生 node:http）
    catalog.ts presets.json # 内置预设清单（与 desktop manifest 同源）
    store.ts                # 设置持久化（$DSH_HOME/pet-lite/pet.json）
    electron-runtime.ts     # Electron 解析 + 进程守护（照搬 dsh-pet 优先级）
    session-stream*.ts      # 会话总线 → 展示态投影（reducer 逐字复用）
  client/
    index.ts                # client 半侧装配
    sdk.ts ui.tsx           # 边界适配层（dsh-tauri / dsh-tauri-ui 的同形子集）
    components/ register/ service/ store/ locales/
  renderer/index.tsx        # Electron 桌宠窗口渲染端（用 dsh-pet-component）
runtime/electron-helper/    # Electron 主进程 + preload
source/                     # 参考子模块：dsh-pet、deepseek-harness-desktop
```

`src/client/sdk.ts` 与 `src/client/ui.tsx` 是**唯一**为「SDK 未发布」而写的适配层，
其余文件与上游 `builtin-plugin-pet` 同构。

## 脚本

| 脚本 | 作用 |
| --- | --- |
| `pnpm run build` | tsdown 打包 host / client / renderer，并复制 `presets.json` |
| `pnpm run lint` | ESLint（`--fix` 自动修） |
| `pnpm run typecheck` | `tsc --noEmit` |
| `pnpm run test` | 构建后跑 Vitest（unit + 浏览器 E2E） |

## 参考

- [`PC2005-cloud/dsh-pet`](https://github.com/PC2005-cloud/dsh-pet) —— Electron 路径解析与窗口语义来源
- [`dsh-tauri-desk/deepseek-harness-desktop`](https://github.com/dsh-tauri-desk/deepseek-harness-desktop) —— `builtin-plugin-pet` 原始实现
- [`dsh-pet-component`](https://github.com/dsh-tauri/dsh-pet-component) —— 渲染组件

两者以 git submodule 形式钉在 `source/` 下作为参考。

## License

[MIT](./LICENSE.md)

[license-src]: https://img.shields.io/github/license/hairyf/dsh-pet-lite.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/hairyf/dsh-pet-lite/blob/main/LICENSE.md
