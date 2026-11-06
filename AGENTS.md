# AGENTS.md

> 首次工作前运行 `pnpm install --frozen-lockfile`；CI 与本地 E2E 需要预装 `@deepseek-ai/dsh` CLI 和 Playwright Chromium。

## 项目结构

DSH 插件采用 Host / Client 双构建，最终产物与浏览器加载入口以 `package.json`、`tsdown.config.ts`、`cordis.patch.yml` 为准。

- `src/index.ts`：Host 插件挂载入口；Host 侧共享类型放 `src/types.ts`，共享常量放 `src/constants.ts`。
- `src/server/index.ts`：通过 `defineWebServer` 定义服务入口。
- `src/server/routes/*.[get|post|put|...].ts`：dsh-h3 HTTP 路由，按方法拆分文件。
- `src/client/index.ts`：Client 插件挂载入口。
- `src/client/components/`：唯一集中存放 React 组件的位置，禁止在其他模块分散定义组件。
- `src/client/components/official.ts`：集中导出 DeepSeek 官方组件。
- 新增图标统一放 `src/client/components/icons.tsx`；客户端共享类型放 `src/client/types.ts`，共享常量放 `src/client/constants.ts`。
- `src/main.css`：保留未编译的 dsh-taiwind / tailwind 入口；Client 样式类名在 `src/client/*` 内编写。
- `test/`：Vitest 与 Playwright E2E 测试。
- `test/e2e/**/*.{test,spec}.{ts,tsx}`：真实浏览器 E2E 测试；普通 Vitest 文件后缀即可，不要求 `.e2e.ts`。
- `test/__setup__/shell.ts`：启动真实 DSH shell、构建/安装插件、交换 Cookie、注入浏览器会话并清理临时环境。
- `dist/`：构建产物，不手写修改。
- `vitest.config.ts`：Unit 与 E2E project 入口；`vitest.e2e.config.ts` 负责 E2E project。
- `.github/workflows/ci.yml`：仅复用 `sxzz/workflows/.github/workflows/unit-test.yml@main`。

## 编码与目录约束

- TypeScript `strict`、ESM、pnpm；依赖版本统一由 `pnpm-workspace.yaml` catalog 管理，相对路径导入，显式导入类型与常量。
- 遵循 `@antfu/eslint-config`，不使用 Prettier；React 文件统一 kebab-case（如 `extension-panel.tsx`），优先复用 DeepSeek Harness 官方组件。
- Client 状态优先使用官方 `@deepseek-ai/dsh-client-store`；不得私建替代 Store、绕过官方 context/store 生命周期或另写协议适配层。
- 命令执行使用 `tinyexec` 的异步 `x(...)`；禁止新增同步 child-process 调用和手工拼接 shell 命令。
- `@deepseek-ai/dsh` 是 E2E 测试运行时 CLI，不是项目 bundle 依赖；本地由 PATH 或 `DSH_E2E_DSH` / `DSHM_E2E_DSH` 提供。
- 依赖生命周期由 `postinstall` 执行 `skills-npm` 与 `pnpx skills experimental_install`；`prepare` 负责 Git hooks。
- 跨文件类型、常量、协议字符串必须集中归档；组件只消费常量，不私设协议字符串或重复定义共享结构。
- Git、文件、进程 API 仅限 Host half；HTTP 路由严格限制方法并校验来源与权限。

## Slot、样式与安全

- Slot 使用 `constants.ts` 中的稳定 `name`、`id`、`registrant`、`order`、`priority`；初始化或挂载失败时必须 graceful fallback，禁止白屏。
- 样式使用单一 style 标签并完整注册/调用 disposer 清理；不存在样式时不得残留空标签或重复注入。
- 破坏性 Git 操作必须原子化，并逐步校验结果：禁止静默覆盖用户分支或未提交改动；未知 session 禁止回退到 `process.cwd()`。
- E2E Cookie 交换必须校验 DSH 启动 URL、origin、redirect、`Set-Cookie` 与安全属性；浏览器 Cookie 与 HTTP API cookie 必须保持一致。
- Playwright E2E 使用 `chromium`、临时 `DSH_HOME`、独立 `web` profile；启动 URL 与 token 不写入日志或页面 URL；禁止进程与子进程残留。
- 接入官方能力时优先公开 API 与当前安装版本 `.d.ts`；其次才可用 MutationObserver 监听稳定的 `aria-label` / `role`，禁止依赖 CSS module 哈希。
- 无法安全接入时明确报错并禁用功能，禁止半工作状态；扩展相关契约、文档和测试需同步更新。

## E2E 与 CI

- Vitest unit project 匹配 `test/**/*.test.ts` 并排除 `test/e2e/**`；E2E project 匹配 `test/e2e/**/*.test.ts`、`*.spec.ts`、`*.test.tsx`、`*.spec.tsx`，串行执行。
- DSH 缺失时默认跳过 E2E；设置 `DSH_E2E_REQUIRED=1` 或 `DSHM_E2E_REQUIRED=1` 时必须失败。
- CI 通过 reusable workflow 运行 Ubuntu / Node 24，并由该 workflow 的 `build` 输入预装 `@deepseek-ai/dsh@0.2.1-rc.5`、Playwright Chromium 和项目产物。
- `pnpm-workspace.yaml` 的 `allowBuilds` 需允许项目及测试依赖实际执行的 lifecycle scripts；Playwright 与 DSH profile 安装不得因 ignored build scripts 静默失败。

## 验证

交付前依次执行并确保通过：

```bash
pnpm run lint --fix
pnpm run typecheck
pnpm run test -- --run
pnpm run build
```
