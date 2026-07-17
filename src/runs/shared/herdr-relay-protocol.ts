export const HERDR_RELAY_PROTOCOL_VERSION = 1;
export const HERDR_RELAY_HEADER_BYTES = 20;
export const HERDR_RELAY_MAX_PAYLOAD_BYTES = 64 * 1024;
export const HERDR_RELAY_MAX_HEADER_BYTES = 16 * 1024;

const MAGIC = Buffer.from("HRLY");
const TYPE_CODES: Record<HerdrRelayFrameType, number> = { handshake: 1, stdout: 2, stderr: 3, exit: 4, error: 5 };
const CODE_TYPES = new Map<number, HerdrRelayFrameType>(Object.entries(TYPE_CODES).map(([type, code]) => [code, type as HerdrRelayFrameType]));

const SETTLEMENT_TYPES = new Set(["exit", "error"]);
const VALID_TYPES = new Set(["handshake", "stdout", "stderr", "exit", "error"]);
const BASE_KEYS = new Set(["version", "type", "seq", "pid", "nonce"]);
const VALID_SIGNALS = new Set<NodeJS.Signals>([
	"SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGSYS",
]);
const MAX_ID_LENGTH = 512;
const MAX_ERROR_MESSAGE_LENGTH = 4096;

export type HerdrRelayFrameType = "handshake" | "stdout" | "stderr" | "exit" | "error";

export interface HerdrRelayTerminalMetadata {
	workspaceId: string;
	tabId: string;
	paneId: string;
	terminalId?: string;
}

export interface HerdrRelayFrame {
	version: number;
	type: HerdrRelayFrameType;
	seq: number;
	pid: number;
	nonce: string;
	pgid?: number;
	terminal?: HerdrRelayTerminalMetadata;
	payload?: Buffer;
	code?: number | null;
	signal?: NodeJS.Signals | null;
	message?: string;
}

interface EncodedHeader {
	version: number;
	type: string;
	seq: number;
	pid: number;
	nonce: string;
	pgid?: number;
	terminal?: HerdrRelayTerminalMetadata;
	payloadBase64?: string;
	code?: number | null;
	signal?: NodeJS.Signals | null;
	message?: string;
}

export class HerdrRelayProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HerdrRelayProtocolError";
	}
}

export interface HerdrRelayReaderOptions {
	expectedNonce?: string;
	expectedPid?: number;
	maxPayloadBytes?: number;
	onFrame: (frame: HerdrRelayFrame) => boolean | void;
}

export interface HerdrRelayReader {
	readonly pendingBytes: number;
	push(chunk: Buffer | Uint8Array | string): void;
	resume(): void;
	end(): void;
}

function protocolError(message: string): never {
	throw new HerdrRelayProtocolError(message);
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) protocolError(`invalid relay frame ${label}`);
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) protocolError(`invalid relay frame ${label}`);
}

function assertString(value: unknown, label: string, maxLength = MAX_ID_LENGTH): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) protocolError(`invalid relay frame ${label}`);
}

function assertNoUnknownKeys(header: Record<string, unknown>, allowed: Set<string>): void {
	for (const key of Object.keys(header)) {
		if (!allowed.has(key)) protocolError("unknown relay frame field");
	}
}

function validateTerminal(value: unknown): HerdrRelayTerminalMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) protocolError("invalid relay frame terminal");
	const terminal = value as Record<string, unknown>;
	const allowed = new Set(["workspaceId", "tabId", "paneId", "terminalId"]);
	assertNoUnknownKeys(terminal, allowed);
	assertString(terminal.workspaceId, "terminal");
	assertString(terminal.tabId, "terminal");
	assertString(terminal.paneId, "terminal");
	if (terminal.terminalId !== undefined) assertString(terminal.terminalId, "terminal");
	return {
		workspaceId: terminal.workspaceId,
		tabId: terminal.tabId,
		paneId: terminal.paneId,
		...(terminal.terminalId === undefined ? {} : { terminalId: terminal.terminalId }),
	};
}

function canonicalPayload(payloadBase64: unknown, maxPayloadBytes: number): Buffer {
	if (typeof payloadBase64 !== "string" || payloadBase64.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payloadBase64)) {
		protocolError("invalid relay frame payload");
	}
	const payload = Buffer.from(payloadBase64, "base64");
	if (payload.length > maxPayloadBytes) protocolError("payload exceeds relay frame limit");
	if (payload.toString("base64") !== payloadBase64) protocolError("invalid relay frame payload");
	return payload;
}

function payloadFromFrame(frame: HerdrRelayFrame, maxPayloadBytes: number): string | undefined {
	const payload = frame.payload;
	if (payload === undefined) return undefined;
	if (!Buffer.isBuffer(payload)) protocolError("invalid relay frame payload");
	if (payload.length > maxPayloadBytes) protocolError("payload exceeds relay frame limit");
	return payload.toString("base64");
}

