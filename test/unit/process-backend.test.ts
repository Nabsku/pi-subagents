import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
	createChildProcessBackend,
	createHeadlessProcessBackend,
	type ChildLaunchRequest,
	type SpawnLike,
} from "../../src/runs/shared/process-backend.ts";
import { resolveTerminalConfig } from "../../src/runs/shared/terminal-config.ts";
import { HERDR_RELAY_PROTOCOL_VERSION, encodeHerdrRelayFrame, type HerdrRelayFrame } from "../../src/runs/shared/herdr-relay-protocol.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../src/shared/post-exit-stdio-guard.ts";

const pluginRunnerPath = path.resolve(process.cwd(), "../herdr-pi-subagents/scripts/relay-runner.mjs");

function request(overrides: Partial<ChildLaunchRequest> = {}): ChildLaunchRequest {
	return {
		command: process.execPath,
		args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
		cwd: process.cwd(),
		env: { ...process.env, PROCESS_BACKEND_TEST: "yes" },
		label: "unit child",
		runId: "run-123",
		childIndex: 2,
		...overrides,
	};
}

function launchHerdrRunner(input: ChildLaunchRequest): ReturnType<typeof spawn> {
	const runner = spawn(input.command, input.args, {
		cwd: input.cwd,
		env: { ...input.env, PI_HERDR_RETENTION_MS: input.env.PI_HERDR_RETENTION_MS ?? "150" },
		stdio: "ignore",
	});
	return runner;
}

async function waitForRunnerClose(runner: ReturnType<typeof spawn>): Promise<void> {
	if (runner.exitCode !== null || runner.signalCode !== null) return;
	await once(runner, "close");
}

function rawHandshakeFrame(frame: HerdrRelayFrame): Buffer {
	const body = Buffer.from(JSON.stringify(frame));
	const envelope = Buffer.alloc(20);
	Buffer.from("HRLY").copy(envelope);
	envelope[4] = HERDR_RELAY_PROTOCOL_VERSION;
	envelope[5] = 1;
	envelope.writeUInt32BE(body.length, 8);
	envelope.writeBigUInt64BE(BigInt(frame.seq), 12);
	return Buffer.concat([envelope, body]);
}

