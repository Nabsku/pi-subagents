import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ChildLaunchRequest, TerminalHandle } from "./process-backend.ts";
import type { HerdrPlacement, TerminalSplitDirection } from "../../shared/types.ts";


const execFileAsync = promisify(execFile);
const WORKSPACE_ID = /^w[1-9][0-9]*$/;
const TAB_ID = /^w[1-9][0-9]*:t[1-9A-Za-z][0-9A-Za-z]*$/;
const PANE_ID = /^w[1-9][0-9]*:p[1-9A-Za-z][0-9A-Za-z]*$/;
const TERMINAL_ID = /^term_[A-Za-z0-9_-]+$/;
const HERDR_PROTOCOL = 17;
const HERDR_MIN_VERSION = "0.7.4";
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
	protocol: 17;
	version: string;
	schemaVersion: 1;
}

export interface HerdrPlacementRequest {
	placement: HerdrPlacement;
	splitDirection?: TerminalSplitDirection;
	parentWorkspaceId?: string;
	parentTabId?: string;
	parentPaneId?: string;
	parentTerminalId?: string;
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

function shellQuote(value: string): string {
	assertNoNul(value, "command argument");
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseSemverCore(value: string): [number, number, number] | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSupportedHerdrVersion(version: string): boolean {
	const actual = parseSemverCore(version);
	const minimum = parseSemverCore(HERDR_MIN_VERSION)!;
	if (!actual) return false;
	for (let index = 0; index < 3; index++) {
		if (actual[index]! > minimum[index]!) return true;
		if (actual[index]! < minimum[index]!) return false;
	}
	return true;
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
		this.env = options.env ?? process.env;
		this.executable = options.executable ?? this.env.HERDR_BIN_PATH ?? "herdr";
		this.baseArgs = options.baseArgs ?? [];
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
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
		if (typeof version !== "string" || !isSupportedHerdrVersion(version)) {
			throw new Error(`Herdr incompatible version: requires Herdr >=${HERDR_MIN_VERSION}; found ${String(version ?? "unknown")}`);
		}
		return { protocol: HERDR_PROTOCOL, version, schemaVersion: 1 };
	}

	async resolvePlacement(request: HerdrPlacementRequest): Promise<{ workspaceId: string; tabId: string; paneId: string }> {
		await this.probe();
		const explicit = this.explicitParent(request);
		if (explicit) return explicit;
		let snapshot = parseJson((await this.run(["api", "snapshot"])).stdout, "snapshot");
		if (snapshot.result && typeof snapshot.result === "object" && !Array.isArray(snapshot.result)) {
			const result = snapshot.result as Record<string, unknown>;
			if (result.snapshot && typeof result.snapshot === "object" && !Array.isArray(result.snapshot)) snapshot = result.snapshot as Record<string, unknown>;
		}
		const activePane = this.activePane(snapshot);
		if (!activePane) {
			throw new Error("Unable to resolve Herdr parent placement; parent is outside Herdr");
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
		let ownedTabId: string | undefined;
		let ownedPaneId: string | undefined;
		try {
			const requestedPlacement = request.placement ?? "tab";
			const placement = await this.resolvePlacement({
				placement: requestedPlacement,
				parentWorkspaceId: request.parentWorkspaceId,
				parentTabId: request.parentTabId,
				parentPaneId: request.parentPaneId,
				parentTerminalId: request.parentTerminalId,
			});
			const requestedWorkspaceId = request.parentWorkspaceId ?? placement.workspaceId;
			if (requestedPlacement === "pane" && requestedWorkspaceId !== placement.workspaceId) {
				throw new Error("Herdr pane placement cannot target a different workspace");
			}
			const shellEnvArgs = ["--env", `ZDOTDIR=${os.tmpdir()}`, "--env", "HISTFILE=/dev/null", "--env", "GHOSTTY_BIN_DIR=", "--env", "ZELLIJ=herdr-child"];
			const focusArg = request.focus ? "--focus" : "--no-focus";
			let payload: Record<string, unknown>;
			if (requestedPlacement === "pane") {
				payload = parseJson((await this.run([
					"pane", "split", placement.paneId,
					"--direction", request.splitDirection ?? "right",
					"--cwd", request.cwd, ...shellEnvArgs, focusArg,
				], { cwd: request.cwd, env: request.env })).stdout, "split");
				if (payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)) {
					const result = payload.result as Record<string, unknown>;
					if (result.pane && typeof result.pane === "object" && !Array.isArray(result.pane)) payload = result.pane as Record<string, unknown>;
				}
			} else {
				payload = parseJson((await this.run([
					"tab", "create", "--workspace", requestedWorkspaceId,
					"--cwd", request.cwd, ...shellEnvArgs, "--label", label, focusArg,
				], { cwd: request.cwd, env: request.env })).stdout, "start");
				if (payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)) {
					const result = payload.result as Record<string, unknown>;
					if (result.root_pane && typeof result.root_pane === "object" && !Array.isArray(result.root_pane)) payload = result.root_pane as Record<string, unknown>;
				}
			}
			const workspaceId = stringField(payload, "workspace_id", WORKSPACE_ID, "start")!;
			const tabId = stringField(payload, "tab_id", TAB_ID, "start")!;
			const paneId = stringField(payload, "pane_id", PANE_ID, "start")!;
			const terminalId = stringField(payload, "terminal_id", TERMINAL_ID, "start", false);
			this.validateAncestry({ workspaceId, tabId, paneId });
			if (workspaceId !== requestedWorkspaceId) throw new Error("invalid Herdr start response: did not land in requested workspace");
			if (requestedPlacement === "pane" && tabId !== placement.tabId) throw new Error("invalid Herdr split response: did not land in parent tab");
			if (requestedPlacement === "pane") ownedPaneId = paneId;
			else ownedTabId = tabId;
			const commandText = `printf '\\033[2J\\033[H'; exec ${[request.command, ...request.args].map(shellQuote).join(" ")}`;
			await this.waitForPaneShell(paneId);
			await this.run(["pane", "run", paneId, commandText], { cwd: request.cwd, env: request.env });
			const ownsTab = requestedPlacement === "tab";
			const handle: HerdrTerminalHandle = Object.freeze({
				backend: "herdr", workspaceId, tabId, paneId,
				...(terminalId ? { terminalId } : {}),
				ownsWorkspace: false, ownsTab, ownsPane: !ownsTab,
			});
			this.ownedHandles.set(handle, Object.freeze({ backend: "herdr", workspaceId, tabId, paneId, terminalId, ownsWorkspace: false, ownsTab, ownsPane: !ownsTab }));
			return handle;
		} catch (error) {
			if (ownedPaneId) await this.run(["pane", "close", ownedPaneId]).catch(() => {});
			else if (ownedTabId) await this.run(["tab", "close", ownedTabId]).catch(() => {});
			throw this.toAdapterError(error, true);
		}
	}

