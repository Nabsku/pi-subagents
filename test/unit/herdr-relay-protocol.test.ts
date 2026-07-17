import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	HERDR_RELAY_HEADER_BYTES,
	HERDR_RELAY_MAX_PAYLOAD_BYTES,
	HERDR_RELAY_PROTOCOL_VERSION,
	HerdrRelayProtocolError,
	createHerdrRelayAuthProof,
	createHerdrRelayReader,
	encodeHerdrRelayFrame,
	type HerdrRelayFrame,
} from "../../src/runs/shared/herdr-relay-protocol.ts";

function frame(overrides: Partial<HerdrRelayFrame> = {}): HerdrRelayFrame {
	return {
		version: HERDR_RELAY_PROTOCOL_VERSION,
		type: "handshake",
		seq: 1,
		pid: 123,
		nonce: "nonce-1",
		pgid: 123,
		terminal: { workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" },
		...overrides,
	};
}

const AUTH_CHALLENGE = Buffer.alloc(32, 0xa7).toString("base64");
const OTHER_AUTH_CHALLENGE = Buffer.alloc(32, 0xb8).toString("base64");
const AUTH_CAPABILITY = Buffer.from("capability-secret".padEnd(32, "\0"));
const BINDING_TERMINAL = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", terminalId: "term_1" };
const AUTH_READER_OPTIONS = { expectedNonce: "launch-nonce", expectedCapability: AUTH_CAPABILITY, expectedChallenge: AUTH_CHALLENGE, expectedPid: 123, expectedPgid: 123, expectedTerminal: BINDING_TERMINAL };

function authProof(overrides: { capability?: string | Buffer; challenge?: string; nonce?: string; pid?: number; pgid?: number; terminal?: typeof BINDING_TERMINAL } = {}): string {
	return createHerdrRelayAuthProof({ capability: overrides.capability ?? AUTH_CAPABILITY, challenge: overrides.challenge ?? AUTH_CHALLENGE, nonce: overrides.nonce ?? "launch-nonce", pid: overrides.pid ?? 123, pgid: overrides.pgid ?? 123, terminal: overrides.terminal ?? BINDING_TERMINAL });
}


function challengeFrame(overrides: Partial<HerdrRelayFrame> = {}): HerdrRelayFrame {
	return frame({ type: "challenge", seq: 1, pid: 1, nonce: "launch-nonce", challenge: AUTH_CHALLENGE, pgid: undefined, terminal: undefined, ...overrides });
}

function dataFrame(overrides: Partial<HerdrRelayFrame> = {}): HerdrRelayFrame {
	return frame({ type: "stdout", seq: 2, payload: Buffer.from("data"), pgid: undefined, terminal: undefined, ...overrides });
}

function authFrame(overrides: Partial<HerdrRelayFrame> = {}): HerdrRelayFrame {
	return frame({ type: "auth", seq: 2, pid: 1, nonce: "launch-nonce", proof: authProof(), pgid: undefined, terminal: undefined, ...overrides });
}

function bindFrame(overrides: Partial<HerdrRelayFrame> = {}): HerdrRelayFrame {
	return frame({ type: "bind", seq: 3, pid: 123, nonce: "launch-nonce", pgid: 123, terminal: BINDING_TERMINAL, ...overrides });
}

function rawHeader(header: Record<string, unknown>): Buffer {
	const body = Buffer.from(JSON.stringify(header), "utf8");
	const typeCodes: Record<string, number> = { handshake: 1, stdout: 2, stderr: 3, exit: 4, error: 5, challenge: 6, auth: 7, bind: 8, bound: 9 };
	const envelope = Buffer.alloc(HERDR_RELAY_HEADER_BYTES);
	Buffer.from("HRLY").copy(envelope);
	envelope[4] = HERDR_RELAY_PROTOCOL_VERSION;
	envelope[5] = typeCodes[String(header.type)] ?? 255;
	envelope.writeUInt32BE(body.length, 8);
	envelope.writeBigUInt64BE(BigInt(Number(header.seq ?? 0)), 12);
	return Buffer.concat([envelope, body]);
}

function collect(chunks: Buffer[]): HerdrRelayFrame[] {
	const frames: HerdrRelayFrame[] = [];
	const reader = createHerdrRelayReader({ onFrame: (relayFrame) => frames.push(relayFrame) });
	for (const chunk of chunks) reader.push(chunk);
	return frames;
}

function metadataEnvelope(type: number, seq: number, body: Buffer): Buffer {
	const envelope = Buffer.alloc(HERDR_RELAY_HEADER_BYTES);
	Buffer.from("HRLY").copy(envelope);
	envelope[4] = HERDR_RELAY_PROTOCOL_VERSION;
	envelope[5] = type;
	envelope.writeUInt32BE(body.length, 8);
	envelope.writeBigUInt64BE(BigInt(seq), 12);
	return Buffer.concat([envelope, body]);
}

describe("Herdr relay protocol", () => {
	it("uses the fixed 20-byte HRLY envelope and raw stream payload bytes", () => {
		const payload = Buffer.from([0x00, 0xff, 0x80, 0x0a]);
		const encoded = encodeHerdrRelayFrame(dataFrame({ seq: 0, payload }));
		assert.equal(HERDR_RELAY_HEADER_BYTES, 20);
		assert.deepEqual(encoded.subarray(0, 4), Buffer.from("HRLY"));
		assert.equal(encoded[4], HERDR_RELAY_PROTOCOL_VERSION);
		assert.equal(encoded.readUInt32BE(8), payload.length);
		assert.deepEqual(encoded.subarray(20), payload);
	});

	it("rejects bad envelope magic, flags, unknown types, and oversized declared stream payloads before buffering", () => {
		const good = encodeHerdrRelayFrame(dataFrame({ seq: 0, payload: Buffer.from("x") }));
		for (const [offset, value, pattern] of [[0, 0, /magic/], [6, 1, /flags/], [5, 255, /type/]] as const) {
			const bad = Buffer.from(good);
			bad[offset] = value;
			assert.throws(() => collect([bad]), pattern);
		}
		const oversized = Buffer.from(good.subarray(0, HERDR_RELAY_HEADER_BYTES));
		oversized.writeUInt32BE(HERDR_RELAY_MAX_PAYLOAD_BYTES + 1, 8);
		assert.throws(() => collect([oversized]), /payload length/);
	});

	it("encodes and decodes byte-accurate stdout and stderr payloads without UTF-8 coercion", () => {
		const stdoutPayload = Buffer.from([0x00, 0xff, 0x80, 0x0a, 0xc3, 0x28]);
		const stderrPayload = Buffer.from("line\r\nnext", "utf8");
		const frames = collect([
			encodeHerdrRelayFrame(frame()),
			encodeHerdrRelayFrame(dataFrame({ payload: stdoutPayload })),
			encodeHerdrRelayFrame(dataFrame({ type: "stderr", seq: 3, payload: stderrPayload })),
		]);

		assert.equal(frames.length, 3);
		assert.equal(frames[1]?.type, "stdout");
		assert.equal(frames[2]?.type, "stderr");
		assert.deepEqual(frames[1]?.payload, stdoutPayload);
		assert.deepEqual(frames[2]?.payload, stderrPayload);
	});

	it("handles split frames at every byte boundary and merged frames", () => {
		const encoded = Buffer.concat([
			encodeHerdrRelayFrame(frame({ pid: 321, pgid: 321, nonce: "nonce-2", terminal: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" } })),
			encodeHerdrRelayFrame(dataFrame({ seq: 2, pid: 321, nonce: "nonce-2", payload: Buffer.from("abc") })),
			encodeHerdrRelayFrame(frame({ type: "exit", seq: 3, pid: 321, nonce: "nonce-2", code: 7, signal: null, pgid: undefined, terminal: undefined })),
		]);

		for (let split = 1; split < encoded.length; split += 1) {
			const frames = collect([encoded.subarray(0, split), encoded.subarray(split)]);
			assert.deepEqual(frames.map((relayFrame) => relayFrame.type), ["handshake", "stdout", "exit"]);
		}
	});

	it("rejects malformed envelopes, invalid JSON metadata, unsupported versions, and unknown frame types without leaking payload bytes", () => {
		assert.throws(() => collect([Buffer.alloc(HERDR_RELAY_HEADER_BYTES)]), /invalid relay frame magic/);
		const invalidJson = encodeHerdrRelayFrame(frame());
		invalidJson.fill(0x78, HERDR_RELAY_HEADER_BYTES);
		assert.throws(() => collect([invalidJson]), /invalid relay frame (?:UTF-8 or JSON metadata|header)/);
		assert.throws(
			() => collect([encodeHerdrRelayFrame(frame({ version: 99 } as Partial<HerdrRelayFrame>))]),
			(error: unknown) => error instanceof HerdrRelayProtocolError && /unsupported relay protocol version/.test(error.message) && !error.message.includes("secret-token"),
		);
		assert.throws(
			() => collect([encodeHerdrRelayFrame(frame({ type: "bogus" as HerdrRelayFrame["type"] }))]),
			/unknown relay frame type/,
		);
	});

	it("requires the first frame to be a strict handshake carrying PID, PGID, nonce, and terminal identity", () => {
		assert.throws(() => collect([encodeHerdrRelayFrame(dataFrame({ payload: Buffer.from("early") }))]), /relay handshake required first/);
		assert.throws(() => collect([encodeHerdrRelayFrame(frame({ pgid: undefined }))]), /invalid relay frame pgid/);
		assert.throws(() => collect([encodeHerdrRelayFrame(frame({ terminal: undefined }))]), /invalid relay frame terminal/);
		assert.throws(() => collect([rawHeader({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 1, pid: 1, nonce: "nonce", pgid: 1, terminal: { workspaceId: "w", tabId: "t", paneId: "p" }, extra: true })]), /unknown relay frame field/);
	});

	it("enforces contiguous sequence numbers and rejects duplicate, replayed, or skipped frames", () => {
		const reader = createHerdrRelayReader({ onFrame: () => {} });
		reader.push(encodeHerdrRelayFrame(frame()));
		reader.push(encodeHerdrRelayFrame(dataFrame({ seq: 2 })));
		assert.throws(() => reader.push(encodeHerdrRelayFrame(dataFrame({ type: "stderr", seq: 2, payload: Buffer.from("replay") }))), /invalid relay frame seq/);
		const skipped = createHerdrRelayReader({ onFrame: () => {} });
		skipped.push(encodeHerdrRelayFrame(frame()));
		assert.throws(() => skipped.push(encodeHerdrRelayFrame(dataFrame({ seq: 3, payload: Buffer.from("gap") }))), /invalid relay frame seq/);
	});

	it("keeps stream payload opaque and rejects forbidden metadata fields", () => {
		const opaque = collect([encodeHerdrRelayFrame(frame()), encodeHerdrRelayFrame(dataFrame({ payload: Buffer.from("not base64?!") }))]);
		assert.deepEqual(opaque[1]?.payload, Buffer.from("not base64?!"));
		assert.throws(() => collect([encodeHerdrRelayFrame(frame()), rawHeader({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "exit", seq: 2, pid: 123, nonce: "nonce-1", code: 0, signal: "SIGTERM" })]), /invalid relay frame settlement/);
	});

	it("enforces max payload size while accepting payload exactly at the limit", () => {
		const exact = Buffer.alloc(HERDR_RELAY_MAX_PAYLOAD_BYTES, 0x61);
		const frames = collect([encodeHerdrRelayFrame(frame()), encodeHerdrRelayFrame(dataFrame({ payload: exact }))]);
		assert.equal(frames[1]?.payload?.length, HERDR_RELAY_MAX_PAYLOAD_BYTES);
		assert.throws(
			() => encodeHerdrRelayFrame(dataFrame({ seq: 2, payload: Buffer.alloc(HERDR_RELAY_MAX_PAYLOAD_BYTES + 1) })),
			/payload exceeds relay frame limit/,
		);
	});

	it("rejects duplicate handshake, duplicate settlement, payload after settlement, nonce mismatch, PID mismatch, and truncated frames", () => {
		const reader = createHerdrRelayReader({ expectedNonce: "nonce-1", expectedPid: 123, onFrame: () => {} });
		reader.push(encodeHerdrRelayFrame(frame()));
		assert.throws(() => reader.push(encodeHerdrRelayFrame(frame({ seq: 2 }))), /duplicate relay handshake/);

		const settled = createHerdrRelayReader({ expectedNonce: "nonce-1", expectedPid: 123, onFrame: () => {} });
		settled.push(encodeHerdrRelayFrame(frame()));
		settled.push(encodeHerdrRelayFrame(frame({ type: "exit", seq: 2, code: 0, signal: null, pgid: undefined, terminal: undefined })));
		assert.throws(() => settled.push(encodeHerdrRelayFrame(frame({ type: "error", seq: 3, message: "later", pgid: undefined, terminal: undefined }))), /frame after relay settlement/);
		assert.throws(() => settled.push(encodeHerdrRelayFrame(dataFrame({ seq: 4, payload: Buffer.from("late") }))), /frame after relay settlement/);

		const nonceReader = createHerdrRelayReader({ expectedNonce: "nonce-1", onFrame: () => {} });
		assert.throws(() => nonceReader.push(encodeHerdrRelayFrame(frame({ nonce: "wrong" }))), /relay nonce mismatch/);
		const pidReader = createHerdrRelayReader({ expectedPid: 123, onFrame: () => {} });
		assert.throws(() => pidReader.push(encodeHerdrRelayFrame(frame({ pid: 124 }))), /relay PID mismatch/);

		const truncated = createHerdrRelayReader({ onFrame: () => {} });
		truncated.push(encodeHerdrRelayFrame(frame()).subarray(0, 5));
		assert.throws(() => truncated.end(), /truncated relay frame/);
	});

	it("requires exactly one valid settlement followed by EOF", () => {
		const reader = createHerdrRelayReader({ onFrame: () => {} });
		reader.push(Buffer.concat([
			encodeHerdrRelayFrame(frame()),
			encodeHerdrRelayFrame(frame({ type: "exit", seq: 2, code: 0, signal: null, pgid: undefined, terminal: undefined })),
		]));
		assert.doesNotThrow(() => reader.end());
		assert.throws(() => collect([encodeHerdrRelayFrame(frame()), encodeHerdrRelayFrame(frame({ type: "error", seq: 2, message: "boom", pgid: undefined, terminal: undefined })), encodeHerdrRelayFrame(dataFrame({ seq: 3, payload: Buffer.from("late") }))]), /frame after relay settlement/);
	});

	it("reports relay death before settlement explicitly", () => {
		const reader = createHerdrRelayReader({ onFrame: () => {} });
		reader.push(encodeHerdrRelayFrame(frame()));
		assert.throws(() => reader.end(), /relay ended before settlement/);
	});

	it("defers EOF validation while paused and accepts buffered settlement after resume", () => {
		const frames: HerdrRelayFrame[] = [];
		const reader = createHerdrRelayReader({
			onFrame: (relayFrame) => {
				frames.push(relayFrame);
				return relayFrame.type !== "stdout";
			},
		});
		reader.push(Buffer.concat([
			encodeHerdrRelayFrame(frame()),
			encodeHerdrRelayFrame(dataFrame()),
			encodeHerdrRelayFrame(frame({ type: "exit", seq: 3, code: 0, signal: null, pgid: undefined, terminal: undefined })),
		]));
		assert.doesNotThrow(() => reader.end());
		reader.resume();
		assert.doesNotThrow(() => reader.end());
		assert.deepEqual(frames.map((relayFrame) => relayFrame.type), ["handshake", "stdout", "exit"]);
	});

	it("rejects coalesced input retained beyond one maximum-sized frame while paused", () => {
		const reader = createHerdrRelayReader({ onFrame: (relayFrame) => relayFrame.type !== "stdout" });
		const frames = [encodeHerdrRelayFrame(frame())];
		for (let seq = 2; seq < 6; seq += 1) {
			frames.push(encodeHerdrRelayFrame(dataFrame({ seq, payload: Buffer.alloc(HERDR_RELAY_MAX_PAYLOAD_BYTES, seq) })));
		}
		assert.throws(() => reader.push(Buffer.concat(frames)), /buffer limit/);
	});

	it("rejects oversized paused input before coalescing it and clears prior parser retention", () => {
		const reader = createHerdrRelayReader({
			maxPayloadBytes: 32,
			onFrame: (relayFrame) => relayFrame.type !== "stdout",
		});
		reader.push(Buffer.concat([
			encodeHerdrRelayFrame(frame()),
			encodeHerdrRelayFrame(dataFrame({ payload: Buffer.alloc(32) })),
			Buffer.from("retained"),
		]));
		const attackerChunk = Buffer.alloc(1024 * 1024);
		const originalConcat = Buffer.concat;
		let concatCalls = 0;
		Object.defineProperty(Buffer, "concat", {
			configurable: true,
			value: (...args: Parameters<typeof Buffer.concat>) => {
				concatCalls += 1;
				return originalConcat(...args);
			},
		});
		try {
			assert.throws(() => reader.push(attackerChunk), /buffer limit/);
		} finally {
			Object.defineProperty(Buffer, "concat", { configurable: true, value: originalConcat });
		}
		assert.equal(concatCalls, 0);
		reader.resume();
		assert.throws(() => reader.end(), /relay ended before settlement/);
	});

	it("exposes bounded pending bytes and drops retained state after a 64MiB coalesced rejection", () => {
		const maxPayloadBytes = 64 * 1024;
		const reader = createHerdrRelayReader({
			maxPayloadBytes,
			onFrame: (relayFrame) => relayFrame.type !== "stdout",
		});
		reader.push(Buffer.concat([
			encodeHerdrRelayFrame(frame()),
			encodeHerdrRelayFrame(dataFrame({ payload: Buffer.alloc(maxPayloadBytes) })),
		]));
		assert.equal(reader.pendingBytes <= HERDR_RELAY_HEADER_BYTES + maxPayloadBytes, true);

		assert.throws(() => reader.push(Buffer.alloc(64 * 1024 * 1024)), /buffer limit/);
		assert.equal(reader.pendingBytes, 0);
	});

	it("rejects malformed UTF-8 metadata, zero identities, unknown signals, and empty exit tuples", () => {
		assert.throws(() => collect([metadataEnvelope(1, 1, Buffer.from([0xff]))]), /UTF-8/);
		assert.throws(() => collect([encodeHerdrRelayFrame(frame({ pid: 0 }))]), /pid/);
		assert.throws(() => collect([encodeHerdrRelayFrame(frame({ pgid: 0 }))]), /pgid/);
		assert.throws(() => collect([encodeHerdrRelayFrame(frame()), encodeHerdrRelayFrame(frame({ type: "exit", seq: 2, code: null, signal: null, pgid: undefined, terminal: undefined }))]), /settlement/);
		assert.throws(() => collect([encodeHerdrRelayFrame(frame()), encodeHerdrRelayFrame(frame({ type: "exit", seq: 2, code: null, signal: "SIGMADEUP" as NodeJS.Signals, pgid: undefined, terminal: undefined }))]), /settlement/);
	});

	it("requires authenticated immutable binding before any output or settlement", () => {
		const frames: HerdrRelayFrame[] = [];
		const reader = createHerdrRelayReader({
			expectedNonce: "launch-nonce",
			expectedCapability: AUTH_CAPABILITY,
			expectedChallenge: AUTH_CHALLENGE,
			expectedPid: 123,
			expectedPgid: 123,
			expectedTerminal: BINDING_TERMINAL,
			onFrame: (relayFrame) => frames.push(relayFrame),
		});
		reader.push(Buffer.concat([
			encodeHerdrRelayFrame(challengeFrame()),
			encodeHerdrRelayFrame(authFrame()),
			encodeHerdrRelayFrame(bindFrame()),
			encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "bound", seq: 4, pid: 123, nonce: "launch-nonce", pgid: 123, terminal: BINDING_TERMINAL }),
			encodeHerdrRelayFrame(dataFrame({ seq: 5, pid: 123, nonce: "launch-nonce", payload: Buffer.from("ok") })),
			encodeHerdrRelayFrame(frame({ type: "exit", seq: 6, pid: 123, nonce: "launch-nonce", code: 0, signal: null, pgid: undefined, terminal: undefined })),
		]));
		assert.deepEqual(frames.map((relayFrame) => relayFrame.type), ["challenge", "auth", "bind", "bound", "stdout", "exit"]);

		const unauthenticated = createHerdrRelayReader({ ...AUTH_READER_OPTIONS, onFrame: () => {} });
		assert.throws(() => unauthenticated.push(encodeHerdrRelayFrame(bindFrame({ seq: 1 }))), /relay challenge required first/);
		const unbound = createHerdrRelayReader({ ...AUTH_READER_OPTIONS, onFrame: () => {} });
		unbound.push(encodeHerdrRelayFrame(challengeFrame()));
		unbound.push(encodeHerdrRelayFrame(authFrame()));
		assert.throws(() => unbound.push(encodeHerdrRelayFrame(dataFrame({ seq: 3, pid: 123, nonce: "launch-nonce" }))), /relay binding required before output/);
	});

	it("rejects wrong capability proof, metadata substitution, replayed auth, and never leaks capability material", () => {
		assert.throws(
			() => {
				const reader = createHerdrRelayReader({ ...AUTH_READER_OPTIONS, onFrame: () => {} });
				reader.push(encodeHerdrRelayFrame(challengeFrame()));
				reader.push(encodeHerdrRelayFrame(authFrame({ proof: authProof({ capability: "wrong-secret" }) })));
			},
			(error: unknown) => error instanceof HerdrRelayProtocolError && /relay capability proof mismatch/.test(error.message) && !error.message.includes("wrong-secret") && !error.message.includes("capability-secret"),
		);

		const authenticated = createHerdrRelayReader({ ...AUTH_READER_OPTIONS, onFrame: () => {} });
		authenticated.push(encodeHerdrRelayFrame(challengeFrame()));
		authenticated.push(encodeHerdrRelayFrame(authFrame()));
		assert.throws(() => authenticated.push(encodeHerdrRelayFrame(authFrame({ seq: 3 }))), /duplicate relay auth/);

		const substituted = createHerdrRelayReader({
			expectedNonce: "launch-nonce",
			expectedCapability: AUTH_CAPABILITY,
			expectedChallenge: AUTH_CHALLENGE,
			expectedPid: 123,
			expectedPgid: 123,
			expectedTerminal: BINDING_TERMINAL,
			onFrame: () => {},
		});
		substituted.push(encodeHerdrRelayFrame(challengeFrame()));
		substituted.push(encodeHerdrRelayFrame(authFrame()));
		assert.throws(() => substituted.push(encodeHerdrRelayFrame(bindFrame({ terminal: { workspaceId: "w1", tabId: "w1:t9", paneId: "w1:p1", terminalId: "term_1" } }))), /relay terminal mismatch/);
	});

	it("rejects cross-reader replay and malformed auth frames without putting the secret on wire", () => {
		const transcript = Buffer.concat([
			encodeHerdrRelayFrame(challengeFrame()),
			encodeHerdrRelayFrame(authFrame()),
			encodeHerdrRelayFrame(bindFrame()),
			encodeHerdrRelayFrame(bindFrame({ type: "bound", seq: 4 })),
			encodeHerdrRelayFrame(frame({ type: "exit", seq: 5, pid: 123, nonce: "launch-nonce", code: 0, signal: null, pgid: undefined, terminal: undefined })),
		]);
		const accepted: HerdrRelayFrame[] = [];
		const first = createHerdrRelayReader({ expectedNonce: "launch-nonce", expectedCapability: AUTH_CAPABILITY, expectedChallenge: AUTH_CHALLENGE, expectedPid: 123, expectedPgid: 123, expectedTerminal: BINDING_TERMINAL, onFrame: (relayFrame) => accepted.push(relayFrame) });
		first.push(transcript);
		assert.deepEqual(accepted.map((relayFrame) => relayFrame.type), ["challenge", "auth", "bind", "bound", "exit"]);

		const second = createHerdrRelayReader({ expectedNonce: "launch-nonce", expectedCapability: AUTH_CAPABILITY, expectedChallenge: OTHER_AUTH_CHALLENGE, expectedPid: 123, expectedPgid: 123, expectedTerminal: BINDING_TERMINAL, onFrame: () => {} });
		assert.throws(() => second.push(transcript), /relay challenge mismatch/);

		assert.doesNotMatch(encodeHerdrRelayFrame(authFrame()).toString("utf8"), /capability-secret/);
		assert.throws(() => encodeHerdrRelayFrame({ ...authFrame(), capability: "capability-secret" } as HerdrRelayFrame), /capability must not be encoded/);
		const malformed = rawHeader({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "auth", seq: 2, pid: 1, nonce: "launch-nonce", proof: "short" });
		const malformedReader = createHerdrRelayReader({ ...AUTH_READER_OPTIONS, onFrame: () => {} });
		malformedReader.push(encodeHerdrRelayFrame(challengeFrame()));
		assert.throws(() => malformedReader.push(malformed), /invalid relay frame proof/);
	});

	it("rejects capability on every wire frame model", () => {
		const variants: HerdrRelayFrame[] = [
			frame(), challengeFrame(), authFrame(), bindFrame(), bindFrame({ type: "bound", seq: 4 }), dataFrame(), dataFrame({ type: "stderr" }),
			frame({ type: "exit", code: 0, signal: null, pgid: undefined, terminal: undefined }),
			frame({ type: "error", message: "safe", pgid: undefined, terminal: undefined }),
		];
		for (const variant of variants) {
			assert.throws(() => encodeHerdrRelayFrame({ ...variant, capability: "wire-secret" } as HerdrRelayFrame), /capability must not be encoded/);
		}
		assert.throws(() => collect([rawHeader({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "challenge", seq: 1, pid: 1, nonce: "launch-nonce", challenge: AUTH_CHALLENGE, capability: "wire-secret" })]), /unknown relay frame field/);
	});

	it("fails authenticated construction closed for every partial authoritative binding tuple", () => {
		const complete = { expectedNonce: "launch-nonce", expectedCapability: AUTH_CAPABILITY, expectedPid: 123, expectedPgid: 123, expectedTerminal: BINDING_TERMINAL };
		for (const missing of ["expectedNonce", "expectedCapability", "expectedPid", "expectedPgid", "expectedTerminal"] as const) {
			const options: Partial<typeof complete> = { ...complete };
			delete options[missing];
			assert.throws(() => createHerdrRelayReader({ ...options, onFrame: () => {} }), /complete authoritative relay binding/);
		}
		for (const expectedNonce of ["", "   ", "x".repeat(513), 7] as const) {
			assert.throws(() => createHerdrRelayReader({ ...complete, expectedNonce: expectedNonce as string, onFrame: () => {} }), /expected nonce/);
		}
		assert.throws(() => createHerdrRelayReader({ expectedChallenge: AUTH_CHALLENGE, onFrame: () => {} }), /complete authoritative relay binding/);
		assert.throws(() => createHerdrRelayReader({ expectedCapability: AUTH_CAPABILITY, expectedChallenge: AUTH_CHALLENGE, onFrame: () => {} }), /complete authoritative relay binding/);
		assert.doesNotThrow(() => createHerdrRelayReader({ ...complete, expectedChallenge: AUTH_CHALLENGE, onFrame: () => {} }));
	});

	it("rejects peer-selected and cross-launch nonce transcripts in authenticated mode", () => {
		const peerSelectedTranscript = Buffer.concat([
			encodeHerdrRelayFrame(challengeFrame({ nonce: "peer-nonce" })),
			encodeHerdrRelayFrame(authFrame({ nonce: "peer-nonce", proof: authProof({ nonce: "peer-nonce" }) })),
		]);
		const authoritative = createHerdrRelayReader({ ...AUTH_READER_OPTIONS, onFrame: () => {} });
		assert.throws(() => authoritative.push(peerSelectedTranscript), /relay nonce mismatch/);

		const nonceATranscript = Buffer.concat([
			encodeHerdrRelayFrame(challengeFrame({ nonce: "launch-nonce-a" })),
			encodeHerdrRelayFrame(authFrame({ nonce: "launch-nonce-a", proof: authProof({ nonce: "launch-nonce-a" }) })),
		]);
		const nonceBReader = createHerdrRelayReader({ ...AUTH_READER_OPTIONS, expectedNonce: "launch-nonce-b", onFrame: () => {} });
		assert.throws(() => nonceBReader.push(nonceATranscript), /relay nonce mismatch/);

		const nonceBProofReader = createHerdrRelayReader({ ...AUTH_READER_OPTIONS, expectedNonce: "launch-nonce-b", onFrame: () => {} });
		nonceBProofReader.push(encodeHerdrRelayFrame(challengeFrame({ nonce: "launch-nonce-b" })));
		assert.throws(
			() => nonceBProofReader.push(encodeHerdrRelayFrame(authFrame({ nonce: "launch-nonce-b", proof: authProof({ nonce: "launch-nonce-a" }) }))),
			/relay capability proof mismatch/,
		);
	});

	it("rejects authenticated PID substitution", () => {
		const reader = createHerdrRelayReader({ expectedNonce: "launch-nonce", expectedCapability: AUTH_CAPABILITY, expectedPid: 123, expectedPgid: 123, expectedTerminal: BINDING_TERMINAL, expectedChallenge: AUTH_CHALLENGE, onFrame: () => {} });
		reader.push(encodeHerdrRelayFrame(challengeFrame())); reader.push(encodeHerdrRelayFrame(authFrame()));
		assert.throws(() => reader.push(encodeHerdrRelayFrame(bindFrame({ pid: 124 }))), /relay PID mismatch/);
	});

	it("rejects authenticated PGID substitution", () => {
		const reader = createHerdrRelayReader({ expectedNonce: "launch-nonce", expectedCapability: AUTH_CAPABILITY, expectedPid: 123, expectedPgid: 123, expectedTerminal: BINDING_TERMINAL, expectedChallenge: AUTH_CHALLENGE, onFrame: () => {} });
		reader.push(encodeHerdrRelayFrame(challengeFrame())); reader.push(encodeHerdrRelayFrame(authFrame()));
		assert.throws(() => reader.push(encodeHerdrRelayFrame(bindFrame({ pgid: 124 }))), /relay PGID mismatch/);
	});

	for (const [field, terminal] of [
		["workspace", { ...BINDING_TERMINAL, workspaceId: "w2" }], ["tab", { ...BINDING_TERMINAL, tabId: "w1:t2" }],
		["pane", { ...BINDING_TERMINAL, paneId: "w1:p2" }], ["session", { ...BINDING_TERMINAL, terminalId: "term_2" }],
	] as const) {
		it(`rejects authenticated ${field} substitution`, () => {
			const reader = createHerdrRelayReader({ expectedNonce: "launch-nonce", expectedCapability: AUTH_CAPABILITY, expectedPid: 123, expectedPgid: 123, expectedTerminal: BINDING_TERMINAL, expectedChallenge: AUTH_CHALLENGE, onFrame: () => {} });
			reader.push(encodeHerdrRelayFrame(challengeFrame())); reader.push(encodeHerdrRelayFrame(authFrame()));
			assert.throws(() => reader.push(encodeHerdrRelayFrame(bindFrame({ terminal }))), /relay terminal mismatch/);
		});
	}

	it("rejects BIND to BOUND substitution", () => {
		const reader = createHerdrRelayReader({ expectedNonce: "launch-nonce", expectedCapability: AUTH_CAPABILITY, expectedPid: 123, expectedPgid: 123, expectedTerminal: BINDING_TERMINAL, expectedChallenge: AUTH_CHALLENGE, onFrame: () => {} });
		reader.push(Buffer.concat([encodeHerdrRelayFrame(challengeFrame()), encodeHerdrRelayFrame(authFrame()), encodeHerdrRelayFrame(bindFrame())]));
		assert.throws(() => reader.push(encodeHerdrRelayFrame(bindFrame({ type: "bound", seq: 4, terminal: { ...BINDING_TERMINAL, paneId: "w1:p2" } }))), /relay terminal mismatch|relay binding mismatch/);
	});

	it("rejects settlement before BOUND", () => {
		const reader = createHerdrRelayReader({ expectedNonce: "launch-nonce", expectedCapability: AUTH_CAPABILITY, expectedPid: 123, expectedPgid: 123, expectedTerminal: BINDING_TERMINAL, expectedChallenge: AUTH_CHALLENGE, onFrame: () => {} });
		reader.push(Buffer.concat([encodeHerdrRelayFrame(challengeFrame()), encodeHerdrRelayFrame(authFrame()), encodeHerdrRelayFrame(bindFrame())]));
		assert.throws(() => reader.push(encodeHerdrRelayFrame(frame({ type: "exit", seq: 4, pid: 123, nonce: "launch-nonce", code: 0, signal: null, pgid: undefined, terminal: undefined }))), /bound acknowledgment required/);
	});

	it("rejects late AUTH after BOUND", () => {
		const reader = createHerdrRelayReader({ expectedNonce: "launch-nonce", expectedCapability: AUTH_CAPABILITY, expectedPid: 123, expectedPgid: 123, expectedTerminal: BINDING_TERMINAL, expectedChallenge: AUTH_CHALLENGE, onFrame: () => {} });
		reader.push(Buffer.concat([encodeHerdrRelayFrame(challengeFrame()), encodeHerdrRelayFrame(authFrame()), encodeHerdrRelayFrame(bindFrame()), encodeHerdrRelayFrame(bindFrame({ type: "bound", seq: 4 }))]));
		assert.throws(() => reader.push(encodeHerdrRelayFrame(authFrame({ seq: 5 }))), /duplicate relay auth|duplicate relay binding/);
	});

	it("rejects authenticated protocol version downgrade", () => {
		const reader = createHerdrRelayReader({ expectedNonce: "launch-nonce", expectedCapability: AUTH_CAPABILITY, expectedPid: 123, expectedPgid: 123, expectedTerminal: BINDING_TERMINAL, expectedChallenge: AUTH_CHALLENGE, onFrame: () => {} });
		const downgraded = encodeHerdrRelayFrame(challengeFrame()); downgraded[4] = 0;
		assert.throws(() => reader.push(downgraded), /unsupported relay protocol version/);
	});

	it("clears retained authentication state on release and terminal EOF failure", () => {
		const released = createHerdrRelayReader({ ...AUTH_READER_OPTIONS, onFrame: () => {} });
		const partial = encodeHerdrRelayFrame(challengeFrame()).subarray(0, HERDR_RELAY_HEADER_BYTES + 3);
		released.push(partial);
		assert.equal(released.pendingBytes, partial.length);
		released.release();
		assert.equal(released.pendingBytes, 0);
		assert.throws(() => released.push(encodeHerdrRelayFrame(challengeFrame())), /relay reader released/);

		const truncated = createHerdrRelayReader({ ...AUTH_READER_OPTIONS, onFrame: () => {} });
		truncated.push(partial);
		assert.throws(() => truncated.end(), /truncated relay frame/);
		assert.equal(truncated.pendingBytes, 0);
		assert.throws(() => truncated.push(encodeHerdrRelayFrame(challengeFrame())), /truncated relay frame/);
	});
});
