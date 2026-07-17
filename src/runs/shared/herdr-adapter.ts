import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import type { ChildLaunchRequest, TerminalHandle } from "./process-backend.ts";
import type { HerdrPlacement, TerminalSplitDirection } from "../../shared/types.ts";

const execFileAsync = promisify(execFile);
const WORKSPACE_ID = /^w[1-9][0-9]*$/;
const TAB_ID = /^w[1-9][0-9]*:t[1-9][0-9]*$/;
const PANE_ID = /^w[1-9][0-9]*:p[1-9][0-9]*$/;
const TERMINAL_ID = /^term_[A-Za-z0-9_-]+$/;
const HERDR_PROTOCOL = 16;
const HERDR_VERSION = "0.7.4";
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_LABEL_CHARS = 48;

export type HerdrTerminalHandle = TerminalHandle;

export interface HerdrAdapterOptions {
	executable?: string;
	baseArgs?: string[];
	timeoutMs?: number;
	maxOutputBytes?: number;
	env?: NodeJS.ProcessEnv;
}

export interface HerdrProbeResult {
	protocol: 16;
	version: "0.7.4";
	schemaVersion: 1;
}

export interface HerdrPlacementRequest {
	placement: HerdrPlacement;
	splitDirection?: TerminalSplitDirection;
}

export interface HerdrPaneInspection {
	workspaceId: string;
	tabId: string;
	paneId: string;
	terminalId?: string;
	title?: string;
}

export interface HerdrCloseResult {
	closed: boolean;
	reason?: string;
}

export interface HerdrFallbackState {
	mutationStarted: boolean;
	mutationSucceeded: boolean;
	error: Error;
}

interface CommandResult {
	stdout: string;
	stderr: string;
}

interface OwnedHandle {
	backend: "herdr";
	workspaceId: string;
	tabId: string;
	paneId: string;
	terminalId?: string;
	ownsWorkspace: boolean;
	ownsTab: boolean;
	ownsPane: boolean;
}

export class HerdrAdapterError extends Error {
	readonly fallbackEligible: boolean;
	readonly mutationStarted: boolean;
	readonly mutationSucceeded: boolean;

	constructor(message: string, options: { fallbackEligible: boolean; mutationStarted?: boolean; mutationSucceeded?: boolean; cause?: unknown }) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "HerdrAdapterError";
		this.fallbackEligible = options.fallbackEligible;
		this.mutationStarted = options.mutationStarted ?? !options.fallbackEligible;
		this.mutationSucceeded = options.mutationSucceeded ?? false;
	}
}

function actionableError(message: string, cause?: unknown): Error {
	return cause instanceof Error ? new Error(`${message}: ${cause.message}`) : new Error(message);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}

function parseJson(text: string, label: string): Record<string, unknown> {
	try {
		return asObject(JSON.parse(text), label);
	} catch (error) {
		throw actionableError(`Herdr ${label} returned invalid JSON`, error);
	}
}

function stringField(payload: Record<string, unknown>, key: string, pattern: RegExp, label: string, required = true): string | undefined {
	const value = payload[key];
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || !pattern.test(value)) {
		throw new Error(`invalid Herdr ${label} response: ${key}`);
	}
	return value;
}

function assertNoNul(value: string, label: string): void {
	if (value.includes("\0")) throw new Error(`${label} must not contain NUL bytes`);
}

export function sanitizeHerdrLabel(label: string, fallback = "subagent"): string {
	const clean = label.replace(/[\r\n	]+/g, " ").replace(/\s+/g, " ").replace(/[\0]/g, "").trim();
	if (/^(run|session|task)-[A-Za-z0-9_-]+$/.test(clean)) return fallback;
	const bounded = (clean || fallback).slice(0, MAX_LABEL_CHARS).trim();
	return bounded || fallback;
}

export function isHerdrFallbackEligible(state: HerdrFallbackState): boolean {
	return !state.mutationStarted && !state.mutationSucceeded;
}

