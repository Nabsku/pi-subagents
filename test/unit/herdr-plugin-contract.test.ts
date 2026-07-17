import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import {
	buildHerdrPluginActionInvokeArgv,
	buildHerdrPluginPaneOpenArgv,
	HERDR_PLUGIN_ACTIONS,
	HERDR_PLUGIN_ID,
	HERDR_PLUGIN_RELAY_ENTRYPOINT,
	resolveHerdrPluginOperatorAction,
	validateHerdrCapabilityChannel,
	validateHerdrPluginInvocationContext,
	validateHerdrPluginLaunchRequest,
	validateHerdrPluginOperatorActionRequest,
} from "../../src/runs/shared/herdr-plugin-contract.ts";

const execFileAsync = promisify(execFile);
const fakeHerdr = path.resolve("test/fixtures/fake-herdr.mjs");
const pluginRoot = path.resolve("test/fixtures/herdr-plugin");
const capabilityChannel = Object.freeze({ kind: "controller-local-one-shot", transport: "unix-socket", id: "pi-subagents:capchan-run-1" });
const terminal = Object.freeze({ workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", terminalId: "term_abc-123" });

const validManifest = `id = "pi-subagents.hybrid"
name = "pi-subagents hybrid test plugin"
version = "0.1.0"
min_herdr_version = "0.7.4"
description = "Harmless fake Herdr plugin fixture for pi-subagents contract tests."

[[actions]]
id = "inspect"
title = "Inspect subagent"
command = ["node", "./scripts/action.mjs", "inspect"]
contexts = ["pane"]

[[actions]]
id = "stop"
title = "Request controller stop"
command = ["node", "./scripts/action.mjs", "stop"]
contexts = ["pane"]

[[actions]]
id = "retry"
title = "Request controller retry"
command = ["node", "./scripts/action.mjs", "retry"]
contexts = ["pane"]

[[panes]]
id = "relay-runner"
title = "Subagent relay runner"
command = ["node", "./scripts/relay-runner.mjs"]
placement = "tab"
`;

function readLog(logPath: string): Array<{ argv: string[]; cwd: string; env: Record<string, string> }> {
	return fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function runFake(argv: string[], options: { logPath: string; cwd?: string; env?: NodeJS.ProcessEnv }) {
	return execFileAsync(process.execPath, [fakeHerdr, "--control-log", options.logPath, ...argv], {
		cwd: options.cwd,
		env: { ...process.env, ...(options.env ?? {}) },
		windowsHide: true,
		shell: false,
	});
}

function makePluginFixture(manifest: string, scripts: string[] = ["action.mjs", "relay-runner.mjs"]): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-plugin-manifest-"));
	fs.writeFileSync(path.join(root, "herdr-plugin.toml"), manifest);
	fs.mkdirSync(path.join(root, "scripts"));
	for (const script of scripts) fs.writeFileSync(path.join(root, "scripts", script), "#!/usr/bin/env node\n");
	return root;
}

describe("Herdr plugin boundary contract", () => {
	it("defines only static manifest actions and a fixed relay-runner pane entrypoint", () => {
		assert.deepEqual(HERDR_PLUGIN_ACTIONS, ["inspect", "stop", "retry"]);
		assert.equal(HERDR_PLUGIN_RELAY_ENTRYPOINT, "relay-runner");
		assert.deepEqual(buildHerdrPluginActionInvokeArgv("inspect"), ["plugin", "action", "invoke", "inspect", "--plugin", HERDR_PLUGIN_ID]);
		assert.deepEqual(buildHerdrPluginPaneOpenArgv({ cwd: "/tmp/work", workspaceId: "w1", targetPaneId: "w1:p1", direction: "right" }), [
			"plugin", "pane", "open", "--plugin", HERDR_PLUGIN_ID, "--entrypoint", "relay-runner", "--placement", "tab", "--cwd", "/tmp/work", "--workspace", "w1", "--target-pane", "w1:p1", "--direction", "right",
		]);
		assert.throws(() => buildHerdrPluginActionInvokeArgv("focus" as never), /Invalid Herdr plugin contract: action/);
		assert.throws(() => buildHerdrPluginPaneOpenArgv({ cwd: "/tmp/work", entrypoint: "shell" }), /entrypoint/);
	});

	it("accepts an opaque future capability channel but rejects inline/raw secret fields everywhere", () => {
		assert.deepEqual(validateHerdrCapabilityChannel(capabilityChannel), capabilityChannel);
		assert.throws(() => validateHerdrCapabilityChannel({ kind: "inline", transport: "env", id: "x" }), /capabilityChannel.kind/);
		assert.throws(() => validateHerdrCapabilityChannel({ ...capabilityChannel, id: "capability-token" }), /capabilityChannel.id/);
		assert.throws(() => validateHerdrCapabilityChannel({ ...capabilityChannel, id: "../socket" }), /capabilityChannel.id/);
		assert.throws(() => validateHerdrCapabilityChannel({ ...capabilityChannel, raw: "secret" }), /capabilityChannel.raw/);

		const context = validateHerdrPluginInvocationContext({ schema: "pi-herdr-plugin-context/v1", contractVersion: 1, pluginId: HERDR_PLUGIN_ID, runId: "run-1", childIndex: 0, capabilityChannel, terminal });
		assert.deepEqual(context.terminal, terminal);
		assert.throws(() => validateHerdrPluginInvocationContext({ ...context, capability: "bytes" }), /inline secrets/);
		assert.throws(() => validateHerdrPluginInvocationContext({ ...context, CAPABILITYTOKEN: "bytes" }), /inline secrets/);
		assert.throws(() => validateHerdrPluginInvocationContext({ ...context, nested: { apiKey: "bytes" } }), /inline secrets/);
		assert.throws(() => validateHerdrPluginInvocationContext({ ...context, runId: "run\u0001" }), /context.runId/);
		assert.throws(() => validateHerdrPluginLaunchRequest({ schema: "pi-herdr-launch/v1", contractVersion: 1, runId: "run-1", childIndex: 0, cwd: "/tmp", command: "/bin/echo", args: [], env: { CAPABILITY: "bytes" }, label: "x", capabilityChannel }), /CAPABILITY.*inline secrets/);
		assert.throws(() => validateHerdrPluginLaunchRequest({ schema: "pi-herdr-launch/v1", contractVersion: 1, runId: "run-1", childIndex: 0, cwd: "/tmp", command: "/bin/echo", args: [], env: { apiKey: "bytes" }, label: "x", capabilityChannel }), /apiKey.*inline secrets/);
		assert.throws(() => buildHerdrPluginPaneOpenArgv({ cwd: "/tmp", env: { HERDR_CAPABILITY: "bytes" } }), /inline secrets/);
		assert.throws(() => validateHerdrPluginLaunchRequest({ schema: "pi-herdr-launch/v1", contractVersion: 1, runId: "run-1", childIndex: 0, cwd: "/tmp", command: "/bin/echo", args: ["CAPABILITY-BYTES"], env: {}, label: "x", capabilityChannel }), /launch.args.*inline secrets/);
		assert.throws(() => validateHerdrPluginLaunchRequest({ schema: "pi-herdr-launch/v1", contractVersion: 1, runId: "run-1", childIndex: 0, cwd: "/tmp", command: "/bin/echo", args: [], env: { PAYLOAD: "CAPABILITY-BYTES" }, label: "x", capabilityChannel }), /launch.env.*inline secrets/);
		assert.throws(() => buildHerdrPluginPaneOpenArgv({ cwd: "/tmp", env: { PAYLOAD: "CAPABILITY-BYTES" } }), /inline secrets/);
	});

	it("rejects unsafe records, accessors, inherited authority, and post-validation mutation", () => {
		let getterCount = 0;
		const request = { schema: "pi-herdr-operator-action/v1", contractVersion: 1, action: "stop", runId: "run-1", terminal, reason: "operator", correlationId: "corr-1" };
		assert.throws(() => validateHerdrPluginOperatorActionRequest(Object.assign(Object.create({ token: "inherited" }), request)), /plain record/);
		assert.throws(() => validateHerdrPluginOperatorActionRequest(Object.assign(new (class Custom {})(), request)), /plain record/);
		const accessor = { ...request, get action() { getterCount += 1; return "retry"; } };
		assert.throws(() => validateHerdrPluginOperatorActionRequest(accessor), /own data properties/);
		assert.equal(getterCount, 0);
		const launchWithToJSON = { schema: "pi-herdr-launch/v1", contractVersion: 1, runId: "run-1", childIndex: 0, cwd: "/tmp", command: "/bin/echo", args: ["ok"], env: {}, label: "x", capabilityChannel,
			toJSON() { this.args[0] = "CAPABILITY-BYTES"; delete (this as { toJSON?: unknown }).toJSON; return this; } };
		assert.throws(() => validateHerdrPluginLaunchRequest(launchWithToJSON), /launch.toJSON is not supported/);
		assert.equal(launchWithToJSON.args[0], "ok");
		const contextWithToJSON = { schema: "pi-herdr-plugin-context/v1", contractVersion: 1, pluginId: HERDR_PLUGIN_ID, runId: "run-1", childIndex: 0, capabilityChannel,
			toJSON() { this.runId = "changed"; delete (this as { toJSON?: unknown }).toJSON; return this; } };
		assert.throws(() => validateHerdrPluginInvocationContext(contextWithToJSON), /context.toJSON is not supported/);
		assert.equal(contextWithToJSON.runId, "run-1");
		const args: string[] = [];
		Object.defineProperty(args, "0", { enumerable: true, get() { getterCount += 1; return "CAPABILITY-BYTES"; } });
		assert.throws(() => validateHerdrPluginLaunchRequest({ schema: "pi-herdr-launch/v1", contractVersion: 1, runId: "run-1", childIndex: 0, cwd: "/tmp", command: "/bin/echo", args, env: {}, label: "x", capabilityChannel }), /own data properties/);
		const paneEnv = {};
		Object.defineProperty(paneEnv, "PAYLOAD", { enumerable: true, get() { getterCount += 1; return "CAPABILITY-BYTES"; } });
		assert.throws(() => buildHerdrPluginPaneOpenArgv({ cwd: "/tmp", env: paneEnv as Record<string, string> }), /own data properties/);
		assert.equal(getterCount, 0);
		const mutable = { ...request };
		const validated = validateHerdrPluginOperatorActionRequest(mutable);
		mutable.runId = "changed";
		assert.deepEqual(resolveHerdrPluginOperatorAction(validated), { schema: "pi-herdr-operator-action-result/v1", contractVersion: 1, action: "stop", runId: "run-1", accepted: true, decision: "controller-stop-requested" });
	});

	it("enforces conservative launch, terminal, and argv bounds before serialization", () => {
		const launch = { schema: "pi-herdr-launch/v1", contractVersion: 1, runId: "run-1", childIndex: 0, cwd: "/tmp", command: "/bin/echo", args: ["ok"], env: { PI_RUN_ID: "run-1" }, label: "child", capabilityChannel, terminal };
		assert.deepEqual(validateHerdrPluginLaunchRequest(launch).args, ["ok"]);
		assert.throws(() => validateHerdrPluginLaunchRequest({ ...launch, cwd: "relative" }), /launch.cwd/);
		assert.throws(() => validateHerdrPluginLaunchRequest({ ...launch, command: "echo" }), /launch.command/);
		assert.throws(() => validateHerdrPluginLaunchRequest({ ...launch, args: Array.from({ length: 65 }, () => "x") }), /launch.args/);
		assert.throws(() => validateHerdrPluginLaunchRequest({ ...launch, args: ["x".repeat(4097)] }), /launch.args\[0\]/);
		assert.throws(() => validateHerdrPluginLaunchRequest({ ...launch, env: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`PI_${index}`, "x"])) }), /launch.env/);
		assert.throws(() => validateHerdrPluginLaunchRequest({ ...launch, label: "x".repeat(129) }), /launch.label/);
		assert.throws(() => validateHerdrPluginOperatorActionRequest({ schema: "pi-herdr-operator-action/v1", contractVersion: 1, action: "stop", runId: "r".repeat(129), terminal, reason: "operator", correlationId: "corr-1" }), /operatorAction.runId/);
		assert.throws(() => buildHerdrPluginPaneOpenArgv({ cwd: "relative" }), /paneOpen.cwd/);
		assert.throws(() => buildHerdrPluginPaneOpenArgv({ cwd: "/tmp", env: { ["PI_" + "X".repeat(65)]: "x" } }), /paneOpen.env/);
	});

	it("fail-closes malformed schema/version/action/terminal metadata and treats stop/retry as controller requests", () => {
		const request = { schema: "pi-herdr-operator-action/v1", contractVersion: 1, action: "stop", runId: "run-1", terminal, reason: "operator", correlationId: "corr-1" };
		assert.deepEqual(validateHerdrPluginOperatorActionRequest(request).terminal, terminal);
		assert.deepEqual(resolveHerdrPluginOperatorAction(request), { schema: "pi-herdr-operator-action-result/v1", contractVersion: 1, action: "stop", runId: "run-1", accepted: true, decision: "controller-stop-requested" });
		assert.equal(resolveHerdrPluginOperatorAction({ ...request, action: "retry" }).decision, "controller-retry-requested");
		assert.equal(resolveHerdrPluginOperatorAction({ ...request, action: "inspect" }).decision, "inspection");
		assert.throws(() => validateHerdrPluginOperatorActionRequest({ ...request, schema: "v0" }), /operatorAction.schema/);
		assert.throws(() => validateHerdrPluginOperatorActionRequest({ ...request, contractVersion: 2 }), /operatorAction.contractVersion/);
		assert.throws(() => validateHerdrPluginOperatorActionRequest({ ...request, action: "kill" }), /operatorAction.action/);
		assert.throws(() => validateHerdrPluginOperatorActionRequest({ ...request, terminal: { ...terminal, paneId: "w2:p2" } }), /terminal ancestry/);
		assert.throws(() => validateHerdrPluginOperatorActionRequest({ ...request, terminal: { ...terminal, pid: 123 } }), /terminal.pid is not supported/);
	});
});

