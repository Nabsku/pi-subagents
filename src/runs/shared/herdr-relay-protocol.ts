import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const HERDR_RELAY_PROTOCOL_VERSION = 1;
export const HERDR_RELAY_HEADER_BYTES = 20;
export const HERDR_RELAY_MAX_PAYLOAD_BYTES = 64 * 1024;
export const HERDR_RELAY_MAX_HEADER_BYTES = 16 * 1024;

const MAGIC = Buffer.from("HRLY");
const TYPE_CODES: Record<HerdrRelayFrameType, number> = { handshake: 1, stdout: 2, stderr: 3, exit: 4, error: 5, challenge: 6, auth: 7, bind: 8, bound: 9 };
const CODE_TYPES = new Map<number, HerdrRelayFrameType>(Object.entries(TYPE_CODES).map(([type, code]) => [code, type as HerdrRelayFrameType]));

const SETTLEMENT_TYPES = new Set(["exit", "error"]);
const VALID_TYPES = new Set(["handshake", "stdout", "stderr", "exit", "error", "challenge", "auth", "bind", "bound"]);
const BASE_KEYS = new Set(["version", "type", "seq", "pid", "nonce"]);
const RELAY_AUTH_PROOF_BYTES = 32;
const RELAY_AUTH_CHALLENGE_BYTES = 32;
const RELAY_AUTH_DOMAIN = "herdr-relay-auth-v1";
const VALID_SIGNALS = new Set<NodeJS.Signals>([
	"SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGSYS",
]);
const MAX_ID_LENGTH = 512;
const MAX_ERROR_MESSAGE_LENGTH = 4096;

export type HerdrRelayFrameType = "handshake" | "stdout" | "stderr" | "exit" | "error" | "challenge" | "auth" | "bind" | "bound";

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
	challenge?: string;
	proof?: string;
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
	challenge?: string;
	proof?: string;
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
	expectedCapability?: Buffer;
	expectedChallenge?: string;
	expectedPid?: number;
	expectedPgid?: number;
	expectedTerminal?: HerdrRelayTerminalMetadata;
	maxPayloadBytes?: number;
	onFrame: (frame: HerdrRelayFrame) => boolean | void;
}