export class HerdrAdapter {
	private readonly executable: string;
	private readonly baseArgs: string[];
	private readonly timeoutMs: number;
	private readonly maxOutputBytes: number;
	private readonly env: NodeJS.ProcessEnv;
	private readonly ownedHandles = new WeakMap<HerdrTerminalHandle, Readonly<OwnedHandle>>();

	constructor(options: HerdrAdapterOptions = {}) {
		this.executable = options.executable ?? "herdr";
		this.baseArgs = options.baseArgs ?? [];
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		this.env = options.env ?? process.env;
	}

	async probe(): Promise<HerdrProbeResult> {
		await this.assertExecutableAvailable();
		const schema = parseJson((await this.run(["api", "schema", "--json"])).stdout, "schema");
		if (schema.protocol !== HERDR_PROTOCOL) {
			throw new Error(`Herdr incompatible protocol: expected protocol ${HERDR_PROTOCOL}`);
		}
		if (schema.schema_version !== 1) {
			throw new Error("Herdr incompatible schema_version: expected 1");
		}
		const schemaRecords = schema.schemas && typeof schema.schemas === "object" && !Array.isArray(schema.schemas)
			? schema.schemas as Record<string, unknown>
			: schema;
		for (const key of ["request", "event"]) {
			if (!schemaRecords[key] || typeof schemaRecords[key] !== "object") throw new Error(`Herdr schema missing ${key}`);
		}
		if ((!schemaRecords.response || typeof schemaRecords.response !== "object") && (!schemaRecords.success_response || typeof schemaRecords.success_response !== "object")) {
			throw new Error("Herdr schema missing response");
		}
		const version = schema.version ?? (/herdr\s+(\S+)/i.exec((await this.run(["--version"])).stdout)?.[1]);
		if (version !== HERDR_VERSION) {
			throw new Error(`Herdr incompatible version: expected Herdr v${HERDR_VERSION}`);
		}
		return { protocol: HERDR_PROTOCOL, version: HERDR_VERSION, schemaVersion: 1 };
	}

	async resolvePlacement(request: HerdrPlacementRequest): Promise<{ workspaceId: string; tabId: string; paneId: string }> {
		await this.probe();
		const snapshot = parseJson((await this.run(["api", "snapshot"])).stdout, "snapshot");
		const activePane = this.activePane(snapshot);
		if (!activePane) {
			throw new Error("Unable to resolve Herdr parent placement; parent is outside Herdr");
		}
		if (request.placement === "pane") {
			throw new Error("Herdr pane placement is not implemented before the mutation slice; refusing to ignore split direction");
		}
		return { workspaceId: activePane.workspaceId, tabId: activePane.tabId, paneId: activePane.paneId };
	}