function validHandshake(nonce: string): HerdrRelayFrame {
	return {
		version: HERDR_RELAY_PROTOCOL_VERSION,
		type: "handshake",
		seq: 1,
		pid: 12345,
		nonce,
		pgid: 12345,
		terminal: { workspaceId: "local", tabId: "local:tab", paneId: "local:pane" },
	};
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function waitForCloseIgnoringExpectedError(child: { once(event: string, listener: (...args: any[]) => void): unknown }): Promise<void> {
	await new Promise<void>((resolve) => {
		child.once("error", () => {});
		child.once("close", () => resolve());
	});
}

describe("process backend selection", () => {
	it("uses the headless backend for omitted config without probing Herdr", async () => {
		let herdrProbeCount = 0;
		const backend = createChildProcessBackend(undefined, {
			herdrProbe: () => {
				herdrProbeCount += 1;
				throw new Error("Herdr must not be probed for default headless launches");
			},
		});
		const child = await backend.launch(request());
		child.kill("SIGTERM");
		await child.releaseTransport();
		assert.equal(herdrProbeCount, 0);
		assert.equal(child.terminal, undefined);
	});

	it("uses the headless backend for explicit headless config without probing Herdr", async () => {
		let herdrProbeCount = 0;
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "headless" }), {
			herdrProbe: () => {
				herdrProbeCount += 1;
				throw new Error("Herdr must not be probed for explicit headless launches");
			},
		});
		const child = await backend.launch(request());
		child.kill("SIGTERM");
		await child.releaseTransport();
		assert.equal(herdrProbeCount, 0);
	});

	it("launches the standalone Herdr plugin backend through a private descriptor", { skip: !fs.existsSync(pluginRunnerPath) ? "standalone plugin checkout unavailable" : undefined }, async () => {
		let launch: ChildLaunchRequest | undefined;
		let runner: ReturnType<typeof spawn> | undefined;
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", terminalId: "term_plugin", ownsWorkspace: false, ownsTab: false, ownsPane: true };
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr-plugin", placement: "pane", closeOnExit: true }), {
			herdrAdapter: {
				startChild: async () => { throw new Error("embedded Herdr backend must not be used"); },
				startPluginChild: async (input) => {
					launch = input;
					runner = spawn(process.execPath, [pluginRunnerPath], { cwd: input.cwd, env: { ...input.env, PI_SUBAGENTS_LAUNCH_FILE: input.pluginLaunchFile! }, stdio: "ignore" });
					return terminal;
				},
				close: async () => ({ closed: true }),
			},
		});
		const child = await backend.launch(request({ args: ["-e", "process.stdout.write('plugin-out')"] }));
		const output: Buffer[] = [];
		child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
		await once(child, "close");
		assert.equal(Buffer.concat(output).toString(), "plugin-out");
		assert.ok(launch?.pluginLaunchFile);
		assert.equal(launch?.placement, "pane");
		assert.equal(launch?.command, process.execPath);
		assert.deepEqual(launch?.args, ["-e", "process.stdout.write('plugin-out')"]);
		assert.equal(fs.existsSync(path.dirname(launch!.pluginLaunchFile!)), false);
		assert.ok(runner);
		await waitForRunnerClose(runner!);
	});

	it("launches the explicit local Herdr backend through the adapter and leaves only a bounded retained pane host", async () => {
		let launch: ChildLaunchRequest | undefined;
		let runner: ReturnType<typeof spawn> | undefined;
		let closeCount = 0;
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", terminalId: "term_test", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr", closeOnExit: false }), {
			herdrAdapter: {
				startChild: async (input) => {
					launch = input;
					runner = launchHerdrRunner(input);
					return terminal;
				},
				close: async () => { closeCount += 1; return { closed: true }; },
			},
		});
		const child = await backend.launch(request({ args: ["-e", "process.stdout.write('relay-out'); process.stderr.write('relay-err')"] }));
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
		assert.equal(code, 0);
		assert.equal(Buffer.concat(stdout).toString(), "relay-out");
		assert.equal(Buffer.concat(stderr).toString(), "relay-err");
		assert.deepEqual(child.terminal, terminal);
		assert.equal(closeCount, 0);
		assert.ok(launch);
		assert.equal(launch.command, process.execPath);
		assert.match(launch.args[0], /herdr-relay-runner\.mjs$/);
		assert.equal(launch.args[3], "retain");
		assert.equal(launch.args.at(-2), "-e");
		assert.equal(launch.args.at(-1), "process.stdout.write('relay-out'); process.stderr.write('relay-err')");
		assert.equal(launch.args.join(" ").includes("SECRET_TOKEN"), false);
		assert.equal(fs.existsSync(path.dirname(launch.args[1])), false, "relay socket and temp directory survived clean EOF");
		assert.ok(runner);
		assert.equal(runner.exitCode, null, "retained pane host exited before its bounded TTL");
		await Promise.race([
			waitForRunnerClose(runner),
			new Promise((_, reject) => setTimeout(() => reject(new Error("bounded retained pane host did not expire")), 1_000)),
		]);
	});

	it("never retains a pane host in close mode", async () => {
		let runner: ReturnType<typeof spawn> | undefined;
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr", closeOnExit: true }), {
			herdrAdapter: {
				startChild: async (input) => { runner = launchHerdrRunner(input); return terminal; },
				close: async () => ({ closed: true }),
			},
		});
		const child = await backend.launch(request());
		await once(child, "close");
		assert.ok(runner);
		await Promise.race([
			waitForRunnerClose(runner),
			new Promise((_, reject) => setTimeout(() => reject(new Error("close-mode runner leaked")), 1_000)),
		]);
	});

	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		it(`does not retain after repeated ${signal} requests while the child is active`, async () => {
			let runner: ReturnType<typeof spawn> | undefined;
			let socketPath = "";
			const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
			const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr", closeOnExit: false }), {
				herdrAdapter: {
					startChild: async (input) => { socketPath = input.args[1]; runner = launchHerdrRunner(input); return terminal; },
					close: async () => ({ closed: true }),
				},
			});
			const child = await backend.launch(request({
				args: ["-e", `let count=0;process.on(${JSON.stringify(signal)},()=>{if(++count===2)process.exit(0)});process.stdout.write('ready');setInterval(()=>{},1000)`],
			}));
			let output = "";
			child.stdout.on("data", (chunk) => { output += String(chunk); });
			await waitFor(() => output === "ready", "child did not install its signal handler");
			assert.ok(runner);
			const childClose = once(child, "close");
			runner.kill(signal);
			await new Promise((resolve) => setTimeout(resolve, 25));
			runner.kill(signal);
			await Promise.race([
				waitForRunnerClose(runner),
				new Promise((_, reject) => setTimeout(() => reject(new Error(`${signal} left a retained pane host`)), 1_000)),
			]);
			await childClose;
			assert.equal(fs.existsSync(path.dirname(socketPath)), false);
		});
	}

	it("keeps launch pending until a delayed validated process-group handshake", async () => {
		let socket: net.Socket | undefined;
		let nonce = "";
		const killCalls: Array<[number, NodeJS.Signals | number | undefined]> = [];
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			processKill: ((pid, signal) => { killCalls.push([pid, signal]); return true; }) as typeof process.kill,
			herdrAdapter: {
				startChild: async (input) => { nonce = input.args[2]; socket = net.createConnection(input.args[1]); await once(socket, "connect"); return terminal; },
				close: async () => ({ closed: true }),
			},
		});
		let resolved = false;
		const launch = backend.launch(request()).then((child) => { resolved = true; return child; });
		await waitFor(() => socket !== undefined, "adapter did not connect");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(resolved, false);
		socket!.write(encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 1, pid: 12345, nonce, pgid: 12345, terminal: { workspaceId: "local", tabId: "local:tab", paneId: "local:pane" } }));
		const child = await launch;
		assert.equal(child.pid, 12345);
		assert.equal(child.identity.processGroupId, 12345);
		assert.equal(child.kill("SIGTERM"), true);
		assert.deepEqual(killCalls, [[-12345, "SIGTERM"]]);
		await child.releaseTransport();
	});

	it("rejects and cleans up when relay readiness times out", async () => {
		let socketPath = "";
		let closeCount = 0;
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrReadinessTimeoutMs: 25,
			herdrAdapter: {
				startChild: async (input) => { socketPath = input.args[1]; return terminal; },
				close: async () => { closeCount += 1; return { closed: true }; },
			},
		});
		await assert.rejects(() => backend.launch(request()), /launch readiness timed out/);
		assert.equal(closeCount, 1);
		assert.equal(fs.existsSync(path.dirname(socketPath)), false);
	});

	it("bounds a never-returning adapter launch and removes relay resources at the shared deadline", async () => {
		let socketPath = "";
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrReadinessTimeoutMs: 30,
			herdrAdapter: {
				startChild: async (input) => {
					socketPath = input.args[1];
					return await new Promise<never>(() => {});
				},
				close: async () => ({ closed: true }),
			},
		});
		const startedAt = Date.now();
		await assert.rejects(() => backend.launch(request()), /readiness timed out/);
		assert.ok(Date.now() - startedAt < 250, "adapter launch escaped the configured deadline");
		assert.equal(fs.existsSync(path.dirname(socketPath)), false);
	});

	it("closes a terminal handle that arrives after the launch deadline exactly once", async () => {
		let socketPath = "";
		let resolveStart!: (handle: any) => void;
		const closed: string[] = [];
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrReadinessTimeoutMs: 25,
			herdrAdapter: {
				startChild: async (input) => {
					socketPath = input.args[1];
					return await new Promise((resolve) => { resolveStart = resolve; });
				},
				close: async (handle) => { closed.push(handle.paneId); return { closed: true }; },
			},
		});
		await assert.rejects(() => backend.launch(request()), /readiness timed out/);
		assert.equal(fs.existsSync(path.dirname(socketPath)), false);
		resolveStart(terminal);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(closed, [terminal.paneId]);
	});

	it("accepts identity-first launch only after the owned handle arrives", async () => {
		let resolveStart!: (handle: any) => void;
		let identitySent = false;
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrReadinessTimeoutMs: 200,
			herdrAdapter: {
				startChild: async (input) => {
					const socket = net.createConnection(input.args[1]);
					await once(socket, "connect");
					socket.write(encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 1, pid: 12345, nonce: input.args[2], pgid: 12345, terminal: { workspaceId: "local", tabId: "local:tab", paneId: "local:pane" } }));
					identitySent = true;
					return await new Promise((resolve) => { resolveStart = resolve; });
				},
				close: async () => ({ closed: true }),
			},
		});
		let resolved = false;
		const launch = backend.launch(request()).then((child) => { resolved = true; return child; });
		await waitFor(() => identitySent, "identity was not sent");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(resolved, false);
		resolveStart(terminal);
		const child = await launch;
		assert.deepEqual(child.terminal, terminal);
		await child.releaseTransport();
	});

	it("bounds identity-first launch when the adapter never returns its owned handle", async () => {
		let socketPath = "";
		let identitySent = false;
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrReadinessTimeoutMs: 30,
			herdrAdapter: {
				startChild: async (input) => {
					socketPath = input.args[1];
					const socket = net.createConnection(socketPath);
					await once(socket, "connect");
					socket.write(encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 1, pid: 12345, nonce: input.args[2], pgid: 12345, terminal: { workspaceId: "local", tabId: "local:tab", paneId: "local:pane" } }));
					identitySent = true;
					return await new Promise<never>(() => {});
				},
				close: async () => ({ closed: true }),
			},
		});
		const startedAt = Date.now();
		await assert.rejects(() => backend.launch(request()), /launch readiness timed out/);
		assert.equal(identitySent, true);
		assert.ok(Date.now() - startedAt < 250, "identity-first adapter launch escaped the absolute deadline");
		assert.equal(fs.existsSync(path.dirname(socketPath)), false);
	});

	it("closes an identity-first terminal handle that arrives after timeout exactly once", async () => {
		let resolveStart!: (handle: any) => void;
		let identitySent = false;
		const closed: string[] = [];
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrReadinessTimeoutMs: 30,
			herdrAdapter: {
				startChild: async (input) => {
					const socket = net.createConnection(input.args[1]);
					await once(socket, "connect");
					socket.write(encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 1, pid: 12345, nonce: input.args[2], pgid: 12345, terminal: { workspaceId: "local", tabId: "local:tab", paneId: "local:pane" } }));
					identitySent = true;
					return await new Promise((resolve) => { resolveStart = resolve; });
				},
				close: async (handle) => { closed.push(handle.paneId); return { closed: true }; },
			},
		});
		await assert.rejects(() => backend.launch(request()), /launch readiness timed out/);
		assert.equal(identitySent, true);
		resolveStart(terminal);
		await waitFor(() => closed.length === 1, "late identity-first handle was not closed");
		assert.deepEqual(closed, [terminal.paneId]);
	});

	it("consumes an identity-first adapter rejection after timeout", async () => {
		let rejectStart!: (error: Error) => void;
		let identitySent = false;
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrReadinessTimeoutMs: 30,
			herdrAdapter: {
				startChild: async (input) => {
					const socket = net.createConnection(input.args[1]);
					await once(socket, "connect");
					socket.write(encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 1, pid: 12345, nonce: input.args[2], pgid: 12345, terminal: { workspaceId: "local", tabId: "local:tab", paneId: "local:pane" } }));
					identitySent = true;
					return await new Promise((_, reject) => { rejectStart = reject; });
				},
				close: async () => ({ closed: true }),
			},
		});
		await assert.rejects(() => backend.launch(request()), /launch readiness timed out/);
		assert.equal(identitySent, true);
		rejectStart(new Error("late adapter rejection"));
		await new Promise((resolve) => setImmediate(resolve));
	});

	it("lets the already-registered deadline win an identity-first boundary race", async () => {
		const closed: string[] = [];
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrReadinessTimeoutMs: 30,
			herdrAdapter: {
				startChild: async (input) => {
					const socket = net.createConnection(input.args[1]);
					await once(socket, "connect");
					socket.write(encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 1, pid: 12345, nonce: input.args[2], pgid: 12345, terminal: { workspaceId: "local", tabId: "local:tab", paneId: "local:pane" } }));
					return await new Promise((resolve) => setTimeout(() => resolve(terminal), 30));
				},
				close: async (handle) => { closed.push(handle.paneId); return { closed: true }; },
			},
		});
		await assert.rejects(() => backend.launch(request()), /launch readiness timed out/);
		await waitFor(() => closed.length === 1, "boundary-race handle was not closed");
		assert.deepEqual(closed, [terminal.paneId]);
	});

	it("cleans relay resources when adapter start fails before terminal ownership", async () => {
		let socketPath = "";
		let closeCount = 0;
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrAdapter: {
				startChild: async (input) => { socketPath = input.args[1]; throw new Error("adapter start failed"); },
				close: async () => { closeCount += 1; return { closed: true }; },
			},
		});
		await assert.rejects(() => backend.launch(request()), /adapter start failed/);
		assert.equal(closeCount, 0);
		assert.equal(fs.existsSync(path.dirname(socketPath)), false);
	});

	it("rejects relay close before readiness without unhandled error events", async () => {
		let socketPath = "";
		let closeCount = 0;
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrReadinessTimeoutMs: 200,
			herdrAdapter: {
				startChild: async (input) => { socketPath = input.args[1]; const socket = net.createConnection(socketPath); await once(socket, "connect"); socket.end(); return terminal; },
				close: async () => { closeCount += 1; return { closed: true }; },
			},
		});
		await assert.rejects(() => backend.launch(request()), /relay failed before identity readiness/);
		assert.equal(closeCount, 1);
		assert.equal(fs.existsSync(path.dirname(socketPath)), false);
	});

	it("rejects immediately when identity is followed by relay EOF while the adapter remains pending", async () => {
		let socketPath = "";
		let resolveIdentity!: () => void;
		const identityReady = new Promise<void>((resolve) => { resolveIdentity = resolve; });
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrReadinessTimeoutMs: 1_000,
			onHerdrIdentityReady: resolveIdentity,
			herdrAdapter: {
				startChild: async (input) => {
					socketPath = input.args[1];
					const socket = net.createConnection(socketPath);
					await once(socket, "connect");
					socket.write(encodeHerdrRelayFrame(validHandshake(input.args[2])));
					await identityReady;
					socket.end();
					return await new Promise<never>(() => {});
				},
				close: async () => ({ closed: true }),
			},
		});
		const startedAt = Date.now();
		await assert.rejects(() => backend.launch(request()), (error: Error) => {
			assert.doesNotMatch(error.message, /invalid relay frame terminal|identity readiness/);
			assert.match(error.message, /relay (?:closed|failed|ended).*before launch completed/i);
			return true;
		});
		assert.ok(Date.now() - startedAt < 500, "pre-launch relay EOF waited for the absolute deadline");
		assert.equal(fs.existsSync(path.dirname(socketPath)), false);
	});

	for (const settlement of [
		{ name: "relay error", expected: /failed before launch completed: Herdr relay reported a transport error/, frame: (nonce: string) => encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "error", seq: 2, pid: 12345, nonce, message: "runner failed" }) },
		{ name: "malformed post-identity frame", expected: /failed before launch completed: invalid relay frame seq/, frame: (nonce: string) => encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "stdout", seq: 1, pid: 12345, nonce, payload: Buffer.from("bad sequence") }) },
		{ name: "child settlement", expected: /child settled before launch completed/i, frame: (nonce: string) => encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "exit", seq: 2, pid: 12345, nonce, code: 0, signal: null }) },
	]) {
		it(`rejects ${settlement.name} after identity but before terminal ownership`, async () => {
			let socketPath = "";
			let resolveIdentity!: () => void;
			const identityReady = new Promise<void>((resolve) => { resolveIdentity = resolve; });
			const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
				herdrReadinessTimeoutMs: 1_000,
				onHerdrIdentityReady: resolveIdentity,
				herdrAdapter: {
					startChild: async (input) => {
						socketPath = input.args[1];
						const socket = net.createConnection(socketPath);
						await once(socket, "connect");
						socket.write(encodeHerdrRelayFrame(validHandshake(input.args[2])));
						await identityReady;
						socket.end(settlement.frame(input.args[2]));
						return await new Promise<never>(() => {});
					},
					close: async () => ({ closed: true }),
				},
			});
			const startedAt = Date.now();
			await assert.rejects(() => backend.launch(request()), (error: Error) => {
				assert.doesNotMatch(error.message, /invalid relay frame terminal|identity readiness/);
				assert.match(error.message, settlement.expected);
				return true;
			});
			assert.ok(Date.now() - startedAt < 500, `${settlement.name} waited for the launch deadline`);
			assert.equal(fs.existsSync(path.dirname(socketPath)), false);
		});
	}

	it("turns a throwing identity-ready callback into an isolated pre-launch failure", async () => {
		let socketPath = "";
		let resolveStart!: (handle: any) => void;
		const closed: string[] = [];
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		const unrelated = { ...terminal, paneId: "w1:unrelated" };
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrReadinessTimeoutMs: 1_000,
			onHerdrIdentityReady: () => { throw new Error("identity callback boom"); },
			herdrAdapter: {
				startChild: async (input) => {
					socketPath = input.args[1];
					const socket = net.createConnection(socketPath);
					await once(socket, "connect");
					socket.write(encodeHerdrRelayFrame(validHandshake(input.args[2])));
					return await new Promise((resolve) => { resolveStart = resolve; });
				},
				close: async (handle) => { closed.push(handle.paneId); return { closed: true }; },
			},
		});
		const startedAt = Date.now();
		await assert.rejects(() => backend.launch(request()), /identity readiness callback failed: identity callback boom/);
		assert.ok(Date.now() - startedAt < 500, "callback failure waited for the launch deadline");
		assert.equal(fs.existsSync(path.dirname(socketPath)), false);
		resolveStart(terminal);
		await waitFor(() => closed.length === 1, "late handle after callback failure was not closed");
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(closed, [terminal.paneId]);
		assert.equal(closed.includes(unrelated.paneId), false);
	});

	it("closes a handle exactly once when relay failure wins before identity", async () => {
		let socketPath = "";
		const closed: string[] = [];
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrReadinessTimeoutMs: 1_000,
			herdrAdapter: {
				startChild: async (input) => {
					socketPath = input.args[1];
					const socket = net.createConnection(socketPath);
					await once(socket, "connect");
					socket.end();
					return terminal;
				},
				close: async (handle) => { closed.push(handle.paneId); return { closed: true }; },
			},
		});
		await assert.rejects(() => backend.launch(request()), /relay/);
		assert.deepEqual(closed, [terminal.paneId]);
		assert.equal(fs.existsSync(path.dirname(socketPath)), false);
	});

	it("closes a late handle exactly once after pre-launch relay failure", async () => {
		let resolveStart!: (handle: any) => void;
		let socketPath = "";
		const closed: string[] = [];
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrReadinessTimeoutMs: 1_000,
			herdrAdapter: {
				startChild: async (input) => {
					socketPath = input.args[1];
					const socket = net.createConnection(socketPath);
					await once(socket, "connect");
					socket.end();
					return await new Promise((resolve) => { resolveStart = resolve; });
				},
				close: async (handle) => { closed.push(handle.paneId); return { closed: true }; },
			},
		});
		await assert.rejects(() => backend.launch(request()), /relay/);
		assert.equal(fs.existsSync(path.dirname(socketPath)), false);
		resolveStart(terminal);
		await waitFor(() => closed.length === 1, "late handle after relay failure was not closed");
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(closed, [terminal.paneId]);
	});

	it("keeps the production-disabled local-only endpoint from granting signal authority to invalid identity frames", async () => {
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		const killCalls: Array<[number, NodeJS.Signals | number | undefined]> = [];
		const cases: Array<{ name: string; frames: HerdrRelayFrame[] }> = [
			{ name: "mismatched group", frames: [{ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 1, pid: 11111, nonce: "nonce", pgid: 22222 }] },
			{ name: "missing group", frames: [{ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 1, pid: 11111, nonce: "nonce" }] },
			{ name: "zero pid", frames: [{ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 1, pid: 0, nonce: "nonce", pgid: 0 }] },
			{ name: "negative group", frames: [{ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 1, pid: 1, nonce: "nonce", pgid: -1 }] },
			{ name: "unsafe pid", frames: [{ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 1, pid: Number.MAX_SAFE_INTEGER + 1, nonce: "nonce", pgid: Number.MAX_SAFE_INTEGER + 1 }] },
			{ name: "duplicate identity", frames: [
				{ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 1, pid: 11111, nonce: "nonce", pgid: 11111 },
				{ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 2, pid: 11111, nonce: "nonce", pgid: 11111 },
			] },
		];
		for (const testCase of cases) {
			let socketPath = "";
			const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
				processKill: ((pid, signal) => { killCalls.push([pid, signal]); return true; }) as typeof process.kill,
				herdrAdapter: {
					startChild: async (input) => {
						socketPath = input.args[1];
						const socket = net.createConnection(socketPath);
						await once(socket, "connect");
						socket.end(Buffer.concat(testCase.frames.map((frame) => rawHandshakeFrame({ ...frame, nonce: input.args[2], terminal: { workspaceId: "local", tabId: "local:tab", paneId: "local:pane" } }))));
						return terminal;
					},
					close: async () => ({ closed: true }),
				},
			});
			await assert.rejects(() => backend.launch(request()), /Herdr relay failed before identity readiness/, testCase.name);
			assert.equal(fs.existsSync(path.dirname(socketPath)), false, `${testCase.name} temp resources`);
		}
		assert.deepEqual(killCalls, []);
	});

	it("signals only the validated leader process group after transport release", async () => {
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		const killCalls: Array<[number, NodeJS.Signals | number | undefined]> = [];
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			processKill: ((pid, signal) => { killCalls.push([pid, signal]); return true; }) as typeof process.kill,
			herdrAdapter: {
				startChild: async (input) => {
					const socket = net.createConnection(input.args[1]);
					await once(socket, "connect");
					socket.write(encodeHerdrRelayFrame({ version: HERDR_RELAY_PROTOCOL_VERSION, type: "handshake", seq: 1, pid: 12345, nonce: input.args[2], pgid: 12345, terminal: { workspaceId: "local", tabId: "local:tab", paneId: "local:pane" } }));
					return terminal;
				},
				close: async () => ({ closed: true }),
			},
		});
		const child = await backend.launch(request());
		await waitFor(() => child.identity.processGroupId === 12345, "valid process group was not bound");
		await child.releaseTransport();
		assert.deepEqual(killCalls, []);
		assert.equal(child.kill("SIGTERM"), true);
		assert.equal(child.kill("SIGKILL"), true);
		assert.deepEqual(killCalls, [[-12345, "SIGTERM"], [-12345, "SIGKILL"]]);
	});

	it("routes stop to the pane relay and fails explicitly when the local runner is missing", async () => {
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		let runner: ReturnType<typeof spawn> | undefined;
		const adapter = { startChild: async (input: ChildLaunchRequest) => { runner = launchHerdrRunner(input); return terminal; }, close: async () => ({ closed: true }) };
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), { herdrAdapter: adapter });
		const child = await backend.launch(request({ args: ["-e", "setInterval(() => {}, 1000)"] }));
		await waitFor(() => child.identity.processGroupId !== undefined, "Herdr relay did not publish its process group");
		assert.equal(child.kill("SIGTERM"), true);
		const [, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
		assert.equal(signal, "SIGTERM");
		assert.ok(runner);
		runner.kill("SIGTERM");
		await once(runner, "close");

		const missing = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), { herdrAdapter: adapter, herdrRunnerPath: "/definitely/missing/herdr-relay-runner.mjs" });
		await assert.rejects(() => missing.launch(request()), /Herdr relay runner not found/);
	});

	it("resolves the packaged runner outside the caller cwd and preserves TERM-to-KILL after transport release", async () => {
		const unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-cwd-"));
		const termMarker = path.join(unrelatedCwd, "term-seen");
		const terminal = { backend: "herdr" as const, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", ownsWorkspace: false, ownsTab: true, ownsPane: true };
		let launch: ChildLaunchRequest | undefined;
		let runner: ReturnType<typeof spawn> | undefined;
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			herdrAdapter: {
				startChild: async (input) => { launch = input; runner = launchHerdrRunner(input); return terminal; },
				close: async () => ({ closed: true }),
			},
		});
		try {
			const child = await backend.launch(request({
				cwd: unrelatedCwd,
				args: ["-e", `const fs=require('node:fs');process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(termMarker)},'yes'));process.stdout.write('ready');setInterval(()=>{},1000)`],
			}));
			let output = "";
			child.stdout.on("data", (chunk) => { output += String(chunk); });
			await waitFor(() => child.pid !== undefined, "Herdr relay did not handshake");
			await waitFor(() => output === "ready", "child did not become signal-ready");
			assert.ok(launch);
			assert.equal(path.isAbsolute(launch.args[0]), true);
			assert.equal(fs.existsSync(launch.args[0]), true);
			await child.releaseTransport();
			await child.releaseTransport();
			assert.equal(fs.existsSync(termMarker), false);
			assert.equal(child.kill("SIGTERM"), true);
			await waitFor(() => fs.existsSync(termMarker), "SIGTERM did not reach child after transport release");
			assert.equal(child.kill("SIGKILL"), true);
			await waitFor(() => {
				try { process.kill(child.pid!, 0); return false; } catch { return true; }
			}, "SIGKILL did not terminate child after transport release");
			assert.ok(runner);
			runner.kill("SIGTERM");
			await once(runner, "close");
		} finally {
			runner?.kill("SIGKILL");
			fs.rmSync(unrelatedCwd, { recursive: true, force: true });
		}
	});
});