export interface HerdrRelayReader {
	readonly pendingBytes: number;
	readonly challenge?: string;
	push(chunk: Buffer | Uint8Array | string): void;
	resume(): void;
	end(): void;
	release(): void;
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

function assertAuthoritativeNonce(value: unknown): asserts value is string {
	assertString(value, "expected nonce");
	if (value.trim().length === 0) protocolError("invalid relay frame expected nonce");
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

function constantTimeEqualString(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual, "utf8");
	const expectedBytes = Buffer.from(expected, "utf8");
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function assertBase64Bytes(value: unknown, label: string, bytes: number): asserts value is string {
	assertString(value, label, Math.ceil(bytes / 3) * 4);
	const decoded = Buffer.from(value, "base64");
	if (decoded.length !== bytes || decoded.toString("base64") !== value) protocolError(`invalid relay frame ${label}`);
}

function stableJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export interface HerdrRelayAuthProofInput {
	capability: string | Buffer;
	challenge: string;
	nonce: string;
	pid?: number;
	pgid?: number;
	terminal?: HerdrRelayTerminalMetadata;
}

export function createHerdrRelayAuthProof(input: HerdrRelayAuthProofInput): string {
	if (typeof input.capability === "string") assertString(input.capability, "capability", 4096);
	else if (!Buffer.isBuffer(input.capability) || input.capability.length === 0 || input.capability.length > 4096) protocolError("invalid relay frame capability");
	assertBase64Bytes(input.challenge, "challenge", RELAY_AUTH_CHALLENGE_BYTES);
	assertString(input.nonce, "nonce");
	const hmac = createHmac("sha256", input.capability);
	hmac.update(RELAY_AUTH_DOMAIN);
	hmac.update("\0");
	hmac.update(String(HERDR_RELAY_PROTOCOL_VERSION));
	hmac.update("\0");
	hmac.update(input.nonce);
	hmac.update("\0");
	hmac.update(stableJson({ pid: input.pid, pgid: input.pgid, terminal: input.terminal }));
	hmac.update("\0");
	hmac.update(input.challenge);
	return hmac.digest("base64");
}

function constantTimeEqualBase64(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual, "base64");
	const expectedBytes = Buffer.from(expected, "base64");
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function terminalEquals(actual: HerdrRelayTerminalMetadata | undefined, expected: HerdrRelayTerminalMetadata | undefined): boolean {
	if (expected === undefined) return true;
	if (actual === undefined) return false;
	return actual.workspaceId === expected.workspaceId && actual.tabId === expected.tabId && actual.paneId === expected.paneId && actual.terminalId === expected.terminalId;
}

export function encodeHerdrRelayFrame(frame: HerdrRelayFrame, options: { maxPayloadBytes?: number } = {}): Buffer {
	const maxPayloadBytes = options.maxPayloadBytes ?? HERDR_RELAY_MAX_PAYLOAD_BYTES;
	assertPositiveInteger(frame.version, "version");
	assertNonNegativeInteger(frame.seq, "seq");
	assertPositiveInteger(frame.pid, "pid");
	assertString(frame.type, "type");
	assertString(frame.nonce, "nonce");
	if (Object.hasOwn(frame, "capability")) protocolError("relay capability must not be encoded");
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
		...(frame.challenge === undefined ? {} : { challenge: frame.challenge }),
		...(frame.proof === undefined ? {} : { proof: frame.proof }),
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

	if (header.type === "challenge") {
		assertNoUnknownKeys(header as unknown as Record<string, unknown>, new Set([...BASE_KEYS, "challenge"]));
		assertBase64Bytes(header.challenge, "challenge", RELAY_AUTH_CHALLENGE_BYTES);
		return { version: header.version, type: "challenge", seq: header.seq, pid: header.pid, nonce: header.nonce, challenge: header.challenge };
	}

	if (header.type === "auth") {
		assertNoUnknownKeys(header as unknown as Record<string, unknown>, new Set([...BASE_KEYS, "proof"]));
		assertBase64Bytes(header.proof, "proof", RELAY_AUTH_PROOF_BYTES);
		return { version: header.version, type: "auth", seq: header.seq, pid: header.pid, nonce: header.nonce, proof: header.proof };
	}

	if (header.type === "bind" || header.type === "bound") {
		assertNoUnknownKeys(header as unknown as Record<string, unknown>, new Set([...BASE_KEYS, "pgid", "terminal"]));
		assertPositiveInteger(header.pgid, "pgid");
		return { version: header.version, type: header.type, seq: header.seq, pid: header.pid, nonce: header.nonce, pgid: header.pgid, terminal: validateTerminal(header.terminal) };
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
	const expectedNonce = options.expectedNonce;
	const authenticatedConfiguration = options.expectedCapability !== undefined || options.expectedChallenge !== undefined || options.expectedPgid !== undefined || options.expectedTerminal !== undefined;
	if (authenticatedConfiguration && (options.expectedNonce === undefined || options.expectedCapability === undefined || options.expectedPid === undefined || options.expectedPgid === undefined || options.expectedTerminal === undefined)) {
		protocolError("authenticated relay requires one complete authoritative relay binding");
	}
	if (authenticatedConfiguration) assertAuthoritativeNonce(options.expectedNonce);
	if (options.expectedPid !== undefined) assertPositiveInteger(options.expectedPid, "expected PID");
	if (options.expectedPgid !== undefined) assertPositiveInteger(options.expectedPgid, "expected PGID");
	const expectedPid = options.expectedPid;
	const expectedPgid = options.expectedPgid;
	const expectedTerminal = options.expectedTerminal === undefined ? undefined : Object.freeze(validateTerminal(options.expectedTerminal));
	const onFrame = options.onFrame;
	const maxBufferedBytes = HERDR_RELAY_HEADER_BYTES + Math.max(maxPayloadBytes, HERDR_RELAY_MAX_HEADER_BYTES);
	let buffer = Buffer.alloc(0);
	let handshakeSeen = false;
	let challengeSeen = false;
	let authSeen = false;
	let bindSeen = false;
	let boundSeen = false;
	let settled = false;
	let nextSeq = 1;
	let boundPid: number | undefined;
	let boundNonce: string | undefined;
	let boundPgid: number | undefined;
	let boundTerminal: HerdrRelayTerminalMetadata | undefined;
	if (options.expectedCapability !== undefined && options.expectedCapability.length !== RELAY_AUTH_PROOF_BYTES) protocolError("invalid relay capability");
	let expectedCapability = options.expectedCapability === undefined ? undefined : Buffer.from(options.expectedCapability);
	let expectedChallenge = options.expectedChallenge ?? (expectedCapability === undefined ? undefined : randomBytes(RELAY_AUTH_CHALLENGE_BYTES).toString("base64"));
	if (expectedChallenge !== undefined) assertBase64Bytes(expectedChallenge, "challenge", RELAY_AUTH_CHALLENGE_BYTES);
	let paused = false;
	let released = false;
	let terminalError = "relay reader released";

	function clearEphemeralCapability(): void {
		expectedCapability?.fill(0);
		expectedCapability = undefined;
		expectedChallenge = undefined;
	}

	function release(): void {
		if (released) return;
		released = true;
		buffer = Buffer.alloc(0);
		clearEphemeralCapability();
	}

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
			const authenticatedMode = authenticatedConfiguration;
			if (authenticatedMode) {
				if (!challengeSeen && frame.type !== "challenge") protocolError("relay challenge required first");
				if (challengeSeen && !authSeen && frame.type !== "auth") protocolError("relay auth required after challenge");
				if (authSeen && frame.type === "auth") protocolError("duplicate relay auth");
				if (authSeen && !bindSeen && frame.type !== "bind") protocolError("relay binding required before output");
				if (bindSeen && !boundSeen && frame.type !== "bound") protocolError("relay bound acknowledgment required before output");
				if (boundSeen && (frame.type === "auth" || frame.type === "bind" || frame.type === "bound" || frame.type === "challenge")) protocolError("duplicate relay binding");
			} else if (!handshakeSeen && frame.type !== "handshake") protocolError("relay handshake required first");
			if (frame.seq !== nextSeq) protocolError("invalid relay frame seq");
			if (expectedNonce !== undefined && frame.nonce !== expectedNonce) protocolError("relay nonce mismatch");
			if (expectedPid !== undefined && (frame.type === "handshake" || frame.type === "bind" || frame.type === "bound" || boundSeen) && frame.pid !== expectedPid) protocolError("relay PID mismatch");
			if (frame.type === "handshake") {
				if (handshakeSeen) protocolError("duplicate relay handshake");
				handshakeSeen = true;
				boundPid = frame.pid;
				boundNonce = frame.nonce;
			}
			if (frame.type === "auth") {
				if (authSeen) protocolError("duplicate relay auth");
				if (expectedCapability !== undefined) {
					const expectedProof = createHerdrRelayAuthProof({ capability: expectedCapability, challenge: expectedChallenge ?? "", nonce: expectedNonce!, pid: expectedPid, pgid: expectedPgid, terminal: expectedTerminal });
					if (frame.proof === undefined || !constantTimeEqualBase64(frame.proof, expectedProof)) protocolError("relay capability proof mismatch");
				}
				authSeen = true;
				clearEphemeralCapability();
			}
			if (frame.type === "challenge") {
				if (challengeSeen) protocolError("duplicate relay challenge");
				if (expectedChallenge !== undefined && (frame.challenge === undefined || !constantTimeEqualString(frame.challenge, expectedChallenge))) protocolError("relay challenge mismatch");
				challengeSeen = true;
			}
			if (frame.type === "bind" || frame.type === "bound") {
				if (expectedPgid !== undefined && frame.pgid !== expectedPgid) protocolError("relay PGID mismatch");
				if (!terminalEquals(frame.terminal, expectedTerminal)) protocolError("relay terminal mismatch");
				if (frame.type === "bind") {
					bindSeen = true;
					boundPid = frame.pid;
					boundNonce = frame.nonce;
					boundPgid = frame.pgid;
					boundTerminal = frame.terminal;
				} else {
					if (!bindSeen) protocolError("relay binding required before bound acknowledgment");
					if (frame.pid !== boundPid || frame.nonce !== boundNonce || frame.pgid !== boundPgid || !terminalEquals(frame.terminal, boundTerminal)) protocolError("relay binding mismatch");
					boundSeen = true;
				}
			}
			if (SETTLEMENT_TYPES.has(frame.type)) settled = true;
			nextSeq += 1;
			paused = onFrame(frame) === false;
			return !paused;
		} catch (error) {
			if (error instanceof HerdrRelayProtocolError) terminalError = error.message;
			release();
			throw error;
		}
	}

	return {
		get pendingBytes(): number {
			return buffer.length;
		},
		get challenge(): string | undefined {
			return expectedChallenge;
		},
		push(chunk: Buffer | Uint8Array | string): void {
			if (released) protocolError(terminalError);
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
			if (released) protocolError(terminalError);
			if (!paused) return;
			paused = false;
			while (consumeOne()) {}
		},
		end(): void {
			if (released) return;
			if (paused) return;
			try {
				if (buffer.length > 0) protocolError("truncated relay frame");
				if (!settled) protocolError("relay ended before settlement");
			} catch (error) {
				if (error instanceof HerdrRelayProtocolError) terminalError = error.message;
				throw error;
			} finally {
				release();
			}
		},
		release,
	};
}