	async startChild(request: ChildLaunchRequest): Promise<HerdrTerminalHandle> {
		this.validateLaunch(request);
		try {
			await this.probe();
		} catch (error) {
			throw this.toAdapterError(error, false);
		}
		const label = sanitizeHerdrLabel(request.label, "subagent");
		const argv = ["agent", "start", label, ...(request.parentWorkspaceId ? ["--workspace", request.parentWorkspaceId] : []), "--cwd", request.cwd, "--no-focus", "--", request.command, ...request.args];
		let payload: Record<string, unknown>;
		try {
			payload = parseJson((await this.run(argv, { cwd: request.cwd, env: request.env })).stdout, "start");
			if (payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)) {
				const result = payload.result as Record<string, unknown>;
				if (result.agent && typeof result.agent === "object" && !Array.isArray(result.agent)) {
					payload = result.agent as Record<string, unknown>;
				}
			}
			const workspaceId = stringField(payload, "workspace_id", WORKSPACE_ID, "start")!;
			const tabId = stringField(payload, "tab_id", TAB_ID, "start")!;
			const paneId = stringField(payload, "pane_id", PANE_ID, "start")!;
			const terminalId = stringField(payload, "terminal_id", TERMINAL_ID, "start", false);
			this.validateAncestry({ workspaceId, tabId, paneId });
			if (request.parentWorkspaceId && workspaceId !== request.parentWorkspaceId) {
				throw new Error("invalid Herdr start response: did not land in requested workspace");
			}
			const handle: HerdrTerminalHandle = Object.freeze({
				backend: "herdr",
				workspaceId,
				tabId,
				paneId,
				...(terminalId ? { terminalId } : {}),
				ownsWorkspace: false,
				ownsTab: true,
				ownsPane: true,
			});
			this.ownedHandles.set(handle, Object.freeze({ backend: "herdr", workspaceId, tabId, paneId, terminalId, ownsWorkspace: false, ownsTab: true, ownsPane: true }));
			return handle;
		} catch (error) {
			throw this.toAdapterError(error, true);
		}
	}

	async inspect(handle: HerdrTerminalHandle): Promise<HerdrPaneInspection> {
		this.validateHandle(handle);
		const payload = parseJson((await this.run(["pane", "inspect", handle.paneId])).stdout, "inspect");
		const workspaceId = stringField(payload, "workspace_id", WORKSPACE_ID, "inspect")!;
		const tabId = stringField(payload, "tab_id", TAB_ID, "inspect")!;
		const paneId = stringField(payload, "pane_id", PANE_ID, "inspect")!;
		const terminalId = stringField(payload, "terminal_id", TERMINAL_ID, "inspect", false);
		const title = typeof payload.title === "string" ? payload.title : undefined;
		return { workspaceId, tabId, paneId, ...(terminalId ? { terminalId } : {}), ...(title ? { title } : {}) };
	}

	async readDisplay(handle: HerdrTerminalHandle): Promise<string> {
		this.validateHandle(handle);
		const payload = parseJson((await this.run(["pane", "read", handle.paneId])).stdout, "read");
		if (typeof payload.text !== "string") throw new Error("invalid Herdr read response: text");
		return payload.text;
	}

	async close(handle: HerdrTerminalHandle): Promise<HerdrCloseResult> {
		this.validateHandle(handle);
		const owned = this.ownedHandles.get(handle);
		if (!owned) throw new Error("invalid Herdr handle: not owned by this HerdrAdapter instance or exact handle object");
		if (handle.backend !== owned.backend || handle.workspaceId !== owned.workspaceId || handle.tabId !== owned.tabId || handle.paneId !== owned.paneId || handle.terminalId !== owned.terminalId) {
			throw new Error("invalid Herdr handle: handle identity was mutated after start");
		}
		if (handle.ownsWorkspace !== owned.ownsWorkspace || handle.ownsTab !== owned.ownsTab || handle.ownsPane !== owned.ownsPane) {
			throw new Error("invalid Herdr handle: handle ownership was mutated after start");
		}
		if (!owned.ownsPane && !owned.ownsTab && !owned.ownsWorkspace) {
			return { closed: false, reason: "not adapter-owned" };
		}
		if (owned.ownsWorkspace && (owned.ownsTab || owned.ownsPane)) {
			throw new Error("invalid Herdr handle: workspace ownership cannot be mixed with tab or pane ownership");
		}
		const verb = owned.ownsPane ? "pane" : owned.ownsTab ? "tab" : "workspace";
		const target = owned.ownsPane ? owned.paneId : owned.ownsTab ? owned.tabId : owned.workspaceId;
		const payload = parseJson((await this.run([verb, "close", target])).stdout, "close");
		if (typeof payload.closed !== "boolean") throw new Error("invalid Herdr close response: closed");
		return { closed: payload.closed };
	}

	private toAdapterError(error: unknown, mutationStarted: boolean): HerdrAdapterError {
		if (error instanceof HerdrAdapterError) return error;
		const message = error instanceof Error ? error.message : String(error);
		return new HerdrAdapterError(message, {
			fallbackEligible: !mutationStarted,
			mutationStarted,
			mutationSucceeded: false,
			cause: error,
		});
	}

	private async assertExecutableAvailable(): Promise<void> {
		if (this.executable.includes("/") && !fs.existsSync(this.executable)) {
			throw new Error(`Herdr executable not found: ${this.executable}`);
		}
	}

	private async run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
		try {
			const result = await execFileAsync(this.executable, [...this.baseArgs, ...args], {
				cwd: options.cwd,
				env: options.env ?? this.env,
				timeout: this.timeoutMs,
				maxBuffer: this.maxOutputBytes,
				windowsHide: true,
				shell: false,
			});
			return { stdout: String(result.stdout), stderr: String(result.stderr) };
		} catch (error) {
			const execError = error as ExecFileException & { stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean };
			const stderr = String(execError.stderr ?? "").trim();
			if (execError.killed || execError.signal === "SIGTERM") {
				throw new Error(`Herdr CLI timed out after ${this.timeoutMs}ms`);
			}
			if (/server.*not running|not running/i.test(stderr)) {
				throw new Error(`Herdr server is not running: ${stderr}`);
			}
			throw actionableError(`Herdr CLI failed${stderr ? `: ${stderr}` : ""}`, error);
		}
	}

	private validateLaunch(request: ChildLaunchRequest): void {
		assertNoNul(request.command, "command");
		assertNoNul(request.cwd, "cwd");
		assertNoNul(request.label, "label");
		if (request.parentWorkspaceId) {
			assertNoNul(request.parentWorkspaceId, "parentWorkspaceId");
			if (!WORKSPACE_ID.test(request.parentWorkspaceId)) throw new Error("invalid Herdr launch request: parentWorkspaceId");
		}
		for (const arg of request.args) assertNoNul(arg, "arg");
		for (const [key, value] of Object.entries(request.env)) {
			assertNoNul(key, "env key");
			assertNoNul(String(value), `env.${key}`);
		}
	}

	private validateHandle(handle: HerdrTerminalHandle): void {
		if (handle.backend !== "herdr") throw new Error("invalid Herdr handle: backend");
		if (!WORKSPACE_ID.test(handle.workspaceId)) throw new Error("invalid Herdr handle: workspaceId");
		if (!TAB_ID.test(handle.tabId)) throw new Error("invalid Herdr handle: tabId");
		if (!PANE_ID.test(handle.paneId)) throw new Error("invalid Herdr handle: paneId");
		if (handle.terminalId && !TERMINAL_ID.test(handle.terminalId)) throw new Error("invalid Herdr handle: terminalId");
		this.validateAncestry(handle);
	}

	private validateAncestry(handle: { workspaceId: string; tabId: string; paneId: string }): void {
		if (!handle.tabId.startsWith(`${handle.workspaceId}:`) || !handle.paneId.startsWith(`${handle.workspaceId}:`)) {
			throw new Error("invalid Herdr handle ancestry: workspaceId must match tabId and paneId");
		}
	}

	private activePane(snapshot: Record<string, unknown>): { workspaceId: string; tabId: string; paneId: string } | null {
		const workspaces = Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [];
		for (const workspaceRaw of workspaces) {
			const workspace = asObject(workspaceRaw, "workspace");
			const workspaceId = typeof workspace.id === "string" && WORKSPACE_ID.test(workspace.id) ? workspace.id : undefined;
			const tabs = Array.isArray(workspace.tabs) ? workspace.tabs : [];
			for (const tabRaw of tabs) {
				const tab = asObject(tabRaw, "tab");
				const tabId = typeof tab.id === "string" && TAB_ID.test(tab.id) ? tab.id : undefined;
				const panes = Array.isArray(tab.panes) ? tab.panes : [];
				for (const paneRaw of panes) {
					const pane = asObject(paneRaw, "pane");
					const paneId = typeof pane.id === "string" && PANE_ID.test(pane.id) ? pane.id : undefined;
					if (workspaceId && tabId && paneId && pane.active === true) return { workspaceId, tabId, paneId };
				}
			}
		}
		return null;
	}
}
