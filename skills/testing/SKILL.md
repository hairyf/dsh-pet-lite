---
name: testing
description: Testing quality criteria, contract verification guidelines, and CI review protocol for TypeScript and Tauri/Rust projects.
license: MIT
metadata:
  author: hairyf
  version: "1.0.0"
---

# 测试评审协议

> **定位**：测试质量与契约验证的唯一权威标准。

---

## 1. 适用范围与核心铁律

* **适用**：新增/修改/AI生成测试的评审、PR门禁、排查 Flaky/假绿测试及开发自检。
* **不适用**：业务代码本身评审、替代测试运行协议。

### 核心铁律

1. **拒绝垃圾测试**：仅守护核心逻辑、状态流转与边界契约。**严禁形式主义测试**（如：正则匹配源码字符串、测试纯静态常量/配置、无逻辑 Getter/Setter）。
2. **未实跑算事故**：严禁仅靠静态查看判定通过，运行命令必须显式带 `run` 并设超时。
3. **严禁迁就变绿**：实现与测试不符时，默认判定实现或测试存在缺陷，不得无故放宽断言。
4. **精确定位输出**：格式统一为 `文件:行 + 原文片段 + 判定 + 依据`。
5. **明确人机分工**：规约扫描交由 `rg` 命令，语义契约必须由人工回读校验。

---

## 2. 评审流程

```text
[Step 0: 定范围] ➔ [Step 1: 建上下文] ➔ [Step 2: 机械扫描] ➔ [Step 3: 逐条过语义]
                                                                  │
[Step 7: 最小修复] ◀─ [Step 6: 出报告] ◀─ [Step 5: 缺陷定级] ◀─ [Step 4: 运行时实证]
```

1. **Step 0 定范围**：锁定改动文件与新增 `**/*.{test,spec,e2e}.ts`。
2. **Step 1 建上下文**：回读被测源码、同目录用例及 `vitest*.config.ts` (确认 globals/include/setup)。
3. **Step 2 机械扫描**：执行 §5 扫描命令并回读原文（排除误报/漏报）。
4. **Step 3 逐条过语义**：重点检查 D1(真实契约)、D2(执行状态)、D3(假绿静默)、D5(隔离确定性)、D7(变异验证)。
5. **Step 4 运行时实证**：
  * 执行单文件/全量复测：`vitest run --project unit [file]`
  * 交叉验证：单跑绿但全量红 = 共享状态污染；变异测试 = 故意破坏实现验证用例变红。
6. **Step 5 缺陷定级**：按 Blocker / Major / Minor / Nit 归类。Blocker 必须附带修复方案与复跑命令。
7. **Step 6 出报告**：按 §6 规范及四态（APPROVED / APPROVED_WITH_NOTES / CHANGES_REQUIRED / BLOCKED）输出。
8. **Step 7 最小修复**：仅在明确要求时修复，禁止更改无关逻辑或降低断言标准。

---

## 3. 评审维度 (D1–D8)

### D1 断言是否验到真实契约 (Blocker)

* **判据**：断言必须能拦截错误。期望值须有独立来源（字面量/独立夹具），**严禁使用被测实现计算期望值**。
* **正例**：`expect(user).toMatchObject({ name, email })`
* **反例**：`expect(res).toBeDefined()` (孤立弱断言)；`expect(f(x)).toBe(f(x))` (自比/借用实现)。

### D2 用例是否有效执行 (Blocker)

* **判据**：用例须匹配 `include` 规则；避免条件跳过导致门禁用例被静默忽略（如 `describe.skipIf(platform === 'darwin')`）。

### D3 假绿与静默失败 (Blocker)

* **吞异常/中途 Return**：禁止 `try-catch` 空处理、`if (!ok) return`；改用 `expect.fail()` 或显式断言。
* **宽泛过滤/空值掩盖**：禁止宽泛过滤错误，禁止 `res ?? []` 配合 `toHaveLength(0)`。
* **弱断言/析取**：禁止 `a || b` 析取断言、可选链漏断（如 `el?.getText()`）；禁止空壳用例。

### D4 异步、Mock 与还原 (Blocker / Major)

* **异步控制 (Blocker)**：`resolves/rejects` 须加 `await` 或 `return`。单测使用 `vi.useFakeTimers()`/`vi.waitFor()`，E2E 使用 `expect.poll()`，禁止硬编码等待。
* **Mock 纪律 (Major)**：**严禁 Mock 被测对象本身**。在 `afterEach` 中显式清理 Mock (`vi.restoreAllMocks()`)。禁止盲目使用快照替代结构断言。

### D5 隔离与确定性 (Blocker)

* **隔离安全**：禁止触碰真实用户目录，强制使用 `DSH_E2E_HOME` 等隔离环境；禁止拉起系统外部程序或杀用户进程。
* **无状态依赖**：全局变量/缓存/环境变量须在 `beforeEach/afterEach` 重置；须保证在 `--sequence.shuffle` 乱序下平稳通过。

