<p align='center'>
  <img src='public/hero.png' alt='dsh-pet-lite' />
</p>

<h1 align='center'>dsh-pet-lite</h1>

<p align='center'>
轻量桌宠插件：把 Tauri 桌面端的 pet 功能抽离成独立插件 —— 设置页分区、会话活动驱动的动画，
以及一个透明置顶的 Electron 桌宠窗口。**只做独立窗口，不做网页内宠物。**
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
- **拖动 / 甩抛手感逐字移植 dsh-pet** —— 屏幕坐标增量、5px 拖拽阈值、过阻尼弹簧跟随
  （K=200/C=30）、150ms 轨迹估算初速、重力 1400 与撞边反弹 0.78、地面摩擦 2.5。
  常量与公式一个字没改，改一个数手感就变了。

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
| 远端登记目录 | Rust store | `$DSH_HOME/pet-lite/remote-pets.json`（mtime 失效缓存） |

### 已实现的能力（与上游同语义）

- **设置**：选择 / 启用 / 大小 / 抛射开关，命令回吐权威状态。
- **清单**：内置预设（与 desktop `resources/manifest.jsonc` 同源）+ `chat` / `codex` 两份文件系统清单。
- **远端仓库登记**：读仓库 HEAD 提交 + `pet.json`（可选）+ `config.jsonc`，登记为只含资源地址的条目
  （不下载视频包）；`kind` 必须为 `dsh`，只认 `raw.githubusercontent.com`。
- **更新检查 / 更新**：按 HEAD 提交变化判定；更新时额外 HEAD 校验素材齐全。
- **zip 导入**：条目数 / 解压总量上限、可移植相对路径、单一 `pet.json` 根、忽略 OS 元数据
  （`__MACOSX`、`._*`、`.DS_Store`、`Thumbs.db`、`desktop.ini`）、拒绝覆盖已存在 id。
- **删除**：远端条目反注册；来源限定 id（`chat:` / `codex:`）删除目录。
- **外链**：宿主校验仅 http(s)，消费端负责真正打开。

### 注意事项

- GitHub API 未认证限流是 **60 次/小时/IP**（更新检查与登记都会命中）。设 `GITHUB_TOKEN`
  或 `GH_TOKEN` 可换 5000 次/小时配额；不设则按匿名请求走。
- 强制 XWayland 开关不适用（桌面窗口来自 Electron，不是 X11/Wayland 原生窗口），
  对应命令明确返回 `PET_UNSUPPORTED_COMMAND`。

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
| `GET` | `/dsh-pet-lite/catalog` | 预设 + `chat`/`codex` 清单 + 状态（设置页一次拿齐） |
| `GET` | `/dsh-pet-lite/asset?id=` | 渲染参数（预设直连远端；来源限定 id 读盘） |
| `GET` | `/dsh-pet-lite/file?id=&path=` | 本地宠物素材（限定在该宠物目录内） |
| `GET` | `/dsh-pet-lite/config?id=` | 预设配置代理（`file://` 页面避免 CORS） |
| `GET` | `/dsh-pet-lite/pets?source=` | 某来源（`chat`/`codex`）的文件系统宠物清单 |
| `POST` | `/dsh-pet-lite/import` | 导入 Codex 宠物 zip（base64） |
| `POST` | `/dsh-pet-lite/repository` | 登记远端 GitHub 仓库宠物 |
| `PUT` | `/dsh-pet-lite/repository` | 更新一个已登记仓库宠物（校验素材齐全） |
| `DELETE` | `/dsh-pet-lite/repository?id=` | 反注册远端条目 |
| `GET` | `/dsh-pet-lite/updates` | 检查已登记条目是否有新提交 |
| `DELETE` | `/dsh-pet-lite/pet?id=` | 删除宠物（远端反注册 / 删除来源目录） |
| `POST` | `/dsh-pet-lite/open-external` | 校验外链（仅 http/https） |
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
    pet-fs.ts               # 文件系统宠物扫描 / 清单 / 列表
    pet-import.ts           # zip 导入（安全约束同上游）
    pet-repo.ts             # 远端仓库登记 / 更新检查
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