export function encodeHerdrRelayFrame(frame: HerdrRelayFrame, options: { maxPayloadBytes?: number } = {}): Buffer {
	const maxPayloadBytes = options.maxPayloadBytes ?? HERDR_RELAY_MAX_PAYLOAD_BYTES;
	assertPositiveInteger(frame.version, "version");
	assertNonNegativeInteger(frame.seq, "seq");
	assertPositiveInteger(frame.pid, "pid");
	assertString(frame.type, "type");
	assertString(frame.nonce, "nonce");
	if ((frame.type === "stdout" || frame.type === "stderr") && (!Buffer.isBuffer(frame.payload) || frame.payload.length > maxPayloadBytes)) {
		protocolError("payload exceeds relay frame limit");
	}
	const header: EncodedHeader = {
		version: frame.version,
		type: frame.type,
		seq: frame.seq,
		pid: frame.pid,
		nonce: frame.nonce,
		...(frame.pgid === undefined ? {} : { pgid: frame.pgid }),
		...(frame.terminal === undefined ? {} : { terminal: frame.terminal }),
		...(frame.code === undefined ? {} : { code: frame.code }),
		...(frame.signal === undefined ? {} : { signal: frame.signal }),
		...(frame.message === undefined ? {} : { message: frame.message }),
		...(frame.type === "stdout" || frame.type === "stderr" || frame.payload === undefined ? {} : { payloadBase64: payloadFromFrame(frame, maxPayloadBytes) }),
	};
	const body = frame.type === "stdout" || frame.type === "stderr"
		? (frame.payload ?? protocolError("invalid relay frame payload"))
		: Buffer.from(JSON.stringify(header), "utf8");
	const limit = frame.type === "stdout" || frame.type === "stderr" ? maxPayloadBytes : HERDR_RELAY_MAX_HEADER_BYTES;
	if (body.length > limit) protocolError("relay frame payload exceeds limit");
	const envelope = Buffer.alloc(HERDR_RELAY_HEADER_BYTES);
	MAGIC.copy(envelope, 0);
	envelope[4] = HERDR_RELAY_PROTOCOL_VERSION;
	envelope[5] = TYPE_CODES[frame.type];
	envelope.writeUInt16BE(0, 6);
	envelope.writeUInt32BE(body.length, 8);
	envelope.writeBigUInt64BE(BigInt(frame.seq), 12);
	return Buffer.concat([envelope, body]);
}

function validateCommon(header: EncodedHeader): void {
	if (header.version !== HERDR_RELAY_PROTOCOL_VERSION) protocolError("unsupported relay protocol version");
	if (!VALID_TYPES.has(header.type)) protocolError("unknown relay frame type");
	assertNonNegativeInteger(header.seq, "seq");
	assertPositiveInteger(header.pid, "pid");
	assertString(header.nonce, "nonce");
}