	async startPluginChild(request: ChildLaunchRequest): Promise<HerdrTerminalHandle> {
		this.validateLaunch(request);
		if (!request.pluginLaunchFile || !path.isAbsolute(request.pluginLaunchFile)) throw new Error("invalid Herdr plugin launch descriptor path");
		let ownedPaneId: string | undefined;
		let ownedTabId: string | undefined;
		try {
			await this.probe();
			const placement = await this.resolvePlacement({
				placement: request.placement ?? "tab",
				parentWorkspaceId: request.parentWorkspaceId,
				parentTabId: request.parentTabId,
				parentPaneId: request.parentPaneId,
				parentTerminalId: request.parentTerminalId,
			});
			const argv = [
				"plugin", "pane", "open",
				"--plugin", "pi-subagents.herdr",
				"--entrypoint", "subagent",
				"--placement", request.placement === "pane" ? "split" : "tab",
				"--cwd", request.cwd,
				"--env", `PI_SUBAGENTS_LAUNCH_FILE=${request.pluginLaunchFile}`,
			];
			if (request.placement === "pane") argv.push("--target-pane", placement.paneId, "--direction", request.splitDirection ?? "right");
			else argv.push("--workspace", request.parentWorkspaceId ?? placement.workspaceId);
			argv.push(request.focus ? "--focus" : "--no-focus");
			let payload = parseJson((await this.run(argv, { cwd: request.cwd, env: request.env })).stdout, "plugin pane open");
			if (payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)) payload = payload.result as Record<string, unknown>;
			if (payload.plugin_pane && typeof payload.plugin_pane === "object" && !Array.isArray(payload.plugin_pane)) payload = payload.plugin_pane as Record<string, unknown>;
			if (payload.pane && typeof payload.pane === "object" && !Array.isArray(payload.pane)) payload = payload.pane as Record<string, unknown>;
			const workspaceId = stringField(payload, "workspace_id", WORKSPACE_ID, "plugin pane open")!;
			const tabId = stringField(payload, "tab_id", TAB_ID, "plugin pane open")!;
			const paneId = stringField(payload, "pane_id", PANE_ID, "plugin pane open")!;
			const terminalId = stringField(payload, "terminal_id", TERMINAL_ID, "plugin pane open", false);
			this.validateAncestry({ workspaceId, tabId, paneId });
			if (workspaceId !== placement.workspaceId) throw new Error("invalid Herdr plugin pane response: did not land in parent workspace");
			if (request.placement === "pane" && (workspaceId !== placement.workspaceId || tabId !== placement.tabId)) throw new Error("invalid Herdr plugin split response: did not land in parent tab");
			ownedPaneId = paneId;
			const ownsTab = request.placement !== "pane";
			if (ownsTab) { ownedTabId = tabId; ownedPaneId = undefined; }
			const handle: HerdrTerminalHandle = Object.freeze({ backend: "herdr", workspaceId, tabId, paneId, ...(terminalId ? { terminalId } : {}), ownsWorkspace: false, ownsTab, ownsPane: !ownsTab });
			this.ownedHandles.set(handle, handle);
			return handle;
		} catch (error) {
			if (ownedPaneId) await this.run(["pane", "close", ownedPaneId]).catch(() => {});
			else if (ownedTabId) await this.run(["tab", "close", ownedTabId]).catch(() => {});
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
		return this.closeOwnedSnapshot(owned);
	}


