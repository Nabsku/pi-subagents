import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	HERDR_RELAY_HEADER_BYTES,
	HERDR_RELAY_MAX_PAYLOAD_BYTES,
	HERDR_RELAY_PROTOCOL_VERSION,
	HerdrRelayProtocolError,
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

function dataFrame(overrides: Partial<HerdrRelayFrame> = {}): HerdrRelayFrame {
	return frame({ type: "stdout", seq: 2, payload: Buffer.from("data"), pgid: undefined, terminal: undefined, ...overrides });
}

function rawHeader(header: Record<string, unknown>): Buffer {
	const body = Buffer.from(JSON.stringify(header), "utf8");
	const typeCodes: Record<string, number> = { handshake: 1, stdout: 2, stderr: 3, exit: 4, error: 5 };
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
});
