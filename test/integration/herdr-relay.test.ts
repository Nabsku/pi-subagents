import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { createHerdrRelayManagedChild } from "../../src/runs/shared/herdr-relay.ts";
import { HERDR_RELAY_MAX_PAYLOAD_BYTES, HERDR_RELAY_PROTOCOL_VERSION, createHerdrRelayAuthProof, encodeHerdrRelayFrame, type HerdrRelayFrame } from "../../src/runs/shared/herdr-relay-protocol.ts";

function handshake(overrides: Partial<HerdrRelayFrame> = {}): HerdrRelayFrame {
	return {
		version: HERDR_RELAY_PROTOCOL_VERSION,
		type: "handshake",
		seq: 1,
		pid: 700,
		nonce: "nonce-i",
		pgid: 700,
		terminal: { workspaceId: "workspace-i", tabId: "tab-i", paneId: "pane-i", terminalId: "terminal-i" },
		...overrides,
	};
}

function auth(overrides: Partial<HerdrRelayFrame> = {}): HerdrRelayFrame {
	return { version: HERDR_RELAY_PROTOCOL_VERSION, type: "auth", seq: 2, pid: 1, nonce: "launch-i", proof: createHerdrRelayAuthProof({ capability: AUTH_CAPABILITY, challenge: AUTH_CHALLENGE, nonce: "launch-i", pid: 710, pgid: 710, terminal: BINDING_TERMINAL }), ...overrides };
}


function bind(overrides: Partial<HerdrRelayFrame> = {}): HerdrRelayFrame {
	return { version: HERDR_RELAY_PROTOCOL_VERSION, type: "bind", seq: 3, pid: 710, nonce: "launch-i", pgid: 710, terminal: BINDING_TERMINAL, ...overrides };
}

const AUTH_CHALLENGE = Buffer.alloc(32, 0xc9).toString("base64");
const AUTH_CAPABILITY = Buffer.from("cap-secret-i".padEnd(32, "\0"));
const BINDING_TERMINAL = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", terminalId: "term_i" };

function challenge(overrides: Partial<HerdrRelayFrame> = {}): HerdrRelayFrame {
	return { version: HERDR_RELAY_PROTOCOL_VERSION, type: "challenge", seq: 1, pid: 1, nonce: "launch-i", challenge: AUTH_CHALLENGE, ...overrides };
}

