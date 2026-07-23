import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	HerdrAdapter,
	HerdrAdapterError,
	isHerdrFallbackEligible,
	isSupportedHerdrVersion,
	sanitizeHerdrLabel,
	type HerdrTerminalHandle,
} from "../../src/runs/shared/herdr-adapter.ts";

const fixture = path.resolve("test/fixtures/fake-herdr.mjs");

function makeAdapter(overrides: { mode?: string; timeoutMs?: number; logPath?: string; maxOutputBytes?: number; env?: NodeJS.ProcessEnv } = {}): HerdrAdapter {
	return new HerdrAdapter({
		executable: process.execPath,
		baseArgs: [fixture, "--control-mode", overrides.mode ?? "ok", ...(overrides.logPath ? ["--control-log", overrides.logPath] : [])],
		timeoutMs: overrides.timeoutMs ?? 1000,
		maxOutputBytes: overrides.maxOutputBytes ?? 64 * 1024,
		env: {
			...process.env,
			...overrides.env,
		},
	});
}

function readLog(logPath: string): Array<{ argv: string[]; cwd: string; env: Record<string, string> }> {
	return fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function rejectedError<T extends Error>(action: () => Promise<unknown>, ctor: new (...args: any[]) => T): Promise<T> {
	try {
		await action();
	} catch (error) {
		assert.ok(error instanceof ctor);
		return error;
	}
	assert.fail("expected rejection");
}

describe("HerdrAdapter probe", () => {
	it("requires an executable and reports actionable absent/server errors", async () => {
		await assert.rejects(
			() => new HerdrAdapter({ executable: path.join(os.tmpdir(), "missing-herdr-binary") }).probe(),
			/Herdr executable not found/,
		);
		await assert.rejects(() => makeAdapter({ mode: "server-stopped" }).probe(), /Herdr server is not running/);
	});

	it("accepts compatible Herdr patch and later versions", async () => {
		assert.equal(isSupportedHerdrVersion("0.7.3"), false);
		assert.equal(isSupportedHerdrVersion("0.7.4"), true);
		assert.equal(isSupportedHerdrVersion("0.7.5"), true);
		assert.equal(isSupportedHerdrVersion("0.8.0"), true);
		assert.equal(isSupportedHerdrVersion("1.0.0"), true);
		assert.equal(isSupportedHerdrVersion("not-semver"), false);
		assert.deepEqual(await makeAdapter({ mode: "future-version" }).probe(), { protocol: 17, version: "0.7.5", schemaVersion: 1 });
	});

	it("rejects malformed JSON, timeouts, incompatible protocol/version, and parent outside Herdr", async () => {
		await assert.rejects(() => makeAdapter({ mode: "malformed-json" }).probe(), /invalid JSON/);
		await assert.rejects(() => makeAdapter({ mode: "timeout", timeoutMs: 25 }).probe(), /timed out/);
		await assert.rejects(() => makeAdapter({ mode: "bad-protocol" }).probe(), /protocol 17/);
		await assert.rejects(() => makeAdapter({ mode: "bad-version" }).probe(), /requires Herdr >=0\.7\.4; found 0\.7\.3/);
		await assert.rejects(() => makeAdapter({ mode: "parent-outside" }).resolvePlacement({ placement: "pane" }), /parent.*Herdr/i);
		await assert.rejects(() => makeAdapter({ mode: "parent-outside" }).resolvePlacement({ placement: "tab" }), /parent.*Herdr/i);
		await assert.rejects(() => makeAdapter({ mode: "large-output", maxOutputBytes: 1024 }).probe(), /output.*exceeded|stdout maxBuffer length exceeded/i);
	});
});

describe("HerdrAdapter start/read/close", () => {
	it("starts a child with exact argv, cwd, env, --no-focus, strict IDs, and no shell reconstruction", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-adapter-"));
		try {
			const logPath = path.join(root, "fake-herdr.log");
			const adapter = makeAdapter({ logPath });
			const env = { ...process.env, EXACT_ARG_ENV: "value with spaces = ok", SECRET_TOKEN: "top-secret" };
			const handle = await adapter.startChild({
				command: process.execPath,
				args: ["-e", "process.exit(0)", "space arg", 'quote " arg', "unicode-π", "semi;$(no-shell)"],
				cwd: root,
				env,
				label: "Agent with\nunsafe	label ".repeat(8),
				runId: "run-identity-must-not-be-label",
				childIndex: 7,
			});

			assert.deepEqual(handle, {
				backend: "herdr",
				workspaceId: "w1",
				tabId: "w1:t2",
				paneId: "w1:p2",
				terminalId: "term_abc-123",
				ownsWorkspace: false,
				ownsTab: true,
				ownsPane: true,
			});

			const start = readLog(logPath).find((entry) => entry.argv[0] === "agent" && entry.argv[1] === "start");
			assert.ok(start);
			assert.deepEqual(start.argv.slice(0, 4), ["agent", "start", "Agent with unsafe label Agent with unsafe label", "--cwd"]);
			assert.equal(start.argv[4], root);
			assert.ok(start.argv.includes("--no-focus"));
			const separator = start.argv.indexOf("--");
			assert.equal(separator > 0, true);
			assert.deepEqual(start.argv.slice(separator + 1), [
				process.execPath,
				"-e",
				"process.exit(0)",
				"space arg",
				'quote " arg',
				"unicode-π",
				"semi;$(no-shell)",
			]);
			assert.equal(fs.realpathSync(start.cwd), fs.realpathSync(root));
			assert.equal(start.env.EXACT_ARG_ENV, "value with spaces = ok");
			assert.equal(start.argv.join(" ").includes("top-secret"), false);
			assert.equal(start.argv.join(" ").includes("sh -c"), false);
			assert.equal(start.argv.includes("run"), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves the requested launch env without adapter-control contamination", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-env-"));
		try {
			const logPath = path.join(root, "fake-herdr.log");
			const adapter = makeAdapter({ logPath, env: { ADAPTER_ONLY_SENTINEL: "must-not-leak" } });
			const env = { ...process.env, FAKE_HERDR_LOG: logPath, REQUEST_ONLY_SENTINEL: "present" };

			await adapter.startChild({ command: process.execPath, args: [], cwd: root, env, label: "x", runId: "r", childIndex: 0 });

			const start = readLog(logPath).find((entry) => entry.argv[0] === "agent" && entry.argv[1] === "start");
			assert.ok(start);
			assert.equal(start.env.REQUEST_ONLY_SENTINEL, "present");
			assert.equal(start.env.ADAPTER_ONLY_SENTINEL, undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("places tab starts in the resolved parent workspace", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-placement-"));
		try {
			const logPath = path.join(root, "fake-herdr.log");
			const adapter = makeAdapter({ logPath });
			const parent = await adapter.resolvePlacement({ placement: "tab" });
			await adapter.startChild({ command: process.execPath, args: [], cwd: root, env: process.env, label: "x", runId: "r", childIndex: 0, parentWorkspaceId: parent.workspaceId });

			const start = readLog(logPath).find((entry) => entry.argv[0] === "agent" && entry.argv[1] === "start");
			assert.ok(start);
			assert.deepEqual(start.argv.slice(0, 7), ["agent", "start", "x", "--workspace", "w1", "--cwd", root]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("places tab starts in the active pane workspace even when an inactive pane appears first", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-active-placement-"));
		try {
			const logPath = path.join(root, "fake-herdr.log");
			const adapter = makeAdapter({ mode: "active-later", logPath });
			const parent = await adapter.resolvePlacement({ placement: "tab" });
			await adapter.startChild({ command: process.execPath, args: [], cwd: root, env: process.env, label: "x", runId: "r", childIndex: 0, parentWorkspaceId: parent.workspaceId });

			assert.deepEqual(parent, { workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1" });
			const start = readLog(logPath).find((entry) => entry.argv[0] === "agent" && entry.argv[1] === "start");
			assert.ok(start);
			assert.deepEqual(start.argv.slice(0, 7), ["agent", "start", "x", "--workspace", "w2", "--cwd", root]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects tab starts that do not land in the resolved parent workspace", async () => {
		const adapter = makeAdapter({ mode: "wrong-workspace-start" });
		await assert.rejects(
			() => adapter.startChild({ command: process.execPath, args: [], cwd: process.cwd(), env: process.env, label: "x", runId: "r", childIndex: 0, parentWorkspaceId: "w1" }),
			/start response.*requested workspace/,
		);
	});

	it("validates mutation IDs, reads display, inspects panes, and closes only adapter-owned IDs", async () => {
		await assert.rejects(
			() => makeAdapter({ mode: "bad-ids" }).startChild({ command: process.execPath, args: [], cwd: process.cwd(), env: process.env, label: "x", runId: "r", childIndex: 0 }),
			/invalid Herdr start response.*workspace_id/,
		);

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-close-"));
		try {
			const logPath = path.join(root, "fake-herdr.log");
			const adapter = makeAdapter({ logPath });
			const handle = await adapter.startChild({ command: process.execPath, args: [], cwd: process.cwd(), env: process.env, label: "x", runId: "r", childIndex: 0 });
			assert.deepEqual(await adapter.inspect(handle), { workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", terminalId: "term_abc-123", title: "child" });
			assert.equal(await adapter.readDisplay(handle), "display text");
			assert.equal(Object.isFrozen(handle), true);
			assert.deepEqual(await adapter.close(handle), { closed: true });
			assert.equal(readLog(logPath).at(-1)?.argv.join(" "), "pane close w1:p2");

			await assert.rejects(() => adapter.close({ ...handle }), /exact handle object/);
			await assert.rejects(() => adapter.close({ ...handle, ownsPane: false, ownsTab: false, ownsWorkspace: false }), /exact handle object/);
			await assert.rejects(async () => {
				handle.backend = "headless" as HerdrTerminalHandle["backend"];
				await adapter.close(handle);
			}, /read only|object is not extensible|Cannot assign|handle identity was mutated/);
			assert.equal(readLog(logPath).at(-1)?.argv.join(" "), "pane close w1:p2");
			await assert.rejects(async () => {
				handle.ownsPane = false;
				handle.ownsTab = false;
				await adapter.close(handle);
			}, /read only|object is not extensible|Cannot assign|handle ownership was mutated/);
			assert.equal(readLog(logPath).at(-1)?.argv.join(" "), "pane close w1:p2");
			await assert.rejects(() => adapter.close({ ...handle, ownsPane: false }), /exact handle object/);
			await assert.rejects(() => adapter.close({ ...handle, paneId: "w1:p1" }), /exact handle object/);
			await assert.rejects(() => adapter.close({ ...handle, ownsPane: false, ownsTab: false, ownsWorkspace: true }), /exact handle object/);
			await assert.rejects(() => makeAdapter().close(handle), /not owned by this HerdrAdapter instance/);
			await assert.rejects(() => adapter.close({ ...handle, workspaceId: "w2" }), /handle ancestry/);
			await assert.rejects(() => adapter.close({ ...handle, tabId: "w2:t2" }), /handle ancestry/);
			await assert.rejects(() => adapter.close({ ...handle, paneId: "w2:p2" }), /handle ancestry/);

			await assert.rejects(() => adapter.close({ ...handle, ownsPane: true, ownsWorkspace: true }), /exact handle object/);
			await assert.rejects(() => makeAdapter({ mode: "malformed-inspect" }).inspect(handle), /invalid Herdr inspect response.*tab_id/);
			await assert.rejects(() => makeAdapter({ mode: "malformed-read" }).readDisplay(handle), /invalid Herdr read response.*text/);
			const malformedCloseAdapter = makeAdapter({ mode: "malformed-close" });
			const malformedCloseHandle = await malformedCloseAdapter.startChild({ command: process.execPath, args: [], cwd: process.cwd(), env: process.env, label: "x", runId: "r", childIndex: 0 });
			await assert.rejects(() => malformedCloseAdapter.close(malformedCloseHandle), /invalid Herdr close response.*closed/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("binds close authority to the exact handle object and adapter instance under ID collisions", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-close-collision-"));
		try {
			const logPathA = path.join(root, "fake-herdr-a.log");
			const logPathB = path.join(root, "fake-herdr-b.log");
			const adapterA = makeAdapter({ logPath: logPathA });
			const adapterB = makeAdapter({ logPath: logPathB });
			const handleA = await adapterA.startChild({ command: process.execPath, args: [], cwd: root, env: process.env, label: "a", runId: "r", childIndex: 0 });
			const handleB = await adapterB.startChild({ command: process.execPath, args: [], cwd: root, env: process.env, label: "b", runId: "r", childIndex: 1 });

			assert.notEqual(handleA, handleB);
			assert.deepEqual(handleA, handleB);
			await assert.rejects(() => adapterB.close(handleA), /not owned by this HerdrAdapter instance/);
			assert.deepEqual(await adapterA.close(handleA), { closed: true });
			assert.equal(readLog(logPathA).at(-1)?.argv.join(" "), "pane close w1:p2");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects unsupported pane placement before mutation and marks start failures as non-fallbackable", async () => {
		const adapter = makeAdapter();
		await assert.rejects(() => adapter.resolvePlacement({ placement: "pane", splitDirection: "down" }), /pane placement.*not implemented/i);

		const startTimeout = await rejectedError(
			() => makeAdapter({ mode: "start-timeout", timeoutMs: 1000 }).startChild({ command: process.execPath, args: [], cwd: process.cwd(), env: process.env, label: "x", runId: "r", childIndex: 0 }),
			HerdrAdapterError,
		);
		assert.equal(startTimeout.fallbackEligible, false);

		const malformedStart = await rejectedError(
			() => makeAdapter({ mode: "malformed-start" }).startChild({ command: process.execPath, args: [], cwd: process.cwd(), env: process.env, label: "x", runId: "r", childIndex: 0 }),
			HerdrAdapterError,
		);
		assert.equal(malformedStart.fallbackEligible, false);

		const badIdStart = await rejectedError(
			() => makeAdapter({ mode: "bad-ids" }).startChild({ command: process.execPath, args: [], cwd: process.cwd(), env: process.env, label: "x", runId: "r", childIndex: 0 }),
			HerdrAdapterError,
		);
		assert.equal(badIdStart.fallbackEligible, false);
	});

	it("bounds labels and fallback eligibility to pre-mutation failures only", async () => {
		assert.equal(sanitizeHerdrLabel("a\n\t".repeat(100)).length <= 48, true);
		assert.notEqual(sanitizeHerdrLabel("run-abc", "fallback"), "run-abc");
		assert.equal(isHerdrFallbackEligible({ mutationStarted: false, mutationSucceeded: false, error: new Error("missing") }), true);
		assert.equal(isHerdrFallbackEligible({ mutationStarted: true, mutationSucceeded: false, error: new Error("ambiguous") }), false);
		assert.equal(isHerdrFallbackEligible({ mutationStarted: true, mutationSucceeded: true, error: new Error("late") }), false);
	});
});
