import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IntercomEventBus, ResolvedTerminalConfig } from "../../shared/types.ts";
import { DEFAULT_TERMINAL_CONFIG } from "./terminal-config.ts";
import { HerdrAdapter, type HerdrTerminalHandle } from "./herdr-adapter.ts";
import { createHerdrRelayManagedChild, type HerdrRelayManagedChild } from "./herdr-relay.ts";
import { createHerdrSubagentLifecycle, type HerdrSubagentLifecycle } from "./herdr-subagent-events.ts";


export interface ChildLaunchRequest {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	label: string;
	runId: string;
	childIndex: number;

	parentWorkspaceId?: string;
	parentTabId?: string;
	parentPaneId?: string;
	parentTerminalId?: string;
	placement?: "tab" | "pane";
	splitDirection?: "right" | "down";
	focus?: boolean;
	pluginLaunchFile?: string;
}

export interface TerminalHandle {
	backend: "herdr";
	workspaceId: string;
	tabId: string;
	paneId: string;
	terminalId?: string;
	ownsWorkspace: boolean;
	ownsTab: boolean;
	ownsPane: boolean;
}

export interface LaunchIdentity {
	nonce: string;
	pid?: number;
	processGroupId?: number;
	dedicatedProcessGroup: boolean;
	platform: NodeJS.Platform;
}

export interface ManagedChild {
	pid?: number;
	identity: LaunchIdentity;
	stdout: NodeJS.ReadableStream & { destroy(error?: Error): void };
	stderr: NodeJS.ReadableStream & { destroy(error?: Error): void };
	terminal?: TerminalHandle;
	kill(signal?: NodeJS.Signals | number): boolean;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "exit" | "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: string | symbol, listener: (...args: any[]) => void): this;
	once(event: "error", listener: (error: Error) => void): this;
	once(event: "exit" | "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	once(event: string | symbol, listener: (...args: any[]) => void): this;
	releaseTransport(): Promise<void>;
	closeTerminal(): Promise<void>;
}

export interface ChildProcessBackend {
	launch(request: ChildLaunchRequest): Promise<ManagedChild>;
}

export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ProcessBackendDeps {
	spawn?: SpawnLike;
	processKill?: typeof process.kill;
	platform?: NodeJS.Platform;
	herdrProbe?: () => unknown;
	herdrAdapter?: Pick<HerdrAdapter, "startChild" | "close"> & Partial<Pick<HerdrAdapter, "startPluginChild">>;
	herdrRunnerPath?: string;
	herdrReadinessTimeoutMs?: number;
	onHerdrIdentityReady?: () => void;
	herdrEvents?: IntercomEventBus;
}

function emptyDestroyableStream(): NodeJS.ReadableStream & { destroy(error?: Error): void } {
	const stream = new Readable({ read() {} });
	stream.push(null);
	return stream;
}

function assertNoNul(value: string | undefined, label: string): void {
	if (value?.includes("\0")) {
		throw new Error(`${label} must not contain NUL bytes`);
	}
}

function validateLaunchRequest(request: ChildLaunchRequest): void {
	assertNoNul(request.command, "command");
	assertNoNul(request.cwd, "cwd");
	assertNoNul(request.parentWorkspaceId, "parentWorkspaceId");
	assertNoNul(request.parentTabId, "parentTabId");
	assertNoNul(request.parentPaneId, "parentPaneId");
	assertNoNul(request.parentTerminalId, "parentTerminalId");
	request.args.forEach((arg, index) => assertNoNul(arg, `args[${index}]`));
	for (const [key, value] of Object.entries(request.env)) {
		assertNoNul(key, "env key");
		assertNoNul(value, `env.${key}`);
	}
}

class HeadlessManagedChild implements ManagedChild {
	readonly pid?: number;
	readonly identity: LaunchIdentity;
	readonly stdout: NodeJS.ReadableStream & { destroy(error?: Error): void };
	readonly stderr: NodeJS.ReadableStream & { destroy(error?: Error): void };
	private readonly child: ChildProcess;
	private transportReleased = false;

	constructor(
		child: ChildProcess,
		platform: NodeJS.Platform,
	) {
		this.child = child;
		this.pid = child.pid;
		this.identity = {
			nonce: randomUUID(),
			...(typeof child.pid === "number" ? { pid: child.pid } : {}),
			dedicatedProcessGroup: false,
			platform,
		};
		this.stdout = (child.stdout ?? emptyDestroyableStream()) as NodeJS.ReadableStream & { destroy(error?: Error): void };
		this.stderr = (child.stderr ?? emptyDestroyableStream()) as NodeJS.ReadableStream & { destroy(error?: Error): void };
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		return this.child.kill(signal);
	}

