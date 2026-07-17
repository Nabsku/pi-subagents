import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ResolvedTerminalConfig } from "../../shared/types.ts";
import { DEFAULT_TERMINAL_CONFIG } from "./terminal-config.ts";

export interface ChildLaunchRequest {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	label: string;
	runId: string;
	childIndex: number;
	parentWorkspaceId?: string;
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
	platform?: NodeJS.Platform;
	herdrProbe?: () => unknown;
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

class UnsupportedHerdrBackend implements ChildProcessBackend {
	async launch(_request: ChildLaunchRequest): Promise<ManagedChild> {
		throw new Error("Herdr terminal backend is not implemented in this slice");
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
	return new UnsupportedHerdrBackend();
}
