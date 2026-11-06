import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import "@electron-internal/extract-zip";
import "@electron/get";
import { Buffer } from "node:buffer";
import { homedir } from "node:os";
//#region src/host/electron-runtime.ts
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
const require = createRequire(import.meta.url);
/** 包根：`dist/` 的上一级。 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 桌宠 Electron 主进程入口（`runtime/electron-helper/main.js`）。 */
const defaultHelperMain = resolve(packageRoot, "runtime", "electron-helper", "main.js");
/** 当前平台标识（win32 / darwin / linux）。 */
const PLAT = process.platform;
/** 落地目录下可执行文件的相对路径（按平台）。 */
const ELECTRON_REL = PLAT === "win32" ? "electron.exe" : PLAT === "darwin" ? join("Electron.app", "Contents", "MacOS", "Electron") : "electron";
/** `$DSH_HOME`（默认 `~/.dsh`），与 `ensure-electron.mjs` 的 HOME 计算一致。 */
function dshHomeDir() {
	const userProfile = process.env.USERPROFILE || process.env.HOME || "";
	return process.env.DSH_HOME || join(userProfile, ".dsh");
}
/** Electron 运行时落地目录（`$DSH_HOME/electron`）—— 下载解压的目标，唯一定义处。 */
function electronLandingDir() {
	return join(dshHomeDir(), "electron");
}
/** Electron 落地路径：`$DSH_HOME/electron/<按平台的可执行文件>`。 */
function defaultElectronExe() {
	return join(electronLandingDir(), ELECTRON_REL);
}
/**
* 宿主注入的 Electron 路径候选。
*
* `DSH_ELECTRON_PATH` 是本插件自己的显式约定；`DSH_NODE` 是 dsh-tauri 桌面端已有的注入
* （它指向「随包 Electron」，桌面端用它以 `ELECTRON_RUN_AS_NODE=1` 跑 dsh 内核）。
*
* 【为什么必须排除「正在运行的自己」】若宿主把 `DSH_NODE` 指向当前进程的 `process.execPath`
* 且当前进程就是那个 Electron（桌宠 helper 自己再拉起 helper），会把同一个二进制当成
* 「可复用的宿主 Electron」递归使用 —— 它缺少 Node 模式的 wrapper，行为不可预期。
* 因此候选只接受**已存在且不是当前 `process.execPath`** 的路径。
*/
function hostInjectedCandidates() {
	const list = [];
	const push = (value) => {
		const trimmed = value?.trim();
		if (!trimmed || !existsSync(trimmed)) return;
		if (resolve(trimmed) === resolve(process.execPath)) return;
		list.push(trimmed);
	};
	push(process.env.DSH_ELECTRON_PATH);
	push(process.env.DSH_NODE);
	return list;
}
/**
* 解析 Electron 可执行文件。
*
* @param candidates - 调用方显式候选（最高优先，排在最前）。
* @returns 第一个存在的可执行文件路径；都不存在时 undefined。
*/
function resolveElectronPath(candidates = []) {
	const seen = /* @__PURE__ */ new Set();
	const list = [];
	const push = (value) => {
		if (!value || seen.has(value)) return;
		seen.add(value);
		list.push(value);
	};
	for (const value of hostInjectedCandidates()) push(value);
	for (const value of candidates) push(value);
	if (process.env.DSH_PET_ELECTRON_PATH) push(process.env.DSH_PET_ELECTRON_PATH);
	try {
		const resolved = require("electron");
		if (typeof resolved === "string" && resolved) push(resolved);
	} catch {}
	push(defaultElectronExe());
	return list.find((value) => existsSync(value));
}
/**
* 判断当前环境能否真的跑起 Electron 图形窗口。
*
* Linux 无显示环境（服务器 / 容器 / 纯 CLI）下 Electron 能下载并 spawn，但初始化图形栈
* 时立刻崩溃；配合守护循环会变成「拉起 → 崩溃 → 重启」，几小时堆出几十 GB core dump。
* 因此必须在拉起之前判断。
*/
function hasGraphicalDisplay() {
	if (process.platform !== "linux") return true;
	if (process.env.DSH_PET_DESKTOP_FORCE === "1") return true;
	return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
/** 拉起参数：`command = <electron> args = [main.js]`（与 dsh-pet 一致）。 */
function defaultLaunch(options = {}) {
	const electronPath = resolveElectronPath([options.electronPath]);
	if (!electronPath) throw new Error("dsh-pet-lite: cannot resolve Electron executable. Set DSH_PET_ELECTRON_PATH or install electron.");
	return {
		command: electronPath,
		args: [options.helperPath || defaultHelperMain]
	};
}
/** 重启退避：750ms 起 2× 封顶 30s。 */
function restartBackoffDelayMs(consecutiveFailures, baseMs = 750) {
	return Math.min(baseMs * 2 ** Math.max(0, consecutiveFailures), 3e4);
}
/** 熔断：连续崩溃 12 次后停止重启。 */
function shouldCircuitBreak(consecutiveFailures, limit = 12) {
	return consecutiveFailures >= limit;
}
/** 稳定运行 3 分钟后清零崩溃计数。 */
const HELPER_STABLE_MS = 180 * 1e3;
function helperRunIsStable(elapsedMs) {
	return elapsedMs >= HELPER_STABLE_MS;
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
var HelperProcess = class {
	options;
	logger;
	child;
	stopping = false;
	restartTimer;
	restartFailures = 0;
	lastStartAt = 0;
	constructor(options = {}, logger = console) {
		this.options = options;
		this.logger = logger;
	}
	get running() {
		return this.child !== void 0;
	}
	start() {
		if (this.child || this.stopping) return;
		this.lastStartAt = Date.now();
		const launch = defaultLaunch(this.options);
		const child = spawn(launch.command, launch.args, {
			cwd: this.options.cwd || packageRoot,
			env: {
				...process.env,
				...this.options.env
			},
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true,
			detached: false
		});
		this.child = child;
		child.once("error", (error) => {
			this.logger.error?.(`dsh-pet-lite desktop helper failed to start: ${error.message}`);
		});
		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = void 0;
			if (this.stopping) return;
			this.logger.warn?.(`dsh-pet-lite desktop helper exited (code=${String(code)}, signal=${String(signal)}); restarting`);
			this.scheduleRestart();
		});
		child.stdout?.on("data", (chunk) => this.onStdout(String(chunk)));
		child.stderr?.on("data", (chunk) => {
			const line = String(chunk).trim();
			if (line) this.logger.warn?.(`[dsh-pet-lite desktop helper] ${line}`);
		});
		this.logger.info?.(`dsh-pet-lite desktop helper started (${launch.command})`);
	}
	/** stdout 按行缓冲：逐行交给日志出口（没有协议行要分流）。 */
	onStdout(chunk) {
		this.buffer += chunk;
		for (;;) {
			const nl = this.buffer.indexOf("\n");
			if (nl < 0) break;
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (!line) continue;
			if (this.options.onLog) this.options.onLog(line);
			else this.logger.debug?.(`[dsh-pet-lite desktop helper] ${line}`);
		}
	}
	buffer = "";
	stop(reason = "plugin-disposed") {
		this.stopping = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = void 0;
		this.logger.debug?.(`dsh-pet-lite desktop helper stopping (${reason})`);
		const child = this.child;
		this.child = void 0;
		this.buffer = "";
		if (!child) return;
		try {
			child.kill();
		} catch {}
	}
	/** 允许再次 start（stop 之后复用同一实例）。 */
	reset() {
		this.stopping = false;
		this.restartFailures = 0;
	}
	scheduleRestart() {
		if (this.restartTimer || this.stopping) return;
		if (helperRunIsStable(Date.now() - this.lastStartAt)) this.restartFailures = 0;
		else this.restartFailures += 1;
		if (shouldCircuitBreak(this.restartFailures)) {
			this.logger.error?.(`dsh-pet-lite desktop helper crashed ${this.restartFailures} consecutive times; circuit breaker tripped`);
			return;
		}
		const delay = restartBackoffDelayMs(this.restartFailures - 1);
		this.logger.warn?.(`dsh-pet-lite desktop helper restarting in ${Math.round(delay)}ms (attempt ${this.restartFailures})`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = void 0;
			this.start();
		}, delay);
		this.restartTimer.unref?.();
	}
};
//#endregion
//#region src/shared/constants.ts
/**
* dsh-pet-lite — 插件名与协议常量。
*
* `PLUGIN_ID` 同时是 Cordis 补丁项 id、locale 命名空间与诊断标签。
* 路由路径同时被三端消费：宿主 HTTP、应用内浮层、Electron 桌宠窗口。
*/
const PLUGIN_ID = "dsh-pet-lite";
/** 桌宠业务路由前缀（与 apps/desktop `bridge/pet.rs` 的 ROUTE_PREFIX 同形）。 */
const ROUTE_PREFIX = "/dsh-pet-lite";
/** 会话增量 SSE 流：`${ROUTE_PREFIX}${SESSION_STREAM_PATH}`。 */
const SESSION_STREAM_PATH = "/session/stream";
/** 统一设置读取 / 写入。 */
const SETTINGS_PATH = "/settings";
/** 预设 / Chat / Codex 三份清单。 */
const CATALOG_PATH = "/catalog";
/** SSE 心跳注释帧间隔（毫秒）。 */
const SSE_KEEPALIVE_MS = 15e3;
//#endregion
//#region src/host/catalog.ts
const BUILT_IN = readBuiltIn();
function readBuiltIn() {
	const packageRoot = resolvePackageRoot();
	return JSON.parse(readFileSync(join(packageRoot, "dist", "presets.json"), "utf8")).pets?.["built-in"] ?? [];
}
/** 包根：从本模块位置向上找到含 `package.json` 的目录。 */
function resolvePackageRoot() {
	let directory = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		if (existsSync(join(directory, "package.json"))) return directory;
		const parent = dirname(directory);
		if (parent === directory) return directory;
		directory = parent;
	}
}
function toItem(spec, remote) {
	return {
		id: spec.id,
		name: spec.name,
		desc: spec.desc ?? null,
		image: spec.image ?? null,
		kind: spec.kind === "codex" ? "codex" : "dsh",
		size: spec.size ?? null,
		config: spec.config,
		uri: spec.uri,
		ext: spec.ext ?? null,
		remote
	};
}
/** 合并内置与登记条目（内置在前；id 撞车时丢弃登记条目）。 */
function mergeCatalog(remote = []) {
	const builtInIds = new Set(BUILT_IN.map((spec) => spec.id));
	return [...BUILT_IN.map((spec) => toItem(spec, false)), ...remote.filter((spec) => !builtInIds.has(spec.id)).map((spec) => toItem(spec, true))];
}
/** 内置条目（不含用户登记）。 */
function builtInCatalog() {
	return mergeCatalog([]);
}
/**
* 把预设条目投影成桌宠窗口的渲染参数（对应 Rust `get_pet_asset`）。
*
* 预设宠物直连远端：`config` 与 `uri` 原样返回，不下载、不落地。
*/
function presetAsset(item) {
	if (item.kind === "codex") return {
		kind: "codex",
		id: item.id,
		spritesheet: typeof item.uri === "string" ? item.uri : item.uri.default,
		sprite_version_number: 2,
		columns: 8,
		rows: 11
	};
	return {
		kind: "dsh",
		id: item.id,
		config: item.config,
		uri: item.uri,
		ext: item.ext ?? {
			default: "webm",
			mac: "mov"
		},
		size: item.size ?? void 0
	};
}
//#endregion
//#region src/host/runtime.ts
/** 已接入的 SSE 消费者（断连即移除）。 */
const sinks = /* @__PURE__ */ new Set();
/** 会话出生标记：首次出现的 id 推 create，此后只推增量 update。 */
const knownSessions = /* @__PURE__ */ new Set();
/** 会话总线监听注销句柄；undefined = 当前无消费者、未挂载。 */
let disposeSessionBus;
function isSessionBusAttached() {
	return disposeSessionBus !== void 0;
}
function setSessionBusDispose(dispose) {
	disposeSessionBus = dispose;
}
/** 注销会话总线监听并丢弃会话标记（幂等）。 */
function closeSessionBus() {
	const dispose = disposeSessionBus;
	disposeSessionBus = void 0;
	dispose?.();
	knownSessions.clear();
}
/**
* service/session-stream.utils.ts — 纯函数「会话增量 → 桌宠展示态」reducer。
*
* 宿主没有客户端已合并的快照，因此必须把增量状态化重建成桌宠需要的展示态；与 dsh-dafeiyu
* 的 companion-reducer 同类，但只投影桌宠白名单字段。所有成员无副作用、可注入时钟，供
* hermetic 单测。
*
* 增量有**两条**来源，缺一不可：
* - `session/event`（持久化事件总线）：turn/step/tool/approval/todo/title 等边界事件；
* - `agent/assistant-stream`（agent-scoped 活体帧）：逐 token 的 reasoning/text 增量。核心
*   0.1.6 起流式增量不再落成 `assistant/chunk` 会话事件，只走这条帧通道（见 `chunk()`）。
*/
/**
* 维持 per-session 累计态 + lastSent 去重，只在展示态真的变化时回调。
*
* 推理文本（流式 reasoning-delta）按 `PET_REASONING_PUSH_INTERVAL_MS` 节流：
* 状态实时累积，但最多每 500ms 推送一次最新尾部，避免逐 token 洪泛。
*
* @param handle - 变化时回调 (action, payload)。
* @param opts - 可选配置。
* @param opts.now - 注入时钟（ms），供单测 hermetic 推进时间。
*/
function createPetSessionReducer(handle, opts) {
	const now = opts?.now ?? (() => Date.now());
	const states = /* @__PURE__ */ new Map();
	const lastSent = /* @__PURE__ */ new Map();
	const lastReasoningPushAt = /* @__PURE__ */ new Map();
	/** 增量事件驱动：更新态，变化才 push update。 */
	const applyEvent = (peer, event) => {
		let state = states.get(peer.id);
		if (state === void 0) {
			state = createPetSessionState(peer.id, peer);
			states.set(peer.id, state);
		}
		state.title = peer.title ?? state.title;
		state.displayTitle = peer.displayTitle ?? state.displayTitle;
		state.origin = peer.origin ?? state.origin;
		state.cwd = peer.cwd ?? state.cwd;
		const payload = reduceSessionEvent(state, event);
		if (payload === null) return;
		if (event.type === "assistant/chunk" && payload.liveActivity?.kind === "reasoning") {
			const at = now();
			if (at - (lastReasoningPushAt.get(peer.id) ?? 0) < 500) return;
			lastReasoningPushAt.set(peer.id, at);
		}
		const previous = lastSent.get(peer.id);
		if (previous && payloadEqual(previous, payload)) return;
		lastSent.set(peer.id, payload);
		handle("update", payload);
	};
	return {
		/** 会话出生：建态并 push create。 */
		create(peer) {
			const state = createPetSessionState(peer.id, peer);
			states.set(peer.id, state);
			const payload = foldPetPayload(state);
			lastSent.set(peer.id, payload);
			handle("create", payload);
		},
		apply: applyEvent,
		/**
		* 活体流式 chunk（核心 0.1.6 起流式增量走 agent-scoped 的
		* `agent/assistant-stream` 帧，不再作为 `assistant/chunk` 会话事件发布）。
		*
		* 帧里的 `chunk` 与旧事件的 `data.chunk` 同形（`reasoning-delta` / `text-delta` / …），
		* 因此这里折叠成一条合成 `assistant/chunk` 事件复用同一段增量语义 —— 推理尾部窗口、
		* 500ms 节流、与 lastSent 的去重都只有一份实现。
		*/
		chunk(peer, chunk) {
			applyEvent(peer, {
				type: "assistant/chunk",
				seq: 0,
				time: now(),
				data: { chunk }
			});
		},
		/**
		* agent 空闲兜底（宿主 `agent/status → idle`）。
		*
		* 【为什么必须有】`turn/end` 不是「回合收尾」的可靠信号：核心在异常收尾时可能**永远不追加**
		* 它——真实现场（用户中止一个刚起流的会话）里日志只有 `assistant/attempt` + `step/end`，
		* `turn/end` 直到会话重新加载时才由崩溃修复以 `interrupted` 补写，而崩溃修复不会再走
		* `session/event`。桌宠只认 `turn/end`，于是永远停在「思考中」气泡 + 循环工作动画。
		*
		* 【为什么限定 inTurn】`agent/status → idle` 总是紧跟在 `turn/end` 之后（同一轮收尾）；
		* 只有当回合内标志仍然成立（说明 `turn/end` 根本没到）才改写，避免把刚由 turn/end 写好的
		* 终态档（success 庆祝 / error 失败）与 blocked 等待态立刻清掉。
		*/
		idle(id) {
			const state = states.get(id);
			if (state === void 0 || !inTurn(state)) return;
			settleIdle(state);
			const payload = foldPetPayload(state);
			const previous = lastSent.get(id);
			if (previous && payloadEqual(previous, payload)) return;
			lastSent.set(id, payload);
			handle("update", payload);
		},
		/** 会话消失：push remove 并清态。 */
		remove(id) {
			states.delete(id);
			lastSent.delete(id);
			lastReasoningPushAt.delete(id);
			handle("remove", { id });
		},
		/** 清空累计态与其去重快照（无消费者时调用）。 */
		clear() {
			states.clear();
			lastSent.clear();
			lastReasoningPushAt.clear();
		}
	};
}
/** 新建一个会话的累计态。 */
function createPetSessionState(id, peer) {
	return {
		id,
		origin: peer.origin,
		title: peer.title,
		displayTitle: peer.displayTitle,
		cwd: peer.cwd,
		running: peer.running ?? false,
		turnActive: false,
		stepActive: false,
		openTools: /* @__PURE__ */ new Map(),
		reasoningTail: "",
		assistantText: ""
	};
}
/** 从累计态 fold 出当前展示 payload（只投影桌宠关心的字段）。 */
function foldPetPayload(state) {
	const firstTool = state.openTools.values().next().value;
	const liveActivity = state.running && firstTool !== void 0 ? toolActivity(firstTool.name, firstTool.args) : state.running && state.reasoningTail.length > 0 ? {
		kind: "reasoning",
		text: state.reasoningTail
	} : void 0;
	let status;
	if (state.lastAgentError) status = "error";
	else if (state.waitingKind) status = "waiting";
	else if (state.running || state.turnActive) status = "running";
	return {
		id: state.id,
		origin: state.origin,
		title: state.title ?? state.displayTitle,
		displayTitle: state.displayTitle,
		message: state.assistantText || void 0,
		status,
		activity: status,
		phase: state.waitingKind,
		running: state.running,
		lastAgentError: state.lastAgentError,
		workStatus: state.workStatus,
		task: state.task,
		toolActivity: state.toolActivity,
		liveActivity
	};
}
/** 工具名 → 活动分类（气泡按分类选文案）。 */
function toolActivityOf(name) {
	const value = String(name || "").toLowerCase();
	if (/search|grep|find|glob|web|read|fetch|open/.test(value)) return "searching";
	if (/write|edit|patch|replace|create|move|delete/.test(value)) return "editing";
	if (/test|check|lint|build|verify/.test(value)) return "testing";
	if (/shell|bash|exec|command|terminal|powershell|pwsh/.test(value)) return "commanding";
	return "using-tool";
}
/**
* 本回合是否为 goal **自动续跑轮**：`user/message` 的 source 标记 `kind === 'goal'` 且 `round > 0`。
*
* `round === 0` 是用户 `/goal` 触发的激活轮（内核 `isGoalRound` 同样只把 `round > 0` 计入续跑轮），
* 其终局语义按普通回合处理。
*/
function isGoalRoundEvent(data) {
	const source = data.source;
	return source?.kind === "goal" && typeof source.round === "number" && source.round > 0;
}
/** 是否为「替换既有事件区间」的记账事件（`surfaceOp` 非 `'append'`），而非正常追加。 */
function isReplaceSurfaceEvent(event) {
	const op = event.surfaceOp;
	return op !== void 0 && op !== "append" && op.op === "replace";
}
/** `update_goal` 调用声明的收尾动作；`edit`/`pause`/`resume` 不算收尾，参数不可解析时忽略。 */
function goalClosingOf(name, args) {
	if (name !== "update_goal") return void 0;
	try {
		const action = JSON.parse(args ?? "").action;
		return action === "complete" || action === "blocked" ? action : void 0;
	} catch {
		return;
	}
}
/**
* 回合终局档位：goal 续跑轮的**中间轮**只到 `result`（目标仍在推进，不得播雀跃庆祝）。
* 非 goal 轮维持 `success`；续跑轮以 `update_goal` 收尾时按收尾动作定档。
*/
function completedStatus(state) {
	if (!state.goalRound) return "success";
	if (state.goalClosing === "blocked") return "error";
	return state.goalClosing === "complete" ? "success" : "result";
}
/**
* 从 todo/write 提取当前任务文本。
*
* 取**最后一个** in_progress：agent 常把新步骤标 in_progress 却忘标上一步 completed，
* 取第一个会让文案永远停在最早那步。清单无进行中项时回落第一个 pending。
*
* 文案按**码点**截断到 `PET_TASK_TEXT_MAX`（气泡最大宽只有宠物宽的 0.5 倍，长 todo 原文
* 会把气泡撑成多行）；用 `Array.from` 而非 `slice`，避免劈开代理对或 emoji。
*/
function currentTaskFromTodo(data) {
	const todos = Array.isArray(data.todos) ? data.todos : [];
	const current = todos.findLast((todo) => todo?.status === "in_progress") ?? todos.find((todo) => todo?.status === "pending");
	const content = Array.from(String(current?.content ?? "").trim());
	if (!content.length) return void 0;
	return content.length > 40 ? `${content.slice(0, 40).join("")}…` : content.join("");
}
/** 需要 fold+去重的边界事件（增量 chunk 不在其中，防止高频转发）。 */
const FOLDABLE_EVENTS = /* @__PURE__ */ new Set([
	"turn/start",
	"step/start",
	"assistant/message",
	"tool/call",
	"tool/result",
	"user/message",
	"turn/end",
	"session/title",
	"approval/asked",
	"approval/decided"
]);
/** 一次会话增量事件的 reducer：返回变化后的 payload 或 null（未变化则不转发）。 */
function reduceSessionEvent(state, event) {
	const t = event.type;
	const data = event.data ?? {};
	switch (t) {
		case "turn/start":
			state.turnActive = true;
			state.running = true;
			state.reasoningTail = "";
			state.assistantText = "";
			state.waitingKind = void 0;
			state.waitingApprovalId = void 0;
			state.waitingCallId = void 0;
			state.lastAgentError = void 0;
			state.workStatus = "thinking";
			state.task = void 0;
			break;
		case "step/start":
		case "assistant/chunk":
			state.stepActive = true;
			state.running = true;
			if (t === "step/start" && !state.waitingKind && state.openTools.size === 0) state.workStatus = "thinking";
			if (t === "assistant/chunk") {
				const chunk = data.chunk;
				if (chunk?.type === "reasoning-delta" && typeof chunk.text === "string" && chunk.text) {
					state.reasoningTail = (state.reasoningTail + chunk.text).slice(-120);
					if (!state.waitingKind && state.openTools.size === 0) state.workStatus = "thinking";
					return foldPetPayload(state);
				}
				if (chunk?.type === "text-delta" && typeof chunk.text === "string" && chunk.text) state.assistantText = (state.assistantText + chunk.text).slice(-1e3);
				return null;
			}
			break;
		case "assistant/message": {
			state.stepActive = true;
			state.running = true;
			const text = (data.message?.content)?.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
			if (text) state.assistantText = text.slice(-1e3);
			if (!state.waitingKind && state.openTools.size === 0) state.workStatus = "thinking";
			break;
		}
		case "tool/call": {
			const call = data;
			const name = call.name;
			const closing = goalClosingOf(name, call.arguments);
			if (closing) state.goalClosing = closing;
			if (name) state.openTools.set(call.callId ?? name, {
				name,
				args: call.arguments
			});
			state.running = true;
			if (name && isUserQuestionTool(name)) {
				state.waitingKind = "user-question";
				state.waitingCallId = call.callId ?? name;
				state.workStatus = "waiting";
			} else {
				if (name) state.toolActivity = toolActivityOf(name);
				state.workStatus = "working";
			}
			break;
		}
		case "tool/result": {
			const callId = toolCallIdOf(event);
			if (callId) {
				state.openTools.delete(callId);
				if (callId === state.waitingCallId) {
					state.waitingKind = void 0;
					state.waitingCallId = void 0;
				}
			} else state.openTools.clear();
			if (state.openTools.size > 0) {
				state.workStatus = "working";
				state.toolActivity = toolActivityOf(state.openTools.values().next().value?.name);
			} else state.workStatus = state.waitingKind ? "waiting" : "result";
			break;
		}
		case "approval/asked": {
			const id = String(data.id ?? "");
			state.waitingKind = "approval";
			state.waitingApprovalId = id;
			state.running = true;
			state.workStatus = "waiting";
			break;
		}
		case "approval/decided": {
			const id = String(data.id ?? "");
			if (!state.waitingApprovalId || id !== state.waitingApprovalId) return null;
			state.waitingApprovalId = void 0;
			state.waitingKind = void 0;
			state.workStatus = state.openTools.size > 0 ? "working" : "thinking";
			break;
		}
		case "user/message":
			if (isReplaceSurfaceEvent(event)) return null;
			if (isGoalRoundEvent(data)) state.goalRound = true;
			state.running = true;
			state.turnActive = true;
			if (state.waitingCallId !== void 0) {
				state.waitingKind = void 0;
				state.waitingCallId = void 0;
				state.workStatus = state.openTools.size > 0 ? "working" : "thinking";
			}
			break;
		case "todo/write": {
			const task = currentTaskFromTodo(data);
			if (task === state.task) return null;
			state.task = task;
			return foldPetPayload(state);
		}
		case "session/title": {
			const title = data.title;
			if (typeof title === "string" && title) {
				state.title = title;
				state.displayTitle = title;
			}
			break;
		}
		case "turn/end": {
			state.turnActive = false;
			state.stepActive = false;
			state.running = false;
			state.openTools.clear();
			state.reasoningTail = "";
			state.assistantText = "";
			state.waitingApprovalId = void 0;
			state.waitingCallId = void 0;
			const reason = data.reason;
			if (reason?.kind === "blocked") {
				state.waitingKind = "blocked";
				state.workStatus = "waiting";
			} else {
				state.waitingKind = void 0;
				if (reason?.kind === "completed") {
					state.workStatus = completedStatus(state);
					state.lastAgentError = void 0;
				} else if (reason?.kind === "error" || reason?.kind === "max-tokens" || reason?.kind === "timeout") {
					state.workStatus = "error";
					state.lastAgentError = reason.error?.message ?? reason.kind;
				} else settleIdle(state);
			}
			state.goalRound = false;
			state.goalClosing = void 0;
			break;
		}
		default: break;
	}
	if (!FOLDABLE_EVENTS.has(t)) return null;
	return foldPetPayload(state);
}
/**
* 把累计态落定为「回合已收尾、空闲」：清掉回合内的一切瞬时态。
*
* `turn/end` 的中断分支与 `agent/status → idle` 兜底共用同一份语义，避免两条收尾路径
* 漂移出「一条清干净、另一条残留 thinking」这类只在真实中断时复现的差异。
*/
function settleIdle(state) {
	state.turnActive = false;
	state.stepActive = false;
	state.running = false;
	state.openTools.clear();
	state.reasoningTail = "";
	state.assistantText = "";
	state.waitingKind = void 0;
	state.waitingApprovalId = void 0;
	state.waitingCallId = void 0;
	state.workStatus = void 0;
	state.lastAgentError = void 0;
	state.goalRound = false;
	state.goalClosing = void 0;
}
/** 会话是否仍处于「回合内」（只有这种状态才允许被 idle 兜底改写）。 */
function inTurn(state) {
	return state.running || state.turnActive || state.stepActive;
}
/** 两个 payload 是否深相等（以 fold 出的关键字段表征）。 */
function payloadEqual(a, b) {
	return Object.is(a.status, b.status) && Object.is(a.activity, b.activity) && Object.is(a.phase, b.phase) && Object.is(a.running, b.running) && Object.is(a.message, b.message) && Object.is(a.lastAgentError, b.lastAgentError) && Object.is(a.origin, b.origin) && Object.is(a.title, b.title) && Object.is(a.displayTitle, b.displayTitle) && Object.is(a.workStatus, b.workStatus) && Object.is(a.task, b.task) && Object.is(a.toolActivity, b.toolActivity) && Object.is(a.liveActivity?.kind, b.liveActivity?.kind) && Object.is(a.liveActivity?.text, b.liveActivity?.text) && Object.is(a.liveActivity?.name, b.liveActivity?.name) && Object.is(a.liveActivity?.command, b.liveActivity?.command) && Object.is(a.liveActivity?.path, b.liveActivity?.path) && Object.is(a.liveActivity?.args, b.liveActivity?.args);
}
/** 工具名 → liveActivity 展示对象（所有工具统一携带 name+args）。 */
function toolActivity(name, args) {
	return name ? {
		kind: "tool",
		name,
		args
	} : { kind: "tool" };
}
/**
* 从 tool 事件提取调用 id：`tool/call` 直接给 `data.callId`；`tool/result` 的 callId 藏在
* `data.message` 里（source.callId / content[].toolCallId / message.toolCallId | callId）。
*/
function toolCallIdOf(event, fallback = "") {
	const data = event.data;
	const message = data?.message;
	const content = Array.isArray(message?.content) ? message.content.find((item) => item.toolCallId) : void 0;
	const callId = (message?.source)?.callId ?? content?.toolCallId ?? message?.toolCallId ?? message?.callId ?? data?.callId;
	return String(callId ?? fallback);
}
/**
* 判断一个工具名是否是「等用户回答」的问句工具（approval/澄清/确认类），而非普通脚本
* （避免把 code_review/allowlist_files/permission_scan 误判为等待态）。
* 按整体 token 匹配（`\b` 不切分 snake_case），而非子串。
*/
function isUserQuestionTool(name) {
	const tokens = String(name || "").toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
	if (!tokens.length) return false;
	const asks = /* @__PURE__ */ new Set([
		"ask",
		"asking",
		"request",
		"requests",
		"requesting",
		"require",
		"requires",
		"prompt",
		"needs",
		"need",
		"seek",
		"seeks",
		"get",
		"gets"
	]);
	const filler = /* @__PURE__ */ new Set([
		"for",
		"from",
		"the",
		"a",
		"an"
	]);
	const userWords = /* @__PURE__ */ new Set([
		"user",
		"human",
		"me"
	]);
	const nouns = /* @__PURE__ */ new Set([
		"question",
		"questions",
		"input",
		"answer",
		"answers",
		"decision",
		"decisions",
		"confirmation",
		"approval",
		"permission",
		"authorization",
		"authorisation",
		"consent",
		"clarify",
		"clarification",
		"help"
	]);
	const hasUserNoun = tokens.some((token, index) => userWords.has(token) && nouns.has(tokens[index + 1] ?? ""));
	const hasNounFromUser = tokens.some((token, index) => nouns.has(token) && tokens[index + 1] === "from" && userWords.has(tokens[index + 2] ?? ""));
	const hasAsk = tokens.some((token, index) => {
		if (!asks.has(token)) return false;
		let cursor = index + 1;
		while (cursor < tokens.length && (filler.has(tokens[cursor]) || userWords.has(tokens[cursor]))) {
			if (userWords.has(tokens[cursor])) {
				const next = tokens[cursor + 1];
				return !next || nouns.has(next);
			}
			cursor += 1;
		}
		return cursor < tokens.length && nouns.has(tokens[cursor]);
	});
	const strong = tokens.some((token) => token === "authorize" || token === "authorise" || token === "consent");
	const submitsPlanForApproval = tokens.some((token, index) => token === "exit" && tokens[index + 1] === "plan" && tokens[index + 2] === "mode");
	return hasUserNoun || hasNounFromUser || hasAsk || strong || submitsPlanForApproval;
}
//#endregion
//#region src/host/session-stream.ts
/**
* host/session-stream.ts — 桌宠会话增量投影：订阅宿主会话总线 + 活体助手流帧，
* 经 reducer 投影成桌宠展示态后广播给所有已接入的 SSE 消费者。
*
* 与 apps/desktop `packages/builtin-plugin-pet/src/host/service/session-stream.ts` 同构；
* 差异只在**宿主接缝**：上游用 dsh-tauri 的 `defineService` / `watchArchive` /
* `getServerContext(server)` 取 ctx，本插件把 ctx 直接由 `attach(ctx)` 注入。
* reducer 与事件契约逐字保留（那才是「复刻」的部分）。
*
* 消费模型（性能约定）：**没有消费者就没有监听**。桌宠停用/隐藏后窗口会主动断开订阅，
* 宿主侧最后一个消费者断开时注销全部总线监听并丢弃累计态；下次有消费者接入再挂载。
*/
/** 会话总线 → 展示态帧的累计态机器（per-session Map 由 reducer 闭包持有）。 */
const reducer = createPetSessionReducer(publish);
/** 接入期解析出的宿主服务面（无消费者时清空，避免跨插件实例残留）。 */
let titleService;
let projections;
/** 当前插件 ctx（由 apply 注入；决定总线监听能否挂载）。 */
let hostContext;
/** 由 apply 调用：登记宿主 ctx（卸载时传 undefined）。 */
function attachHost(ctx) {
	hostContext = ctx;
}
const sessionStream = { 
/**
* 接入一个 SSE 消费者：登记后（首个消费者时）挂载会话总线监听。
*
* @param sink - 该连接的推送/关闭出口。
* @returns `detach`：断开该消费者的清理函数（幂等；最后一个消费者断开时注销总线监听并
*   丢弃累计态）；`stateLost`：本次接入前是否已无其他消费者——为真表示上一轮累计态已
*   随旧连接丢弃，调用方应据此告知消费者作废旧气泡。
*/
start(sink) {
	const stateLost = sinks.size === 0;
	sinks.add(sink);
	attachSessionBus();
	return {
		detach: () => {
			sinks.delete(sink);
			if (sinks.size > 0) return;
			closeSessionBus();
			reducer.clear();
		},
		stateLost
	};
} };
/** 把一帧增量广播给全部消费者（写失败由各自的关闭回调清理）。 */
function publish(action, payload) {
	const frame = JSON.stringify({
		action,
		payload
	});
	for (const sink of sinks) sink.push(frame);
}
/** 首个消费者接入：解析宿主服务面并挂载会话事件监听（幂等）。 */
function attachSessionBus() {
	if (isSessionBusAttached()) return;
	const ctx = hostContext;
	if (ctx === void 0) return;
	titleService = ctx.get?.("sessionTitle");
	projections = ctx.get?.("sessionProjections");
	const disposers = [];
	const bind = (event, handler) => {
		const dispose = ctx.on(event, handler);
		if (typeof dispose === "function") disposers.push(dispose);
	};
	bind("session/event", handleSessionEvent);
	bind("session/disposed", handleSessionDisposed);
	bind("agent/status", handleAgentStatus);
	bind("agent/assistant-stream", handleAssistantStream);
	bind("workspace/session-stop", ((payload) => {
		const id = String(payload?.sessionId ?? "");
		if (id) removeKnownSession(id);
	}));
	const archiveTimer = setInterval(() => {
		const archived = hostContext?.workspaceRegistry?.archivedSessionIds;
		if (!archived) return;
		for (const id of archived) if (knownSessions.has(id)) removeKnownSession(id);
	}, 3e4);
	archiveTimer.unref?.();
	disposers.push(() => clearInterval(archiveTimer));
	setSessionBusDispose(() => {
		for (const dispose of disposers) dispose();
		titleService = void 0;
		projections = void 0;
	});
}
/** 从宿主 session / 事件读取会话 id。 */
function sessionIdOf(session, event) {
	const s = session;
	if (typeof s?.id === "string") return s.id;
	if (typeof s?.sessionId === "string") return s.sessionId;
	return String(event.data?.sessionId ?? "");
}
/**
* 从宿主 session 对象读取的最小身份字段（运行时形状在此解耦，字段缺失即 undefined）。
*
* `foldTitle` 只在**会话首次出现**时传入：`sessionTitle.get()` 内部是整份会话事件日志
* O(N) 复制 + 扫描，跑在与流式转发同进程的发布路径上。若每次 `session/event`（含逐 token
* 的 assistant/chunk）都调用，宿主每 token 都要付这份 CPU 与垃圾；后续标题变化由 reducer
* 的 `session/title` 分支增量带入。
*/
function peerOf(session, event, foldTitle) {
	const s = session;
	const header = s?.header;
	const summary = s?.summary;
	const foldedTitle = foldTitle?.(session);
	return {
		id: sessionIdOf(session, event),
		origin: summary?.origin ?? header?.origin,
		title: summary?.title ?? s?.title ?? foldedTitle,
		displayTitle: summary?.displayTitle ?? s?.displayTitle ?? foldedTitle,
		cwd: summary?.cwd ?? header?.cwd ?? s?.cwd,
		running: typeof summary?.running === "boolean" ? summary.running : s?.running
	};
}
/** 把 bus 广播的事件归一化到 reducer 契约。 */
function asPetEvent(event) {
	const e = event;
	return {
		type: typeof e?.type === "string" ? e.type : "",
		seq: typeof e?.seq === "number" ? e.seq : 0,
		time: typeof e?.time === "number" ? e.time : 0,
		data: e?.data ?? {},
		surfaceOp: e?.surfaceOp
	};
}
/** O(新事件) 读取当前标题：注册表按水位线增量推进每个单元的折叠。 */
function projectedTitleOf(session) {
	if (projections === void 0) projections = hostContext?.get?.("sessionProjections");
	const title = projections?.stateOf?.(session, "title");
	return typeof title === "string" && title ? title : void 0;
}
/**
* 会话首次出现时的标题：优先投影；投影不可用（未装配 session-projection 或 key 未注册）
* 才退化为 `sessionTitle.get()` —— 后者是 O(整份会话日志) 的全量折叠，每个会话只允许一次。
*/
function titleOnFirstSight(session) {
	return projectedTitleOf(session) ?? titleService?.get?.(session)?.title;
}
function removeKnownSession(id) {
	if (knownSessions.delete(id)) reducer.remove(id);
}
function removeIfArchived(id) {
	if (!(hostContext?.workspaceRegistry?.archivedSessionIds)?.includes(id)) return false;
	removeKnownSession(id);
	return true;
}
function handleSessionEvent(session, event) {
	const petEvent = asPetEvent(event);
	const id = sessionIdOf(session, petEvent);
	if (!id || removeIfArchived(id)) return;
	const firstSight = !knownSessions.has(id);
	if (firstSight) knownSessions.add(id);
	const peer = firstSight ? peerOf(session, petEvent, titleOnFirstSight) : peerOf(session, petEvent, projectedTitleOf);
	if (firstSight) reducer.create(peer);
	reducer.apply(peer, petEvent);
}
function handleSessionDisposed(session) {
	const peer = peerOf(session, {
		type: "",
		seq: 0,
		time: 0,
		data: {}
	});
	if (!peer.id) return;
	knownSessions.delete(peer.id);
	reducer.remove(peer.id);
}
/**
* agent 空闲兜底（`agent/status → idle`）：把「回合已收尾」这个事实传给 reducer，
* 让核心漏发 `turn/end` 的中断（用户中止、被父级中断、异常收尾）也能回落空闲。
* 载荷形状来自核心的 agent-scoped 事件：`{ status, agent }`，会话 id 在 `agent.session.id`。
*/
function handleAgentStatus(payload) {
	const event = payload;
	const id = event?.agent?.session?.id;
	if (typeof id !== "string" || id.length === 0 || removeIfArchived(id)) return;
	if (event?.status === "idle") reducer.idle(id);
}
/** 帧路径的占位事件：只借它走同一套 id/peer 推导（流式帧本身不是会话事件）。 */
const FRAME_EVENT = {
	type: "",
	seq: 0,
	time: 0,
	data: {}
};
/**
* 活体助手流帧（`agent/assistant-stream`，载荷 `{ agent, frame }`）。
*
* `frame.type === 'chunk'` 时 `frame.chunk` 就是模型原始 StreamChunk
* （`reasoning-delta` / `text-delta` / …），直接喂给 reducer 的 `chunk()`。
*
* 【为什么必须订阅】逐 token 增量不是会话事件：只订阅 `session/event` 时 reasoning
* 恒为空，气泡在整个思考阶段只能显示兜底文案（「正在分析」）。
*/
function handleAssistantStream(payload) {
	const event = payload;
	const session = event?.agent?.session;
	const id = sessionIdOf(session, FRAME_EVENT);
	if (!id || removeIfArchived(id)) return;
	const chunk = event?.frame?.chunk;
	if (event?.frame?.type !== "chunk" || chunk === void 0 || chunk === null) return;
	if (!knownSessions.has(id)) {
		knownSessions.add(id);
		reducer.create(peerOf(session, FRAME_EVENT, titleOnFirstSight));
	}
	reducer.chunk({ id }, chunk);
}
//#endregion
//#region src/host/store.ts
/** `$DSH_HOME`（默认 `~/.dsh`），与 DSH 其余工具链一致。 */
function dshHome() {
	const configured = process.env.DSH_HOME?.trim();
	if (!configured) return join(homedir(), ".dsh");
	return configured === "~" ? homedir() : configured;
}
function storeFile() {
	return join(dshHome(), "pet-lite", "pet.json");
}
function clampSize(value) {
	const size = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(size)) return 100;
	return Math.round(Math.min(200, Math.max(50, size)));
}
/** 未知 id 收敛为首个内置预设（与 Rust `resolve_active_pet` 的兜底同义）。 */
function normalizeActiveId(value) {
	const id = typeof value === "string" ? value.trim() : "";
	if (!id) return "";
	return builtInCatalog().some((item) => item.id === id) ? id : id;
}
function defaults() {
	return {
		active_pet: builtInCatalog()[0]?.id ?? "",
		enabled: false,
		pet_size: 100,
		throw_enabled: false
	};
}
/** 读取持久设置；文件缺失或损坏时回落到默认值。 */
function readPersisted() {
	const file = storeFile();
	if (!existsSync(file)) return defaults();
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		const fallback = defaults();
		return {
			active_pet: raw.active_pet === void 0 ? fallback.active_pet : normalizeActiveId(raw.active_pet),
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
			pet_size: clampSize(raw.pet_size),
			throw_enabled: typeof raw.throw_enabled === "boolean" ? raw.throw_enabled : fallback.throw_enabled
		};
	} catch {
		return defaults();
	}
}
/** 原子写盘（临时文件 + rename）；失败只返回 false，调用方保持内存态。 */
function writePersisted(value) {
	const file = storeFile();
	try {
		mkdirSync(join(dshHome(), "pet-lite"), { recursive: true });
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
		renameSync(tmp, file);
		return true;
	} catch {
		return false;
	}
}
/** 内存态：进程内唯一真值，落盘失败也不回滚（下次写入会再试）。 */
let current;
function state() {
	if (current === void 0) current = readPersisted();
	return current;
}
/** 更新内存态并落盘；返回更新后的快照。 */
function update(patch) {
	const base = state();
	const next = {
		active_pet: patch.active_pet === void 0 ? base.active_pet : normalizeActiveId(patch.active_pet),
		enabled: patch.enabled === void 0 ? base.enabled : patch.enabled,
		pet_size: patch.pet_size === void 0 ? base.pet_size : clampSize(patch.pet_size),
		throw_enabled: patch.throw_enabled === void 0 ? base.throw_enabled : patch.throw_enabled
	};
	current = next;
	writePersisted(next);
	return next;
}
/**
* 推导对外快照（对应 Rust `PetStatus`）。
*
* `visible` 不是持久字段：无选择时必然不可见（没有内容可渲染，不留空窗口）。
*/
function snapshot(input) {
	const value = state();
	return {
		active_pet: value.active_pet,
		enabled: value.enabled,
		pet_size: value.pet_size,
		throw_enabled: value.throw_enabled,
		visible: value.enabled && value.active_pet !== "",
		desktop_supported: input.desktopSupported,
		desktop_open: input.desktopOpen
	};
}
//#endregion
//#region src/host/routes.ts
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store"
};
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		...JSON_HEADERS,
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
function sendText(res, status, body) {
	res.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** 读取请求体（带长度上限）。 */
async function readBody(req, limit = 1024 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > limit) throw new Error("PET_BODY_TOO_LARGE");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** 当前状态快照（每次请求实时读取，避免缓存跨实例残留）。 */
function runtimeStatus(ctx) {
	return snapshot({
		desktopSupported: ctx.desktopSupported,
		desktopOpen: ctx.desktopOpen
	});
}
/** 一次拿齐三份清单 + 状态（对应上游 `loadPetCatalog` 的四个命令聚合）。 */
function catalog(ctx) {
	return {
		presetPets: builtInCatalog(),
		chatPets: [],
		codexPets: [],
		status: runtimeStatus(ctx)
	};
}
const settingsRoute = {
	method: "GET",
	path: `${ROUTE_PREFIX}${SETTINGS_PATH}`,
	handle(_req, res, _url, ctx) {
		sendJson(res, 200, runtimeStatus(ctx));
	}
};
const catalogRoute = {
	method: "GET",
	path: `${ROUTE_PREFIX}${CATALOG_PATH}`,
	handle(_req, res, _url, ctx) {
		sendJson(res, 200, catalog(ctx));
	}
};
/**
* PUT /settings — 更新选择 / 启用 / 大小 / 抛射，并同步桌面窗口的开关。
*
* 与上游一致：命令回吐**权威状态**，前端不做乐观本地副本。
*/
const patchRoute = {
	method: "PUT",
	path: `${ROUTE_PREFIX}${SETTINGS_PATH}`,
	async handle(req, res, _url, ctx) {
		let patch;
		try {
			patch = JSON.parse(await readBody(req));
		} catch {
			sendText(res, 400, "PET_BAD_REQUEST: body must be JSON");
			return;
		}
		if (patch === null || typeof patch !== "object") {
			sendText(res, 400, "PET_BAD_REQUEST: body must be an object");
			return;
		}
		const next = update({
			active_pet: patch.active_pet,
			enabled: patch.enabled,
			pet_size: patch.pet_size,
			throw_enabled: patch.throw_enabled
		});
		try {
			await syncDesktop(ctx, next.enabled && next.active_pet !== "");
		} catch {}
		sendJson(res, 200, runtimeStatus(ctx));
	}
};
/** 把桌面窗口对齐到「该不该在」。 */
async function syncDesktop(ctx, shouldOpen) {
	if (!ctx.desktopSupported) return;
	if (shouldOpen === ctx.desktopOpen) return;
	await ctx.setDesktop(shouldOpen);
}
const routes = [
	settingsRoute,
	catalogRoute,
	patchRoute,
	{
		method: "GET",
		path: `${ROUTE_PREFIX}/asset`,
		handle(_req, res, url) {
			const id = url.searchParams.get("id") ?? "";
			const item = builtInCatalog().find((entry) => entry.id === id);
			if (!item) {
				sendText(res, 404, `PET_NOT_FOUND: ${id}`);
				return;
			}
			sendJson(res, 200, presetAsset(item));
		}
	},
	{
		method: "GET",
		path: `${ROUTE_PREFIX}/config`,
		async handle(_req, res, url) {
			const id = url.searchParams.get("id") ?? "";
			const item = builtInCatalog().find((entry) => entry.id === id);
			if (!item) {
				sendText(res, 404, `PET_NOT_FOUND: ${id}`);
				return;
			}
			try {
				const response = await fetch(item.config, { signal: AbortSignal.timeout(15e3) });
				if (!response.ok) {
					sendText(res, 502, `PET_CONFIG_FETCH_FAILED: ${response.status}`);
					return;
				}
				const text = await response.text();
				sendJson(res, 200, {
					id: item.id,
					url: item.config,
					body: text
				});
			} catch (error) {
				sendText(res, 502, `PET_CONFIG_FETCH_FAILED: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	},
	{
		method: "GET",
		path: `${ROUTE_PREFIX}${SESSION_STREAM_PATH}`,
		handle(req, res) {
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-store, no-transform",
				"connection": "keep-alive",
				"x-accel-buffering": "no"
			});
			res.write(": keepalive\n\n");
			let retrySent = false;
			let closed = false;
			let keepalive;
			let detach;
			const finish = () => {
				if (closed) return;
				closed = true;
				if (keepalive !== void 0) {
					clearInterval(keepalive);
					keepalive = void 0;
				}
				detach?.();
				detach = void 0;
			};
			const { detach: release, stateLost } = sessionStream.start({
				push(frame) {
					if (closed) return;
					if (retrySent) {
						res.write(`data: ${frame}\n\n`);
						return;
					}
					retrySent = true;
					res.write(`retry: 1000\ndata: ${frame}\n\n`);
				},
				close() {
					finish();
					res.end();
				}
			});
			detach = release;
			if (stateLost) res.write(": state-lost\n\n");
			keepalive = setInterval(() => {
				if (!closed) res.write(": keepalive\n\n");
			}, SSE_KEEPALIVE_MS);
			keepalive.unref?.();
			req.on("close", finish);
			res.on("close", finish);
			res.on("error", finish);
		}
	}
];
/** 逐条匹配：方法 + 绝对路径。 */
function matchRoute(method, pathname) {
	return routes.find((route) => route.method === method && route.path === pathname);
}
/** 未匹配到任何路由时的统一 404 文案。 */
function notFound(res, pathname) {
	sendText(res, 404, `PET_NOT_FOUND: ${pathname}`);
}
//#endregion
//#region src/index.ts
/**
* 宿主半侧（host half）—— 插件后端。
*
* 与 apps/desktop `packages/builtin-plugin-pet/src/index.ts` 同一套职责：
*   - 在宿主 WebServer 上注册 `${ROUTE_PREFIX}/*` 业务路由（设置 / 清单 / 素材 / SSE）；
*   - 把「会话活动」状态化重建后经 SSE 发布给消费端；
*   - 按需拉起 / 守护 Electron 桌宠窗口。
*
* 差异：上游把窗口开合交给 Rust（Tauri `invoke` 命令），本插件自己拉起 Electron 进程。
*/
/** 需要的宿主服务：webServer（路由）、sessions（会话总线）、workspaceRegistry（归档集合）。 */
const inject = [
	"webServer",
	"sessions",
	"workspaceRegistry"
];
const name = PLUGIN_ID;
function apply(ctx) {
	attachHost(ctx);
	let helper;
	let desktopOpen = false;
	/** 当前环境能否真的开一个独立窗口（纯浏览器访问时为 false）。 */
	const desktopSupported = () => hasGraphicalDisplay() && resolveElectronPath() !== void 0;
	const openDesktop = async () => {
		if (desktopOpen) return;
		if (!desktopSupported()) throw new Error("PET_DESKTOP_UNAVAILABLE: no usable Electron runtime");
		const port = ctx.webServer.port ?? 0;
		if (!port || port <= 0) throw new Error("PET_WEB_PORT_UNAVAILABLE: web server is not listening yet");
		const electronPath = resolveElectronPath();
		if (!electronPath) throw new Error("PET_DESKTOP_UNAVAILABLE: no usable Electron runtime");
		const process_ = new HelperProcess({
			electronPath,
			env: {
				DSH_PET_LITE_ORIGIN: `http://127.0.0.1:${port}`,
				DSH_PET_LITE_CONFIG_URL: `http://127.0.0.1:${port}${ROUTE_PREFIX}/catalog`
			}
		}, {
			debug: (message) => ctx.logger?.debug?.(message),
			error: (message) => ctx.logger?.error?.(message),
			info: (message) => ctx.logger?.info?.(message),
			warn: (message) => ctx.logger?.warn?.(message)
		});
		process_.start();
		helper = process_;
		desktopOpen = true;
	};
	const closeDesktop = async () => {
		if (!desktopOpen) return;
		helper?.stop("settings-change");
		helper = void 0;
		desktopOpen = false;
	};
	const routeContext = {
		get desktopSupported() {
			return desktopSupported();
		},
		get desktopOpen() {
			return desktopOpen;
		},
		setDesktop: async (open) => {
			if (open) await openDesktop();
			else await closeDesktop();
		}
	};
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "prefix",
			path: ROUTE_PREFIX,
			handler: async (req, res) => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				const route = matchRoute(req.method ?? "GET", url.pathname);
				if (!route) {
					notFound(res, url.pathname);
					return;
				}
				try {
					await route.handle(req, res, url, routeContext);
				} catch (error) {
					if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
					res.end(`PET_ROUTE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		});
		return () => {
			dispose();
			attachHost(void 0);
			closeDesktop();
			helper = void 0;
		};
	}, `${PLUGIN_ID}: routes`);
	ctx.effect(() => {
		const status = snapshot({
			desktopSupported: desktopSupported(),
			desktopOpen: false
		});
		if (status.enabled && status.active_pet !== "" && status.desktop_supported) openDesktop().catch((error) => {
			ctx.logger?.warn?.(`dsh-pet-lite: desktop window not opened: ${error instanceof Error ? error.message : String(error)}`);
		});
		return () => {
			closeDesktop();
		};
	}, `${PLUGIN_ID}: desktop lifecycle`);
}
//#endregion
export { apply, inject, name };