describe("Herdr relay reader integration", () => {
	it("keeps identity and terminal unbound until AUTH/BIND/BOUND completes", async () => {
		const relay = new PassThrough();
		const child = createHerdrRelayManagedChild({
			relay,
			expectedNonce: "launch-i",
			expectedCapability: AUTH_CAPABILITY,
			expectedChallenge: AUTH_CHALLENGE,
			expectedPid: 710,
			expectedPgid: 710,
			expectedTerminal: BINDING_TERMINAL,
		});
		assert.deepEqual(child.identity, { nonce: "launch-i", dedicatedProcessGroup: true, platform: process.platform });
		assert.equal(child.terminal, undefined);

		const stdout: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		relay.write(Buffer.concat([
			encodeHerdrRelayFrame(challenge()),
			encodeHerdrRelayFrame(auth()),
			encodeHerdrRelayFrame(bind()),
			encodeHerdrRelayFrame(bind({ type: "bound", seq: 4 })),
			encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "stdout", seq: 5, pid: 710, nonce: "launch-i", payload: Buffer.from("bound-output") }),
		]));
		relay.end(encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "exit", seq: 6, pid: 710, nonce: "launch-i", code: 0, signal: null }));

		const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
		assert.equal(code, 0);
		assert.deepEqual(child.identity, { nonce: "launch-i", pid: 710, processGroupId: 710, dedicatedProcessGroup: true, platform: process.platform });
		assert.deepEqual(child.terminal, { backend: "herdr", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", terminalId: "term_i", ownsWorkspace: false, ownsTab: false, ownsPane: false });
		assert.deepEqual(Buffer.concat(stdout), Buffer.from("bound-output"));
	});

	it("rejects authenticated relay output before binding without leaking capability or output", async () => {
		const relay = new PassThrough();
		const child = createHerdrRelayManagedChild({ relay, expectedNonce: "launch-i", expectedCapability: AUTH_CAPABILITY, expectedChallenge: AUTH_CHALLENGE, expectedPid: 710, expectedPgid: 710, expectedTerminal: BINDING_TERMINAL });
		relay.write(Buffer.concat([
			encodeHerdrRelayFrame(challenge()),
			encodeHerdrRelayFrame(auth()),
			encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "stdout", seq: 3, pid: 710, nonce: "launch-i", payload: Buffer.from("secret-before-bound") }),
		]));

		await once(child, "close");
		assert.equal(relay.destroyed, true);
		assert.match(child.lastError?.message ?? "", /relay binding required before output/);
		assert.doesNotMatch(child.lastError?.message ?? "", /cap-secret-i|secret-before-bound/);
	});

	it("routes byte-accurate stdout and stderr frames to distinct streams in per-channel order and exposes handshake identity", async () => {
		const relay = new PassThrough();
		const child = createHerdrRelayManagedChild({ relay, expectedNonce: "nonce-i", expectedPid: 700 });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

		relay.write(encodeHerdrRelayFrame(handshake()));
		relay.write(Buffer.concat([
			encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "stdout", seq: 2, pid: 700, nonce: "nonce-i", payload: Buffer.from([0xff, 0x00]) }),
			encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "stderr", seq: 3, pid: 700, nonce: "nonce-i", payload: Buffer.from("err-1") }),
			encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "stdout", seq: 4, pid: 700, nonce: "nonce-i", payload: Buffer.from("out-2") }),
		]));
		relay.end(encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "exit", seq: 5, pid: 700, nonce: "nonce-i", code: 0, signal: null }));

		const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
		assert.equal(code, 0);
		assert.equal(signal, null);
		assert.deepEqual(child.identity, { nonce: "nonce-i", pid: 700, processGroupId: 700, dedicatedProcessGroup: true, platform: process.platform });
		assert.deepEqual(child.terminal, { backend: "herdr", workspaceId: "workspace-i", tabId: "tab-i", paneId: "pane-i", terminalId: "terminal-i", ownsWorkspace: false, ownsTab: false, ownsPane: false });
		assert.deepEqual(Buffer.concat(stdout), Buffer.from([0xff, 0x00, ...Buffer.from("out-2")]));
		assert.deepEqual(Buffer.concat(stderr), Buffer.from("err-1"));
	});

	it("records a sanitized protocol error, destroys relay, and emits one close when the relay violates handshake ordering", async () => {
		const relay = new PassThrough();
		const child = createHerdrRelayManagedChild({ relay, expectedNonce: "nonce-i", expectedPid: 701 });
		let closeCount = 0;
		child.on("close", () => { closeCount += 1; });
		relay.write(encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "stdout", seq: 1, pid: 701, nonce: "nonce-i", payload: Buffer.from("super-secret-output") }));
		relay.write(encodeHerdrRelayFrame(handshake({ seq: 2, pid: 701, pgid: 701 })));

		const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(code, null);
		assert.equal(signal, null);
		assert.equal(closeCount, 1);
		assert.equal(relay.destroyed, true);
		assert.match(child.lastError?.message ?? "", /relay handshake required first/);
		assert.doesNotMatch(child.lastError?.message ?? "", /super-secret-output/);
	});

	it("reports relay death before settlement explicitly after handshake", async () => {
		const relay = new PassThrough();
		const child = createHerdrRelayManagedChild({ relay, expectedNonce: "nonce-i", expectedPid: 701 });
		relay.end(encodeHerdrRelayFrame(handshake({ pid: 701, pgid: 701 })));

		const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
		assert.equal(code, null);
		assert.equal(signal, null);
		assert.match(child.lastError?.message ?? "", /relay ended before settlement/);
	});

	it("pauses relay input on output backpressure and resumes after drain", async () => {
		const relay = new PassThrough();
		let paused = 0;
		let resumed = 0;
		const originalPause = relay.pause.bind(relay);
		const originalResume = relay.resume.bind(relay);
		relay.pause = () => { paused += 1; return originalPause(); };
		relay.resume = () => { resumed += 1; return originalResume(); };
		const child = createHerdrRelayManagedChild({ relay, expectedNonce: "nonce-i", expectedPid: 703 });
		child.stdout.pause();

		relay.write(encodeHerdrRelayFrame(handshake({ pid: 703, pgid: 703 })));
		relay.write(encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "stdout", seq: 2, pid: 703, nonce: "nonce-i", payload: Buffer.alloc(HERDR_RELAY_MAX_PAYLOAD_BYTES, 0x61) }));
		assert.equal(paused, 1);
		child.stdout.resume();
		await once(child.stdout, "drain");
		assert.equal(resumed >= 1, true);
		await child.releaseTransport();
	});

	it("releaseTransport is idempotent and tears down relay/stdout/stderr without marking success", async () => {
		const relay = new PassThrough();
		const child = createHerdrRelayManagedChild({ relay, expectedNonce: "nonce-i", expectedPid: 702 });
		await child.releaseTransport();
		await child.releaseTransport();
		assert.equal(relay.destroyed, true);
		assert.equal(child.stdout.destroyed, true);
		assert.equal(child.stderr.destroyed, true);
	});

	it("bounds coalesced output and rejects excess retained relay input", async () => {
		const relay = new PassThrough();
		const child = createHerdrRelayManagedChild({ relay, expectedNonce: "nonce-i", expectedPid: 704 });
		child.stdout.pause();
		const frames = [encodeHerdrRelayFrame(handshake({ pid: 704, pgid: 704 }))];
		for (let seq = 2; seq < 34; seq += 1) frames.push(encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "stdout", seq, pid: 704, nonce: "nonce-i", payload: Buffer.alloc(HERDR_RELAY_MAX_PAYLOAD_BYTES, seq) }));
		relay.write(Buffer.concat(frames));
		assert.equal(child.stdout.writableLength <= HERDR_RELAY_MAX_PAYLOAD_BYTES, true);
		assert.equal(relay.destroyed, true);
		assert.match(child.lastError?.message ?? "", /buffer limit/);
	});

	it("drains a buffered settlement before closing when relay EOF arrives under backpressure", async () => {
		const relay = new PassThrough();
		const child = createHerdrRelayManagedChild({ relay, expectedNonce: "nonce-i", expectedPid: 707 });
		child.stdout.pause();
		relay.end(Buffer.concat([
			encodeHerdrRelayFrame(handshake({ pid: 707, pgid: 707 })),
			encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "stdout", seq: 2, pid: 707, nonce: "nonce-i", payload: Buffer.alloc(HERDR_RELAY_MAX_PAYLOAD_BYTES, 0x61) }),
			encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "exit", seq: 3, pid: 707, nonce: "nonce-i", code: 0, signal: null }),
		]));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(child.lastError, undefined);
		child.stdout.resume();
		const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
		assert.equal(code, 0);
		assert.equal(signal, null);
	});

	it("destroys the relay and records a post-settlement protocol violation", async () => {
		const relay = new PassThrough();
		const child = createHerdrRelayManagedChild({ relay, expectedNonce: "nonce-i", expectedPid: 705 });
		let exitCount = 0;
		let closeCount = 0;
		child.on("exit", () => { exitCount += 1; });
		child.on("close", () => { closeCount += 1; });
		relay.write(Buffer.concat([
			encodeHerdrRelayFrame(handshake({ pid: 705, pgid: 705 })),
			encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "exit", seq: 2, pid: 705, nonce: "nonce-i", code: 0, signal: null }),
			encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "stdout", seq: 3, pid: 705, nonce: "nonce-i", payload: Buffer.from("late-secret") }),
		]));
		await once(child, "close");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(exitCount, 0);
		assert.equal(closeCount, 1);
		assert.equal(relay.destroyed, true);
		assert.match(child.lastError?.message ?? "", /frame after relay settlement/);
		assert.doesNotMatch(child.lastError?.message ?? "", /late-secret/);
	});

	it("suppresses a pending successful exit when the relay fails before EOF validation", async () => {
		const relay = new PassThrough();
		const child = createHerdrRelayManagedChild({ relay, expectedNonce: "nonce-i", expectedPid: 708 });
		let exitCount = 0;
		let closeCount = 0;
		child.on("exit", () => { exitCount += 1; });
		child.on("close", () => { closeCount += 1; });

		relay.write(Buffer.concat([
			encodeHerdrRelayFrame(handshake({ pid: 708, pgid: 708 })),
			encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "exit", seq: 2, pid: 708, nonce: "nonce-i", code: 0, signal: null }),
		]));
		relay.destroy(new Error("relay died after exit"));

		const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(code, null);
		assert.equal(signal, null);
		assert.equal(exitCount, 0);
		assert.equal(closeCount, 1);
		assert.match(child.lastError?.message ?? "", /relay died after exit/);
	});

	it("never exposes peer ERROR text in diagnostics", async () => {
		const relay = new PassThrough();
		const child = createHerdrRelayManagedChild({ relay, expectedNonce: "nonce-i", expectedPid: 706 });
		relay.end(Buffer.concat([
			encodeHerdrRelayFrame(handshake({ pid: 706, pgid: 706 })),
			encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "error", seq: 2, pid: 706, nonce: "nonce-i", message: "secret-token-736563726574" }),
		]));
		await once(child, "close");
		assert.equal(child.lastError?.message, "Herdr relay reported a transport error");
	});
});