	on(event: string | symbol, listener: (...args: any[]) => void): this {
		this.child.on(event, listener);
		return this;
	}

	once(event: string | symbol, listener: (...args: any[]) => void): this {
		this.child.once(event, listener);
		return this;
	}

	async releaseTransport(): Promise<void> {
		if (this.transportReleased) return;
		this.transportReleased = true;
		try { this.stdout.destroy(); } catch {}
		try { this.stderr.destroy(); } catch {}
	}

	async closeTerminal(): Promise<void> {
		return;
	}
}

class HeadlessProcessBackend implements ChildProcessBackend {
	private readonly spawnImpl: SpawnLike;
	private readonly platform: NodeJS.Platform;

	constructor(deps: ProcessBackendDeps = {}) {
		this.spawnImpl = deps.spawn ?? spawn;
		this.platform = deps.platform ?? process.platform;
	}

	async launch(request: ChildLaunchRequest): Promise<ManagedChild> {
		validateLaunchRequest(request);
		const child = this.spawnImpl(request.command, request.args, {
			cwd: request.cwd,
			env: request.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		return new HeadlessManagedChild(child, this.platform);
	}
}

class HerdrManagedChild extends EventEmitter implements ManagedChild {
	pid?: number;
	identity: LaunchIdentity;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	terminal?: TerminalHandle;
	private socket?: Socket;
	private relayChild?: HerdrRelayManagedChild;
	private released = false;
	private closed = false;
	private readonly server: Server;
	private readonly socketPath: string;
	private readonly adapter: Pick<HerdrAdapter, "close">;
	private readonly closeOnExit: boolean;
	private readonly processKill: typeof process.kill;
	private readonly readiness: Promise<void>;
	private resolveReadiness!: () => void;
	private rejectReadiness!: (error: Error) => void;
	private readinessSettled = false;
	private readinessSucceeded = false;
	private readonly launchFailure: Promise<never>;
	private rejectLaunchFailure!: (error: Error) => void;
	private launchState: "launching" | "published" | "failed" = "launching";
	private terminalClose?: Promise<void>;
	private readonly onIdentityReady?: () => void;
	private readonly lifecycle?: HerdrSubagentLifecycle;

	constructor(
		server: Server,
		socketPath: string,
		adapter: Pick<HerdrAdapter, "close">,
		closeOnExit: boolean,
		nonce: string,
		processKill: typeof process.kill,
		onIdentityReady?: () => void,
		lifecycle?: HerdrSubagentLifecycle,
	) {
		super();
		this.server = server;
		this.socketPath = socketPath;
		this.adapter = adapter;
		this.closeOnExit = closeOnExit;
		this.processKill = processKill;
		this.onIdentityReady = onIdentityReady;
		this.lifecycle = lifecycle;
		this.identity = { nonce, dedicatedProcessGroup: true, platform: process.platform };
		this.readiness = new Promise<void>((resolve, reject) => {
			this.resolveReadiness = resolve;
			this.rejectReadiness = reject;
		});
		void this.readiness.catch(() => {});
		this.launchFailure = new Promise<never>((_resolve, reject) => {
			this.rejectLaunchFailure = reject;
		});
		void this.launchFailure.catch(() => {});
		this.server.once("error", (error) => this.fail(new Error(`Herdr relay server error: ${error.message}`)));
	}

	bindSocket(socket: Socket): void {
		// This endpoint is an opt-in local development transport, not authentication:
		// same-user endpoint impersonation is out of scope and production routing stays disabled.
		if (this.socket) { socket.destroy(); return; }
		this.socket = socket;
		const relayChild = createHerdrRelayManagedChild({
			relay: socket,
			expectedNonce: this.identity.nonce,
			onIdentity: ({ pid, pgid }) => {
				this.pid = pid;
				this.identity = { ...this.identity, pid, processGroupId: pgid };
				setImmediate(() => this.resolveReady());
			},
		});
		this.relayChild = relayChild;
		relayChild.stdout.pipe(this.stdout, { end: false });
		relayChild.stderr.pipe(this.stderr, { end: false });
		relayChild.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
			if (this.launchState === "published") this.emit("exit", code, signal);
			else this.rejectLaunch(new Error("Herdr relay child settled before launch completed"));
		});
		relayChild.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
			if (relayChild.lastError) this.fail(relayChild.lastError);
			else this.finish(code, signal);
		});
	}

	setTerminal(handle: HerdrTerminalHandle): void { this.terminal = handle; }

	waitUntilReady(): Promise<void> { return this.readiness; }
	waitUntilLaunchFailure(): Promise<never> { return this.launchFailure; }

	publish(): void {
		if (this.launchState !== "launching" || this.closed || this.released) {
			throw new Error("Herdr relay settled before launch completed");
		}
		this.launchState = "published";
		if (!this.terminal) throw new Error("Herdr terminal handle was not published");
		this.lifecycle?.registered(this.terminal);
		this.lifecycle?.state("running");
	}

	kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
		const processGroupId = this.identity.processGroupId;
		if (processGroupId === undefined || this.closed) return false;
		try {
			this.processKill(-processGroupId, signal);
			return true;
		} catch { return false; }
	}

	async releaseTransport(): Promise<void> {
		if (this.released) return;
		this.released = true;
		this.rejectReady(new Error("Herdr relay transport released before identity readiness"));
		this.rejectLaunch(new Error("Herdr relay transport released before launch completed"));
		await this.relayChild?.releaseTransport();
		this.socket?.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
		fs.rmSync(this.socketPath, { force: true });
		fs.rmSync(path.dirname(this.socketPath), { recursive: true, force: true });
	}

	async closeTerminal(): Promise<void> {
		if (!this.terminal) return;
		this.terminalClose ??= this.adapter.close(this.terminal).then(() => {});
		await this.terminalClose;
	}

	private finish(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.closed) return;
		if (!this.readinessSettled) this.rejectReady(new Error("Herdr relay closed before identity readiness"));
		this.rejectLaunch(new Error("Herdr relay closed before launch completed"));
		this.closed = true;
		this.lifecycle?.state(signal ? "stopped" : code === 0 ? "completed" : "failed");
		this.stdout.end();
		this.stderr.end();
		void this.releaseTransport().then(async () => {
			if (this.closeOnExit) await this.closeTerminal();
			this.lifecycle?.released();
			if (this.launchState === "published") this.emit("close", code, signal);
		}).catch((error) => {
			this.lifecycle?.released();
			if (this.launchState === "published") this.emit("error", error);
		});
	}

	private fail(error: Error): void {
		if (this.closed) return;
		const launchError = new Error(this.readinessSucceeded
			? `Herdr relay failed before launch completed: ${error.message}`
			: `Herdr relay failed before identity readiness: ${error.message}`);
		this.rejectReady(launchError);
		const failedBeforePublish = this.launchState !== "published";
		this.rejectLaunch(launchError);
		this.closed = true;
		this.lifecycle?.state("failed");
		this.stdout.destroy();
		this.stderr.destroy();
		void this.releaseTransport().finally(() => {
			this.lifecycle?.released();
			if (!failedBeforePublish) {
				this.emit("error", new Error(error.message));
				this.emit("close", null, null);
			}
		});
	}

	private resolveReady(): void {
		if (this.readinessSettled || this.launchState !== "launching") return;
		this.readinessSettled = true;
		this.readinessSucceeded = true;
		this.resolveReadiness();
		try {
			this.onIdentityReady?.();
		} catch (error) {
			const detail = (error instanceof Error ? error.message : String(error))
				.replace(/[\u0000-\u001f\u007f]+/g, " ")
				.slice(0, 200) || "unknown error";
			this.rejectLaunch(new Error(`Herdr identity readiness callback failed: ${detail}`));
		}
	}

	private rejectReady(error: Error): void {
		if (this.readinessSettled) return;
		this.readinessSettled = true;
		this.rejectReadiness(error);
	}

	private rejectLaunch(error: Error): void {
		if (this.launchState !== "launching") return;
		this.launchState = "failed";
		this.rejectLaunchFailure(error);
	}
}