describe("fake Herdr plugin fixture", () => {
	it("links and lists the harmless static plugin fixture without runtime registration APIs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-plugin-link-"));
		try {
			const logPath = path.join(root, "fake-herdr.log");
			await runFake(["plugin", "link", pluginRoot], { logPath });
			const { stdout } = await runFake(["plugin", "list", "--json"], { logPath });
			const payload = JSON.parse(stdout);
			assert.equal(payload.type, "plugin_list");
			assert.equal(payload.plugins[0].id, HERDR_PLUGIN_ID);
			assert.deepEqual(payload.plugins[0].actions.map((action: { id: string }) => action.id), ["inspect", "stop", "retry"]);
			assert.deepEqual(payload.plugins[0].actions.map((action: { contexts: string[] }) => action.contexts), [["pane"], ["pane"], ["pane"]]);
			assert.deepEqual(payload.plugins[0].panes.map((pane: { id: string }) => pane.id), ["relay-runner"]);
			await assert.rejects(() => runFake(["plugin", "register", "dynamic-action"], { logPath }), /unexpected fake-herdr argv/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("parses and rejects invalid Herdr plugin manifests instead of synthesizing success", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-plugin-invalid-"));
		const cases = [
			validManifest.replace('min_herdr_version = "0.7.4"\n', ""),
			validManifest.replace('title = "Inspect subagent"', 'label = "Inspect subagent"'),
			validManifest.replace('contexts = ["pane"]', 'context = "pane"'),
			validManifest.replace('contexts = ["pane"]', 'contexts = ["workspace"]'),
			validManifest.replace('placement = "tab"', 'placement = "floating"'),
			`${validManifest}\n[[actions]]\nid = "retry"\ntitle = "Duplicate"\ncommand = ["node", "./scripts/action.mjs", "retry"]\ncontexts = ["pane"]\n`,
		];
		try {
			const logPath = path.join(root, "fake-herdr.log");
			for (const manifest of cases) {
				const fixture = makePluginFixture(manifest);
				try {
					await assert.rejects(() => runFake(["plugin", "link", fixture], { logPath }), /invalid plugin manifest|unsupported plugin manifest/);
				} finally {
					fs.rmSync(fixture, { recursive: true, force: true });
				}
			}
			const missingScript = makePluginFixture(validManifest, ["action.mjs"]);
			try {
				await assert.rejects(() => runFake(["plugin", "link", missingScript], { logPath }), /missing plugin script/);
			} finally {
				fs.rmSync(missingScript, { recursive: true, force: true });
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("invokes static actions and opens relay-runner panes with exact argv/no shell and documented HERDR_PLUGIN_* env injection", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-plugin-flow-"));
		try {
			const logPath = path.join(root, "fake-herdr.log");
			const context = { schema: "pi-herdr-plugin-context/v1", contractVersion: 1, pluginId: HERDR_PLUGIN_ID, runId: "run-1", childIndex: 0, capabilityChannel, terminal };
			const actionEnv = { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context), HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t2", HERDR_PANE_ID: "w1:p2", CAPABILITYTOKEN: "super-secret-capability", apiKey: "ambient-api-key" };

			const actionResult = await runFake(buildHerdrPluginActionInvokeArgv("retry"), { logPath, env: actionEnv });
			assert.deepEqual(JSON.parse(actionResult.stdout), { type: "plugin_action_result", plugin_id: HERDR_PLUGIN_ID, action_id: "retry", ok: true });

			const paneResult = await runFake(buildHerdrPluginPaneOpenArgv({ cwd: root, workspaceId: "w1", targetPaneId: "w1:p2", direction: "down", env: { PI_RUN_ID: "run-1" } }), { logPath, env: { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context), CAPABILITYTOKEN: "super-secret-capability" } });
			assert.deepEqual(JSON.parse(paneResult.stdout), { type: "plugin_pane_opened", plugin_id: HERDR_PLUGIN_ID, entrypoint_id: "relay-runner", workspace_id: "w1", tab_id: "w1:t3", pane_id: "w1:p3", terminal_id: "term_plugin-123" });

			const logs = readLog(logPath);
			const action = logs.find((entry) => entry.env.HERDR_PLUGIN_ACTION_ID === "retry");
			assert.ok(action);
			assert.equal(action.argv.join(" ").includes("capability"), false);
			assert.equal(action.argv.join(" ").includes("sh -c"), false);
			assert.equal(action.env.HERDR_ENV, "1");
			assert.equal(action.env.HERDR_PLUGIN_ID, HERDR_PLUGIN_ID);
			assert.equal(action.env.HERDR_PLUGIN_ACTION_ID, "retry");
			assert.equal(action.env.HERDR_SOCKET_PATH, "/tmp/fake-herdr.sock");
			assert.equal(action.env.HERDR_PLUGIN_CONTEXT_JSON, JSON.stringify(context));
			assert.equal(action.env.HERDR_WORKSPACE_ID, "w1");
			assert.equal("CAPABILITYTOKEN" in action.env, false);
			assert.equal("apiKey" in action.env, false);

			const pane = logs.find((entry) => entry.env.HERDR_PLUGIN_ENTRYPOINT_ID === "relay-runner");
			assert.ok(pane);
			assert.equal(pane.env.HERDR_PLUGIN_ENTRYPOINT_ID, "relay-runner");
			assert.equal(pane.env.PI_RUN_ID, "run-1");
			assert.equal(JSON.stringify(logs).includes("super-secret-capability"), false);
			assert.equal(JSON.stringify(logs).includes("ambient-api-key"), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects unknown, duplicate, and missing-value options for every fake plugin command", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-plugin-argv-"));
		try {
			const logPath = path.join(root, "fake-herdr.log");
			const invalid = [
				["plugin", "link", pluginRoot, "--unknown"],
				["plugin", "list", "--json", "--unknown"],
				["plugin", "action", "invoke", "inspect", "--plugin"],
				["plugin", "action", "invoke", "inspect", "--plugin", HERDR_PLUGIN_ID, "--plugin", HERDR_PLUGIN_ID],
				["plugin", "pane", "open", "--plugin", HERDR_PLUGIN_ID, "--entrypoint", "relay-runner", "--cwd"],
				["plugin", "pane", "open", "--plugin", HERDR_PLUGIN_ID, "--entrypoint", "relay-runner", "--cwd", root, "--unknown"],
				["plugin", "log", "list", "--unknown"],
			];
			for (const command of invalid) await assert.rejects(() => runFake(command, { logPath }), /invalid fake-herdr argv|unexpected fake-herdr argv/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed plugin context JSON before logging", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-plugin-context-"));
		try {
			const logPath = path.join(root, "fake-herdr.log");
			const malformed = JSON.stringify({ schema: "evil", raw: "CAPABILITY-BYTES" });
			await assert.rejects(() => runFake(buildHerdrPluginActionInvokeArgv("inspect"), { logPath, env: { HERDR_PLUGIN_CONTEXT_JSON: malformed } }), /invalid HERDR_PLUGIN_CONTEXT_JSON/);
			const validShapedSecret = JSON.stringify({ schema: "pi-herdr-plugin-context/v1", contractVersion: 1, pluginId: HERDR_PLUGIN_ID, runId: "SECRET_SENTINEL_9fdcc294", childIndex: 0, capabilityChannel, terminal });
			await assert.rejects(() => runFake(buildHerdrPluginActionInvokeArgv("inspect"), { logPath, env: { HERDR_PLUGIN_CONTEXT_JSON: validShapedSecret } }), /invalid HERDR_PLUGIN_CONTEXT_JSON/);
			assert.equal(fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8").includes("CAPABILITY-BYTES") : false, false);
			assert.equal(fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8").includes("SECRET_SENTINEL_9fdcc294") : false, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects every secret-bearing canonical plugin context field before logging", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-plugin-context-secret-"));
		const base = { schema: "pi-herdr-plugin-context/v1", contractVersion: 1, pluginId: HERDR_PLUGIN_ID, runId: "run-1", childIndex: 0, capabilityChannel, terminal };
		const cases = [
			{ sentinel: "CaPaBiLiTySentinel", context: { ...base, runId: "CaPaBiLiTySentinel" } },
			{ sentinel: "secret-sentinel", context: { ...base, runId: "secret-sentinel" } },
			{ sentinel: "TOKEN_SENTINEL", context: { ...base, runId: "TOKEN_SENTINEL" } },
			{ sentinel: "api-key-sentinel", context: { ...base, terminal: { ...terminal, terminalId: "term_api-key-sentinel" } } },
			{ sentinel: "password-sentinel", context: { ...base, terminal: { ...terminal, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", terminalId: "term_password-sentinel" } } },
			{ sentinel: "credential-sentinel", context: { ...base, capabilityChannel: { ...capabilityChannel, id: "pi-subagents:capchan-credential-sentinel" } } },
			{ sentinel: "private_key_sentinel", context: { ...base, terminal: { ...terminal, terminalId: "term_private_key_sentinel" } } },
		];
		try {
			const logPath = path.join(root, "fake-herdr.log");
			for (const testCase of cases) {
				await assert.rejects(() => runFake(buildHerdrPluginActionInvokeArgv("inspect"), { logPath, env: { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(testCase.context) } }), /invalid HERDR_PLUGIN_CONTEXT_JSON/);
			}
			const persisted = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
			for (const testCase of cases) assert.equal(persisted.includes(testCase.sentinel), false);
			await runFake(buildHerdrPluginActionInvokeArgv("inspect"), { logPath, env: { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(base) } });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
