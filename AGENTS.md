# AGENTS.md

> 首次工作前运行 `pnpm install --frozen-lockfile`；CI 与本地 E2E 需要预装 `@deepseek-ai/dsh` CLI 和 Playwright Chromium。

## 项目结构

DSH 插件采用 Host / Client 双构建，最终产物与浏览器加载入口以 `package.json`、`tsdown.config.ts`、`cordis.patch.yml` 为准。

- `src/index.ts`：Host 插件挂载入口（路由注册 + 桌面窗口生命周期）。
- `src/shared/`：三端共享常量与协议类型（host / client / Electron renderer）。
- `src/host/routes.ts`：原生 `node:http` 业务路由，按方法 + 绝对路径逐条匹配。
- `src/host/catalog.ts` + `presets.json`：内置预设清单，与 desktop `resources/manifest.jsonc` 同源。
- `src/host/store.ts`：设置持久化（`$DSH_HOME/pet-lite/pet.json`，原子写）。
- `src/host/electron-runtime.ts`：Electron 可执行文件解析与进程守护。
- `src/host/session-stream*.ts`：会话总线 → 展示态投影（reducer 逐字复用上游）。
- `src/client/index.ts`：Client 插件挂载入口。
- `src/client/sdk.ts` / `src/client/ui.tsx`：**边界适配层**，唯一为「SDK 未发布」而写的代码。
- `src/client/components/`：React 组件；`register/`：槽位注册；`service/`：领域服务；`store/`：状态。
- `src/renderer/index.tsx`：Electron 桌宠窗口渲染端，独立 IIFE bundle（自包含 React）。
- `runtime/electron-helper/`：Electron 主进程与 preload，**不进 lint/tsc 的源码树**。
- `src/main.css`：dsh-taiwind / tailwind 入口。
- `test/`：Vitest（`test/unit/**`）与 Playwright E2E（`test/e2e/**`）。
- `source/`：**参考子模块**（`dsh-pet`、`deepseek-harness-desktop`）。不参与 lint / typecheck / build。
- `dist/`：构建产物，不手写修改。

## 编码与目录约束

- TypeScript `strict`、ESM、pnpm；依赖版本统一由 `pnpm-workspace.yaml` catalog 管理，相对路径导入。
- 遵循 `@antfu/eslint-config`，不使用 Prettier；React 文件统一 kebab-case。
- 状态优先使用官方 `@deepseek-ai/dsh-client-store`：`defineStore({ init, actions })` 产 handle，
  `.create()` 产实例；所有写操作都是 draft mutator，不额外暴露 `set`/`update`。
- **不要模块级导出 store handle**（模块缓存身份是伪单例，插件重载会串状态）；handle 在 `apply` 内构造。
- 命令执行使用 `tinyexec` 的异步 `x(...)`；禁止新增同步 child-process 调用。
- `@deepseek-ai/dsh` 是 E2E 测试运行时 CLI，不是项目 bundle 依赖。
- 跨文件类型、常量、协议字符串必须集中归档；组件只消费常量。
- Git、文件、进程 API 仅限 Host half；HTTP 路由严格限制方法并校验来源与权限。

## Slot、样式与安全

- `slots.inject(name, () => slots.register(...))`：**必须**用 `inject` 等槽位声明，直接 `register`
  在装配顺序不利时会静默丢失。
- Slot 使用稳定的 `name`、`id`、`registrant`、`order`、`priority`；初始化失败必须 graceful fallback。
- 样式使用单一 style 标签并完整注册/调用 disposer 清理。
- 接入官方能力优先公开 API 与当前安装版本 `.d.ts`；其次才可用 MutationObserver 监听稳定的
  `aria-label` / `role`，禁止依赖 CSS module 哈希。
- 无法安全接入时**明确报错并禁用功能**（`PET_UNSUPPORTED_COMMAND`），禁止半工作状态。

## 复刻纪律（本仓库特有）

本项目的功能以 `source/deepseek-harness-desktop/packages/builtin-plugin-pet` 为基准：

- 业务语义（命令名、DTO、错误文案、加载态、竞态轮次、菜单补丁 DOM 契约、草稿二次触发）**不得改写**。
- 只允许替换**宿主边界**（invoke → HTTP、dsh-tauri-ui → 官方 primitives、valtio → 官方 store）。
  边界替换集中在 `src/client/sdk.ts` 与 `src/client/ui.tsx` 两个文件。
- Electron 路径解析优先级必须保持与 `source/dsh-pet` 的 `resolveElectronPath` 一致（宿主注入只加在前缀）。
- 新增「上游有、这里没有」的能力时，必须让前端明确失败，不得返回成功。

## E2E 与 CI

- Vitest unit project 匹配 `test/**/*.test.ts` 并排除 `test/e2e/**`；E2E project 串行执行。
- DSH 缺失时默认跳过 E2E；设置 `DSH_E2E_REQUIRED=1` 时必须失败。
- CI 在 Ubuntu / Windows / macOS + Node 24 上跑 lint、typecheck、build 和测试。

## 验证

交付前依次执行并确保通过：

```bash
pnpm run lint
pnpm run typecheck
pnpm run test -- --run
pnpm run build
```
