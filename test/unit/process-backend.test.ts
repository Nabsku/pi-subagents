import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
	createChildProcessBackend,
	createHeadlessProcessBackend,
	type ChildLaunchRequest,
	type SpawnLike,
} from "../../src/runs/shared/process-backend.ts";
import { resolveTerminalConfig } from "../../src/runs/shared/terminal-config.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../src/shared/post-exit-stdio-guard.ts";

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

	it("fails explicit Herdr config before launch until a Herdr adapter is implemented", async () => {
		let launched = false;
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr" }), {
			spawn: ((...args: Parameters<typeof spawn>) => {
				launched = true;
				return spawn(...args);
			}) as SpawnLike,
		});
		await assert.rejects(() => backend.launch(request()), /Herdr terminal backend is not implemented/);
		assert.equal(launched, false);
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
