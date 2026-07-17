import { EventEmitter } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import type { ManagedChild, TerminalHandle } from "./process-backend.ts";
import { createHerdrRelayReader, type HerdrRelayFrame, type HerdrRelayTerminalMetadata } from "./herdr-relay-protocol.ts";

export interface HerdrRelayManagedChildOptions {
	relay: Readable & { destroy(error?: Error): void; pause(): unknown; resume(): unknown };
	expectedNonce: string;
	expectedCapability?: Buffer;
	expectedChallenge?: string;
	expectedPid?: number;
	expectedPgid?: number;
	expectedTerminal?: HerdrRelayTerminalMetadata;
}

export interface HerdrRelayManagedChild extends ManagedChild {
	stdout: PassThrough;
	stderr: PassThrough;
	lastError?: Error;
}

class RelayManagedChild extends EventEmitter implements HerdrRelayManagedChild {
	pid?: number;
	identity: ManagedChild["identity"];
	terminal?: TerminalHandle;
	readonly stdout = new PassThrough({ highWaterMark: 16 * 1024 });
	readonly stderr = new PassThrough({ highWaterMark: 16 * 1024 });
	lastError?: Error;
	private readonly relay: Readable & { destroy(error?: Error): void; pause(): unknown; resume(): unknown };
	private readonly reader;
	private released = false;
	private closed = false;
	private settled = false;
	private protocolFailed = false;
	private relayEnded = false;
	private stdoutBackpressured = false;
	private stderrBackpressured = false;
	private terminalCode: number | null = null;
	private terminalSignal: NodeJS.Signals | null = null;

	constructor(options: HerdrRelayManagedChildOptions) {
		super();
		this.relay = options.relay;
		this.pid = options.expectedCapability === undefined ? options.expectedPid : undefined;
		this.identity = {
			nonce: options.expectedNonce,
			...(options.expectedCapability !== undefined || options.expectedPid === undefined ? {} : { pid: options.expectedPid }),
			dedicatedProcessGroup: true,
			platform: process.platform,
		};
		this.reader = createHerdrRelayReader({
			expectedNonce: options.expectedNonce,
			expectedCapability: options.expectedCapability,
			expectedChallenge: options.expectedChallenge,
			expectedPid: options.expectedPid,
			expectedPgid: options.expectedPgid,
			expectedTerminal: options.expectedTerminal,
			onFrame: (frame) => this.handleFrame(frame),
		});
		this.relay.on("data", this.onData);
		this.relay.once("error", this.onError);
		this.relay.once("end", this.onEnd);
	}

	kill(_signal?: NodeJS.Signals | number): boolean {
		return false;
	}

	async releaseTransport(): Promise<void> {
		if (this.released) return;
		this.released = true;
		this.reader.release();
		this.detachRelayListeners();
		this.relay.destroy();
		this.stdout.destroy();
		this.stderr.destroy();
	}

	async closeTerminal(): Promise<void> {
		return;
	}

	private readonly onData = (chunk: unknown): void => {
		if (this.closed || this.protocolFailed) return;
		try {
			this.reader.push(chunk as Buffer);
		} catch (error) {
			this.fail(error, true);
		}
	};

	private readonly onError = (error: Error): void => {
		this.fail(error, false);
	};

	private readonly onEnd = (): void => {
		if (this.closed || this.protocolFailed) return;
		this.relayEnded = true;
		if (this.stdoutBackpressured || this.stderrBackpressured) return;
		this.finishRelayEnd();
	};

	private finishRelayEnd(): void {
		try {
			this.reader.end();
			if (this.settled && this.lastError === undefined) {
				queueMicrotask(() => this.emit("exit", this.terminalCode, this.terminalSignal));
			}
			this.finish(this.terminalCode, this.terminalSignal);
		} catch (error) {
			this.fail(error, false);
		}
	}

	private handleFrame(frame: HerdrRelayFrame): boolean | void {
		if (this.closed || this.protocolFailed) return;
		if (frame.type === "handshake" || frame.type === "bound") {
			this.pid = frame.pid;
			this.identity = {
				nonce: frame.nonce,
				pid: frame.pid,
				processGroupId: frame.pgid,
				dedicatedProcessGroup: true,
				platform: process.platform,
			};
			this.terminal = frame.terminal === undefined ? undefined : { backend: "herdr", workspaceId: frame.terminal.workspaceId, tabId: frame.terminal.tabId, paneId: frame.terminal.paneId, terminalId: frame.terminal.terminalId, ownsWorkspace: false, ownsTab: false, ownsPane: false };
			return;
		}
		if (frame.type === "stdout") {
			return this.writeOutput(this.stdout, frame.payload ?? Buffer.alloc(0), "stdout");
		}
		if (frame.type === "stderr") {
			return this.writeOutput(this.stderr, frame.payload ?? Buffer.alloc(0), "stderr");
		}
		if (frame.type === "exit") {
			this.settled = true;
			this.terminalCode = frame.code ?? null;
			this.terminalSignal = frame.signal ?? null;
			return;
		}
		if (frame.type === "error") {
			this.settled = true;
			this.lastError = new Error("Herdr relay reported a transport error");
		}
	}

	private writeOutput(stream: PassThrough, payload: Buffer, channel: "stdout" | "stderr"): boolean {
		if (stream.write(payload)) return true;
		if (channel === "stdout") this.stdoutBackpressured = true;
		else this.stderrBackpressured = true;
		this.relay.pause();
		stream.once("drain", () => {
			if (channel === "stdout") this.stdoutBackpressured = false;
			else this.stderrBackpressured = false;
			if (!this.closed && !this.protocolFailed && !this.stdoutBackpressured && !this.stderrBackpressured) {
				try {
					this.reader.resume();
					if (this.stdoutBackpressured || this.stderrBackpressured) return;
					if (this.relayEnded) this.finishRelayEnd();
					else this.relay.resume();
				} catch (error) {
					this.fail(error, true);
				}
			}
		});
		return false;
	}

	private fail(error: unknown, destroyRelay: boolean): void {
		if (this.closed) return;
		if (destroyRelay) this.protocolFailed = true;
		const safe = error instanceof Error ? new Error(error.message) : new Error(String(error));
		this.lastError = safe;
		if (destroyRelay) {
			this.detachRelayListeners();
			this.relay.destroy();
		}
		this.finish(null, null);
	}

	private detachRelayListeners(): void {
		this.relay.off("data", this.onData);
		this.relay.off("error", this.onError);
		this.relay.off("end", this.onEnd);
	}

	private finish(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.closed) return;
		this.closed = true;
		if (this.settled) {
			this.stdout.end();
			this.stderr.end();
		} else {
			this.stdout.destroy();
			this.stderr.destroy();
		}
		queueMicrotask(() => this.emit("close", code, signal));
	}
}

export function createHerdrRelayManagedChild(options: HerdrRelayManagedChildOptions): HerdrRelayManagedChild {
	return new RelayManagedChild(options);
}