class HerdrProcessBackend implements ChildProcessBackend {
	private readonly adapter: Pick<HerdrAdapter, "startChild" | "close"> & Partial<Pick<HerdrAdapter, "startPluginChild">>;
	private readonly runnerPath: string;
	private readonly config: ResolvedTerminalConfig;
	private readonly processKill: typeof process.kill;
	private readonly readinessTimeoutMs: number;
	private readonly onIdentityReady?: () => void;
	private readonly events?: IntercomEventBus;

	constructor(config: ResolvedTerminalConfig, deps: ProcessBackendDeps) {
		this.config = config;
		this.adapter = deps.herdrAdapter ?? new HerdrAdapter();
		this.runnerPath = deps.herdrRunnerPath ?? fileURLToPath(new URL("../../../herdr-relay-runner.mjs", import.meta.url));
		this.processKill = deps.processKill ?? process.kill;
		this.readinessTimeoutMs = deps.herdrReadinessTimeoutMs ?? 5_000;
		this.onIdentityReady = deps.onHerdrIdentityReady;
		this.events = deps.herdrEvents;
	}

	async launch(request: ChildLaunchRequest): Promise<ManagedChild> {
		validateLaunchRequest(request);
		if (process.platform === "win32") throw new Error("Herdr local pane backend is not supported on Windows");
		if (this.config.backend === "herdr" && !fs.existsSync(this.runnerPath)) throw new Error(`Herdr relay runner not found: ${this.runnerPath}`);

		const deadline = Date.now() + this.readinessTimeoutMs;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-"));
		const socketPath = path.join(root, "relay.sock");
		const envPath = path.join(root, "child-env.json");
		const launchPath = path.join(root, "plugin-launch.json");
		const serializedEnv = Object.fromEntries(Object.entries(request.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
		const nonce = randomUUID();
		try {
			fs.writeFileSync(envPath, JSON.stringify(serializedEnv), { mode: 0o600 });
			if (this.config.backend === "herdr-plugin") {
				fs.writeFileSync(launchPath, JSON.stringify({
				schema: "herdr-pi-subagents-launch/v1",
				version: 1,
				socketPath,
				nonce,
				retention: this.config.closeOnExit ? "close" : "retain",
				envPath,
				command: request.command,
				args: request.args,
				cwd: request.cwd,
				label: request.label,
				}), { mode: 0o600 });
			}
		} catch (error) {
			fs.rmSync(root, { recursive: true, force: true });
			throw error;
		}
		const lifecycle = createHerdrSubagentLifecycle({
			events: this.events,
			enabled: true,
			runId: request.runId,
			childIndex: request.childIndex,
			agent: request.label,
		});
		let managed: HerdrManagedChild;
		const server = createServer((socket) => managed.bindSocket(socket));
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, () => { server.off("error", reject); resolve(); });
			});
		} catch (error) {
			server.close();
			fs.rmSync(root, { recursive: true, force: true });
			throw error;
		}
		managed = new HerdrManagedChild(server, socketPath, this.adapter, this.config.closeOnExit, nonce, this.processKill, this.onIdentityReady, lifecycle);
		let launchFailed = false;
		let deadlineTimer: NodeJS.Timeout | undefined;
		try {
			const deadlinePromise = new Promise<never>((_resolve, reject) => {
				deadlineTimer = setTimeout(
					() => reject(new Error("Herdr launch readiness timed out")),
					Math.max(1, deadline - Date.now()),
				);
			});
			const launchRequest: ChildLaunchRequest = this.config.backend === "herdr-plugin"
				? { ...request, placement: this.config.placement, splitDirection: this.config.splitDirection, focus: this.config.focus, pluginLaunchFile: launchPath }
				: {
					...request,
					placement: this.config.placement,
					splitDirection: this.config.splitDirection,
					focus: this.config.focus,
					command: process.execPath,
					args: [this.runnerPath, socketPath, nonce, this.config.closeOnExit ? "close" : "retain", "--env-file", envPath, request.command, ...request.args],
				};
			const pluginStart = this.adapter.startPluginChild?.bind(this.adapter);
			if (this.config.backend === "herdr-plugin" && !pluginStart) throw new Error("Herdr plugin backend is unavailable in the configured adapter");
			const handlePromise = (this.config.backend === "herdr-plugin"
				? pluginStart!(launchRequest)
				: this.adapter.startChild(launchRequest)).then(async (handle) => {
				if (launchFailed) {
					await this.adapter.close(handle).catch(() => {});
					throw new Error("Herdr launch settled before adapter returned an owned terminal");
				}
				managed.setTerminal(handle);
				return handle;
			});
			await Promise.race([
				Promise.all([handlePromise, managed.waitUntilReady()]).then(() => managed.publish()),
				managed.waitUntilLaunchFailure(),
				deadlinePromise,
			]);
			return managed;
		} catch (error) {
			launchFailed = true;
			await managed.closeTerminal().catch(() => {});

			await managed.releaseTransport();
			fs.rmSync(root, { recursive: true, force: true });
			throw error;
		} finally {
			if (deadlineTimer) clearTimeout(deadlineTimer);
		}
	}
}

export function createHeadlessProcessBackend(deps: ProcessBackendDeps = {}): ChildProcessBackend {
	return new HeadlessProcessBackend(deps);
}

export function createChildProcessBackend(
	config: ResolvedTerminalConfig | undefined = DEFAULT_TERMINAL_CONFIG,
	deps: ProcessBackendDeps = {},
): ChildProcessBackend {
	const resolved = config ?? DEFAULT_TERMINAL_CONFIG;
	if (resolved.backend === "headless") {
		return createHeadlessProcessBackend(deps);
	}
	return new HerdrProcessBackend(resolved, deps);
}