describe("headless process backend", () => {
	it("passes command, argv, cwd, env, stdio, and windowsHide to spawn structurally", async () => {
		let captured: Parameters<typeof spawn> | undefined;
		const backend = createHeadlessProcessBackend({
			spawn: ((...args: Parameters<typeof spawn>) => {
				captured = args;
				return spawn(...args);
			}) as SpawnLike,
		});
		const args = ["-e", "process.exit(0)", "space arg", 'quote " arg', "unicode-π", "semi;$(no-shell)"];
		const env = { ...process.env, STRUCTURED_ARG_TEST: "a=b c" };
		const child = await backend.launch(request({ args, env }));
		await once(child, "close");
		assert.ok(captured);
		assert.equal(captured[0], process.execPath);
		assert.deepEqual(captured[1], args);
		assert.deepEqual(captured[2], {
			cwd: process.cwd(),
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	});

	it("exposes PID, identity, destroyable streams, output, and exit/close ordering", async () => {
		const backend = createHeadlessProcessBackend();
		const child = await backend.launch(request({
			args: ["-e", "process.stdout.write('stdout'); process.stderr.write('stderr')"],
		}));
		const events: string[] = [];
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
		child.on("exit", () => events.push("exit"));
		child.on("close", () => events.push("close"));
		await once(child, "close");
		assert.equal(child.pid, child.identity.pid);
		assert.equal(child.identity.platform, process.platform);
		assert.equal(child.identity.dedicatedProcessGroup, false);
		assert.match(child.identity.nonce, /^[a-f0-9-]{36}$/);
		assert.equal(Buffer.concat(stdoutChunks).toString(), "stdout");
		assert.equal(Buffer.concat(stderrChunks).toString(), "stderr");
		assert.deepEqual(events, ["exit", "close"]);
		assert.equal(typeof child.stdout.destroy, "function");
		assert.equal(typeof child.stderr.destroy, "function");
	});

	it("signals the real child process and remains compatible with post-exit stdio guard", async () => {
		const backend = createHeadlessProcessBackend();
		const child = await backend.launch(request({ args: ["-e", "setInterval(() => {}, 1000)"] }));
		const cleanup = attachPostExitStdioGuard(child, { idleMs: 5, hardMs: 10 });
		assert.equal(trySignalChild(child, "SIGTERM"), true);
		const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
		cleanup();
		assert.equal(code, null);
		assert.equal(signal, "SIGTERM");
	});

	it("rejects NUL in command, cwd, args, and env before spawning", async () => {
		let spawnCount = 0;
		const backend = createHeadlessProcessBackend({
			spawn: ((...args: Parameters<typeof spawn>) => {
				spawnCount += 1;
				return spawn(...args);
			}) as SpawnLike,
		});
		await assert.rejects(() => backend.launch(request({ command: `node\0bad` })), /NUL/);
		await assert.rejects(() => backend.launch(request({ cwd: `${process.cwd()}\0bad` })), /NUL/);
		await assert.rejects(() => backend.launch(request({ args: ["-e", "ok", "bad\0arg"] })), /NUL/);
		await assert.rejects(() => backend.launch(request({ env: { ...process.env, BAD_ENV: "bad\0env" } })), /NUL/);
		assert.equal(spawnCount, 0);
	});

	it("releaseTransport only cleans transport and preserves caller-directed kill escalation", async () => {
		const signals: Array<NodeJS.Signals | number | undefined> = [];
		const backend = createHeadlessProcessBackend({
			spawn: ((...args: Parameters<typeof spawn>) => {
				const child = spawn(...args);
				const originalKill = child.kill.bind(child);
				child.kill = ((signal?: NodeJS.Signals | number) => {
					signals.push(signal);
					return originalKill(signal);
				}) as typeof child.kill;
				return child;
			}) as SpawnLike,
		});
		const child = await backend.launch(request({
			args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
		}));
		try {
			await child.releaseTransport();
			await child.releaseTransport();
			assert.deepEqual(signals, []);

			assert.equal(child.kill("SIGTERM"), true);
			assert.deepEqual(signals, ["SIGTERM"]);

			assert.equal(child.kill("SIGKILL"), true);
			assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
			await once(child, "close");

			await child.closeTerminal();
			await child.closeTerminal();
		} finally {
			child.kill("SIGKILL");
		}
	});

	it("keeps Windows identity compatible without a process-group contract", async () => {
		const backend = createHeadlessProcessBackend({ platform: "win32" });
		const child = await backend.launch(request({ args: ["-e", "process.exit(0)"] }));
		await once(child, "close");
		assert.equal(child.identity.platform, "win32");
		assert.equal(child.identity.processGroupId, undefined);
		assert.equal(child.identity.dedicatedProcessGroup, false);
	});

	it("returns destroyable placeholder streams when spawn errors before streams exist", async () => {
		const backend = createHeadlessProcessBackend({
			spawn: (() => {
				const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["ignore", "pipe", "pipe"] });
				Object.defineProperty(child, "stdout", { value: null });
				Object.defineProperty(child, "stderr", { value: null });
				return child;
			}) as SpawnLike,
		});
		const child = await backend.launch(request());
		assert.ok(child.stdout instanceof Readable);
		assert.ok(child.stderr instanceof Readable);
		child.stdout.destroy();
		child.stderr.destroy();
		child.kill("SIGTERM");
		await child.releaseTransport();
	});
});