	private async closeOwnedSnapshot(owned: Readonly<OwnedHandle>): Promise<HerdrCloseResult> {
		const verb = owned.ownsPane ? "pane" : owned.ownsTab ? "tab" : "workspace";
		const target = owned.ownsPane ? owned.paneId : owned.ownsTab ? owned.tabId : owned.workspaceId;
		try {
			let payload = parseJson((await this.run([verb, "close", target])).stdout, "close");
			if (payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)) payload = payload.result as Record<string, unknown>;
			if (payload.type === "ok") return { closed: true };
			if (typeof payload.closed !== "boolean") throw new Error("invalid Herdr close response: closed");
			return { closed: payload.closed };
		} catch (error) {
			if (/(?:pane|tab)_not_found|(?:pane|tab) .* not found/i.test(error instanceof Error ? error.message : String(error))) return { closed: true };
			throw error;
		}
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

	private async waitForPaneShell(paneId: string): Promise<void> {
		// Herdr reports tab creation before the interactive login shell has finished
		// running startup hooks. Commands sent during that window can be consumed by
		// those hooks instead of the shell prompt.
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		const deadline = Date.now() + 2_500;
		let stableShellPolls = 0;
		while (Date.now() < deadline) {
			try {
				const payload = parseJson((await this.run(["pane", "process-info", "--pane", paneId])).stdout, "process-info");
				const result = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result) ? payload.result as Record<string, unknown> : payload;
				const info = result.process_info && typeof result.process_info === "object" && !Array.isArray(result.process_info) ? result.process_info as Record<string, unknown> : result;
				stableShellPolls = typeof info.shell_pid === "number" && info.foreground_process_group_id === info.shell_pid ? stableShellPolls + 1 : 0;
				if (stableShellPolls >= 3) return;
			} catch {
				stableShellPolls = 0;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("Herdr pane shell readiness timed out");
	}

	private validateLaunch(request: ChildLaunchRequest): void {
		assertNoNul(request.command, "command");
		assertNoNul(request.cwd, "cwd");
		assertNoNul(request.label, "label");
		if (request.parentWorkspaceId) {
			assertNoNul(request.parentWorkspaceId, "parentWorkspaceId");
			if (!WORKSPACE_ID.test(request.parentWorkspaceId)) throw new Error("invalid Herdr launch request: parentWorkspaceId");
		}
		if (request.parentTabId && !TAB_ID.test(request.parentTabId)) throw new Error("invalid Herdr launch request: parentTabId");
		if (request.parentPaneId && !PANE_ID.test(request.parentPaneId)) throw new Error("invalid Herdr launch request: parentPaneId");
		if (request.parentTerminalId && !TERMINAL_ID.test(request.parentTerminalId)) throw new Error("invalid Herdr launch request: parentTerminalId");
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

	private explicitParent(request: HerdrPlacementRequest): { workspaceId: string; tabId: string; paneId: string } | undefined {
		if (request.parentWorkspaceId === undefined && request.parentTabId === undefined && request.parentPaneId === undefined && request.parentTerminalId === undefined) return undefined;
		if (!request.parentWorkspaceId || !request.parentTabId || !request.parentPaneId) {
			throw new Error("invalid Herdr parent identity: workspace, tab, and pane IDs must be provided together");
		}
		if (!WORKSPACE_ID.test(request.parentWorkspaceId) || !TAB_ID.test(request.parentTabId) || !PANE_ID.test(request.parentPaneId)) {
			throw new Error("invalid Herdr parent identity: malformed workspace, tab, or pane ID");
		}
		if (request.parentTerminalId !== undefined && !TERMINAL_ID.test(request.parentTerminalId)) {
			throw new Error("invalid Herdr parent identity: malformed terminal ID");
		}
		const parent = { workspaceId: request.parentWorkspaceId, tabId: request.parentTabId, paneId: request.parentPaneId };
		this.validateAncestry(parent);
		return parent;
	}

	private activePane(snapshot: Record<string, unknown>): { workspaceId: string; tabId: string; paneId: string } | null {
		const focusedWorkspaceId = typeof snapshot.focused_workspace_id === "string" && WORKSPACE_ID.test(snapshot.focused_workspace_id) ? snapshot.focused_workspace_id : undefined;
		const focusedTabId = typeof snapshot.focused_tab_id === "string" && TAB_ID.test(snapshot.focused_tab_id) ? snapshot.focused_tab_id : undefined;
		const focusedPaneId = typeof snapshot.focused_pane_id === "string" && PANE_ID.test(snapshot.focused_pane_id) ? snapshot.focused_pane_id : undefined;
		if (focusedWorkspaceId && focusedTabId && focusedPaneId) {
			this.validateAncestry({ workspaceId: focusedWorkspaceId, tabId: focusedTabId, paneId: focusedPaneId });
			return { workspaceId: focusedWorkspaceId, tabId: focusedTabId, paneId: focusedPaneId };
		}
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