function decodeFrame(body: Buffer, maxPayloadBytes: number, envelopeType?: HerdrRelayFrameType, envelopeSeq?: number): HerdrRelayFrame {
	if (envelopeType === "stdout" || envelopeType === "stderr") {
		if (body.length > maxPayloadBytes) protocolError("relay frame payload length exceeds limit");
		return { version: HERDR_RELAY_PROTOCOL_VERSION, type: envelopeType, seq: envelopeSeq!, pid: 0, nonce: "pending", payload: Buffer.from(body) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		protocolError("invalid relay frame UTF-8 or JSON metadata");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) protocolError("invalid relay frame header");
	const header = parsed as EncodedHeader;
	validateCommon(header);
	if (envelopeType !== undefined && header.type !== envelopeType) protocolError("relay frame type mismatch");
	if (envelopeSeq !== undefined && header.seq !== envelopeSeq) protocolError("relay frame seq mismatch");

	if (header.type === "handshake") {
		assertNoUnknownKeys(header as unknown as Record<string, unknown>, new Set([...BASE_KEYS, "pgid", "terminal"]));
		assertPositiveInteger(header.pgid, "pgid");
		return { version: header.version, type: "handshake", seq: header.seq, pid: header.pid, nonce: header.nonce, pgid: header.pgid, terminal: validateTerminal(header.terminal) };
	}

	if (header.type === "stdout" || header.type === "stderr") {
		assertNoUnknownKeys(header as unknown as Record<string, unknown>, new Set([...BASE_KEYS, "payloadBase64"]));
		return { version: header.version, type: header.type, seq: header.seq, pid: header.pid, nonce: header.nonce, payload: canonicalPayload(header.payloadBase64, maxPayloadBytes) };
	}

	if (header.type === "exit") {
		assertNoUnknownKeys(header as unknown as Record<string, unknown>, new Set([...BASE_KEYS, "code", "signal"]));
		const codeValid = header.code === null || (Number.isInteger(header.code) && (header.code as number) >= 0 && (header.code as number) <= 255);
		const signalValid = header.signal === null || (typeof header.signal === "string" && VALID_SIGNALS.has(header.signal as NodeJS.Signals));
		if (!codeValid || !signalValid || (header.code === null) === (header.signal === null)) protocolError("invalid relay frame settlement");
		return { version: header.version, type: "exit", seq: header.seq, pid: header.pid, nonce: header.nonce, code: header.code, signal: header.signal };
	}

	assertNoUnknownKeys(header as unknown as Record<string, unknown>, new Set([...BASE_KEYS, "message"]));
	assertString(header.message, "message", MAX_ERROR_MESSAGE_LENGTH);
	return { version: header.version, type: "error", seq: header.seq, pid: header.pid, nonce: header.nonce, message: header.message };
}

export function createHerdrRelayReader(options: HerdrRelayReaderOptions): HerdrRelayReader {
	const maxPayloadBytes = options.maxPayloadBytes ?? HERDR_RELAY_MAX_PAYLOAD_BYTES;
	const maxBufferedBytes = HERDR_RELAY_HEADER_BYTES + Math.max(maxPayloadBytes, HERDR_RELAY_MAX_HEADER_BYTES);
	let buffer = Buffer.alloc(0);
	let handshakeSeen = false;
	let settled = false;
	let nextSeq = 1;
	let boundPid: number | undefined;
	let boundNonce: string | undefined;
	let paused = false;

	function consumeOne(): boolean {
		try {
			if (buffer.length < HERDR_RELAY_HEADER_BYTES) return false;
			if (!buffer.subarray(0, 4).equals(MAGIC)) protocolError("invalid relay frame magic");
			if (buffer[4] !== HERDR_RELAY_PROTOCOL_VERSION) protocolError("unsupported relay protocol version");
			const type = CODE_TYPES.get(buffer[5]!);
			if (type === undefined) protocolError("unknown relay frame type");
			if (buffer.readUInt16BE(6) !== 0) protocolError("invalid relay frame flags");
			const length = buffer.readUInt32BE(8);
			const limit = type === "stdout" || type === "stderr" ? maxPayloadBytes : HERDR_RELAY_MAX_HEADER_BYTES;
			if (length > limit) protocolError("relay frame payload length exceeds limit");
			const seqBig = buffer.readBigUInt64BE(12);
			if (seqBig > BigInt(Number.MAX_SAFE_INTEGER)) protocolError("invalid relay frame seq");
			if (buffer.length < HERDR_RELAY_HEADER_BYTES + length) return false;
			const body = buffer.subarray(HERDR_RELAY_HEADER_BYTES, HERDR_RELAY_HEADER_BYTES + length);
			buffer = buffer.subarray(HERDR_RELAY_HEADER_BYTES + length);
			const frame = decodeFrame(body, maxPayloadBytes, type, Number(seqBig));
			if (type === "stdout" || type === "stderr") {
				frame.pid = boundPid ?? 0;
				frame.nonce = boundNonce ?? "pending";
			}
			if (settled) protocolError("frame after relay settlement");
			if (!handshakeSeen && frame.type !== "handshake") protocolError("relay handshake required first");
			if (frame.seq !== nextSeq) protocolError("invalid relay frame seq");
			if (options.expectedNonce !== undefined && frame.nonce !== options.expectedNonce) protocolError("relay nonce mismatch");
			if (options.expectedPid !== undefined && frame.pid !== options.expectedPid) protocolError("relay PID mismatch");
			if (frame.type === "handshake") {
				if (handshakeSeen) protocolError("duplicate relay handshake");
				handshakeSeen = true;
				boundPid = frame.pid;
				boundNonce = frame.nonce;
			}
			if (SETTLEMENT_TYPES.has(frame.type)) settled = true;
			nextSeq += 1;
			paused = options.onFrame(frame) === false;
			return !paused;
		} catch (error) {
			buffer = Buffer.alloc(0);
			throw error;
		}
	}

	return {
		get pendingBytes(): number {
			return buffer.length;
		},
		push(chunk: Buffer | Uint8Array | string): void {
			const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (paused && input.length > maxBufferedBytes - buffer.length) {
				buffer = Buffer.alloc(0);
				protocolError("relay input buffer limit exceeded");
			}
			let offset = 0;
			while (offset < input.length) {
				const remainingCapacity = maxBufferedBytes - buffer.length;
				if (remainingCapacity <= 0) {
					buffer = Buffer.alloc(0);
					protocolError("relay input buffer limit exceeded");
				}
				const nextOffset = Math.min(input.length, offset + remainingCapacity);
				const slice = input.subarray(offset, nextOffset);
				buffer = buffer.length === 0 ? Buffer.from(slice) : Buffer.concat([buffer, slice], buffer.length + slice.length);
				offset = nextOffset;
				if (!paused) while (consumeOne()) {}
			}
		},
		resume(): void {
			if (!paused) return;
			paused = false;
			while (consumeOne()) {}
		},
		end(): void {
			if (paused) return;
			if (buffer.length > 0) protocolError("truncated relay frame");
			if (!settled) protocolError("relay ended before settlement");
		},
	};
}