### D6 边界与错误路径 (Major)

* **契约拒绝**：异常输入（缺参/越界/上游崩溃）必须断言抛出对应错误码或异常，不可静默改写或返回默认值。
* **必查边界**：空值/缺失值、极值上限、依赖失败路径、空集合处理。

### D7 变异验证 (核心判据)

* **有效性抽查**：故意破坏实现逻辑，验证测试是否确实变红。
* **Bug 修复保护**：修复 Bug 前须先补充能复现错误的回归测试，验证变红后再修代码。

### D8 命名与结构 (Major / Minor)

* **契约命名 (Major)**：`it()` 标题须清晰表达“对象 + 条件 + 预期结果”。严禁 `works`, `test1` 等无意义命名。
* **分层与单一行为 (Minor)**：遵循 L1/L2/L3 归属。一用例验一行为，避免在单测中做 E2E 校验。

---

## 3.1 ❌ 一票否决项 (垃圾测试)

若存在以下特征，**直接判定为 Blocker/无效测试并予以剔除**：

1. **源码反查型**：通过 `fs.readFileSync` 读取源码匹配字符串或正则。
2. **静态常量单测**：对纯数据对象、枚举（Enum）、`constants.ts` 编写单测（应由 TS 类型系统保障）。
3. **过度微小包装**：对无逻辑分支的纯转发/胶水函数编写单测。
4. **硬编码环境路径**：硬编码绝对路径或特定 OS 逻辑导致的跨平台不可移植测试。

---

## 4. 缺陷分级与准入门禁

### 缺陷分级

* **Blocker**：垃圾测试/恒过/未运行/无断言/污染环境/假绿静默/E2E Mock 后端 ➔ **阻断，必须修复并复跑**。
* **Major**：弱断言/过度 Mock/未隔离/缺关键边界/分层错误 ➔ **本 PR 修复或记录 Issue**。
* **Minor**：可读性/命名不符/多行为未拆分/日志残留 ➔ **建议顺手修复**。
* **Nit**：纯排版或风格偏好 ➔ **可选处理**。

### 准入门禁

1. 连续独立运行 **≥ 5 次无 Flake**，且支持 `--sequence.shuffle` 乱序运行；
2. 跨平台（Windows / Linux）门禁稳定通过；
3. 失败信息可精确定位至“用例-步骤-期望与实际”；
4. `it()` 标题即契约且与内部断言一致；
5. 环境完全隔离，无真实用户数据改写。

---

## 5. Vitest 配置与运行规范

### 本仓事实

* **无全局 API**：须显式导入 `import { describe, it, expect, vi } from 'vitest'`。
* **无自动还原**：文件内须显式声明 `afterEach(() => vi.restoreAllMocks())`。
* **API 规范**：全仓使用 `vi.*`（禁止 `jest.*`）。`.mock.calls` 建议配合 `structuredClone` 避免引用改变陷阱。

### 标准运行命令

```bash
vitest run --project unit                              # 全量单测
vitest run --project unit path/to/file.test.ts         # 单文件复测
vitest run --project unit --sequence.shuffle           # 乱序排查

```

---

## 6. 机检扫描命令 (`rg`)

> **提示**：命中结果仅作线索，须回读代码确认语义。

| # | 检查项 | 命令 | 默认等级 |
| --- | --- | --- | --- |
| 1 | 聚焦标记残留 | `rg -n '\.(only)\s*\('` / `rg -n 'fdescribe\s*\('` | Blocker |
| 2 | Jest API 混用 | `rg -n '\bjest\s*\.' packages test src -g '*.ts'` | Blocker |
| 3 | 缺少 await 的 Promise 断言 | `rg -n 'resolves\.' packages test src -g '*.ts'` 或 `rg -n 'rejects\.' packages test src -g '*.ts'` | Blocker |
| 4 | 跳过标记残留 | `rg -n 'skipIf'` 或 `rg -n 'it\.skip'` | Major |
| 5 | 弱断言收尾 | `rg -n '\.toBeDefined'` 或 `rg -n '\.toBeTruthy'` | Major |
| 6 | 触碰真实用户数据 | `rg -n '\.dsh\.dev'` 或 `rg -n '\.store\.dev\.dat'` | Blocker |
| 7 | 硬编码 setTimeout | `rg -n 'await new Promise' packages test src -g '*.ts'`, 再运行 `rg -n 'setTimeout'` | Major |
| 8 | 调试/残留日志 | `rg -n 'console\.log'` 或 `rg -n 'console\.debug'` | Minor |
| 9 | 遗留 TODO/FIXME | `rg -n 'TODO'` 或 `rg -n 'FIXME'` | Minor |
| 10 | 误用 test() 替代 it() | `rg -n '^\s*test\(' packages test src -g '*.ts'` | Minor |

---
