import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { buildPiArgs, cleanupTempDir } from "../../src/runs/shared/pi-args.ts";
import { createChildProcessBackend, type ChildLaunchRequest } from "../../src/runs/shared/process-backend.ts";
import { resolveTerminalConfig } from "../../src/runs/shared/terminal-config.ts";

const pluginRunnerPath = path.resolve(process.cwd(), "../herdr-pi-subagents/scripts/relay-runner.mjs");
const fakePiCliPath = path.resolve("test/fixtures/fake-pi-first-user-event.mjs");
const pluginAvailable = fs.existsSync(pluginRunnerPath);
const terminal = Object.freeze({
	backend: "herdr" as const,
	workspaceId: "w1",
	tabId: "w1:t2",
	paneId: "w1:p2",
	terminalId: "term_plugin",
	ownsWorkspace: false,
	ownsTab: false,
	ownsPane: true,
});

type FirstUserEvent = {
	type: "message_end";
	message: { role: "user"; content: Array<{ type: "text"; text: string }> };
	argv: string[];
};

async function launchDelegatedTask(task: string, childIndex: number): Promise<FirstUserEvent> {
	const built = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task,
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritSkills: false,
	});
	let runner: ReturnType<typeof spawn> | undefined;
	let launch: ChildLaunchRequest | undefined;
	try {
		const backend = createChildProcessBackend(resolveTerminalConfig({ backend: "herdr-plugin", placement: "pane", closeOnExit: true }), {
			herdrReadinessTimeoutMs: 5_000,
			herdrAdapter: {
				startChild: async () => { throw new Error("embedded Herdr backend must not be used"); },
				startPluginChild: async (request) => {
					launch = request;
					const descriptor = JSON.parse(fs.readFileSync(request.pluginLaunchFile!, "utf8"));
					assert.deepEqual(Object.keys(descriptor).sort(), ["args", "command", "cwd", "envPath", "label", "nonce", "retention", "schema", "socketPath", "version"]);
					runner = spawn(process.execPath, [pluginRunnerPath], {
						cwd: request.cwd,
						env: { ...request.env, PI_SUBAGENTS_LAUNCH_FILE: request.pluginLaunchFile! },
						stdio: ["ignore", "ignore", "pipe"],
					});
					let runnerError = "";
					runner.stderr!.on("data", (chunk) => { runnerError += String(chunk); });
					await Promise.race([
						once(runner, "close").then(() => { throw new Error(runnerError.trim() || "Herdr plugin runner exited before relay readiness"); }),
						new Promise((resolve) => setTimeout(resolve, 1_000)),
					]);
					return terminal;
				},
				close: async () => ({ closed: true }),
			},
		});
		const child = await backend.launch({
			command: process.execPath,
			args: [fakePiCliPath, ...built.args],
			cwd: process.cwd(),
			env: { ...process.env, ...built.env },
			label: `prompt-transport-${childIndex}`,
			runId: `prompt-transport-${childIndex}`,
			childIndex,
		});
		let stdout = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		const [code] = await once(child, "close") as [number | null];
		assert.equal(code, 0);
		assert.ok(launch?.pluginLaunchFile, "pi-subagents did not create a private Herdr launch descriptor");
		assert.equal(fs.existsSync(path.dirname(launch.pluginLaunchFile)), false, "private descriptor directory survived relay completion");
		const event = JSON.parse(stdout.trim()) as FirstUserEvent;
		assert.equal(event.type, "message_end");
		assert.equal(event.message.role, "user");
		return event;
	} finally {
		cleanupTempDir(built.tempDir);
		if (runner && runner.exitCode === null && runner.signalCode === null) runner.kill("SIGTERM");
	}
}

describe("delegated prompt transport through the Herdr plugin", { skip: pluginAvailable ? undefined : "standalone Herdr plugin checkout unavailable" }, () => {
	it("delivers exact short, long, multiline, Unicode, and parallel tasks as the first user event", async () => {
		const tasks = [
			"short task",
			`long:${"0123456789abcdef".repeat(1024)}`,
			"line one\nline two\n\nline four",
			"Unicode: π 漢字 🚀 café é",
			"parallel child alpha unique-sentinel-a",
			"parallel child beta unique-sentinel-b",
		];
		const events = await Promise.all(tasks.map((task, index) => launchDelegatedTask(task, index)));

		for (const [index, event] of events.entries()) {
			const expectedPrompt = `Task: ${tasks[index]}`;
			assert.equal(event.message.content.length, 1);
			assert.equal(event.message.content[0]?.text, expectedPrompt);
			assert.equal(event.argv.some((arg) => arg.endsWith("cli.js")), false);
			assert.equal(event.argv.some((arg) => arg.includes("plugin-launch.json") || arg.includes("child-env.json")), false);
			for (const [otherIndex, otherTask] of tasks.entries()) {
				if (otherIndex !== index) assert.equal(event.message.content[0]?.text.includes(otherTask), false);
			}
		}
	});
});