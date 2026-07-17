import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { ChildLaunchRequest, ChildProcessBackend, ManagedChild } from "../../src/runs/shared/process-backend.ts";
import { __testSpawnRunner } from "../../src/runs/background/async-execution.ts";
import { runPiStreaming } from "../../src/runs/background/subagent-runner.ts";
import type { ResolvedTerminalConfig } from "../../src/shared/types.ts";

const HEADLESS_TERMINAL_CONFIG: ResolvedTerminalConfig = {
	backend: "headless",
	placement: "tab",
	splitDirection: "right",
	focus: false,
	closeOnExit: false,
	fallback: "error",
};

function tempOutputPath(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return path.join(dir, "child-output.txt");
}

function createSettlingChild(pid = 4242): ManagedChild {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const emitter = new EventEmitter();
	const child = emitter as unknown as ManagedChild;
	child.pid = pid;
	child.identity = { nonce: "test", pid, dedicatedProcessGroup: false, platform: process.platform };
	child.stdout = stdout;
	child.stderr = stderr;
	child.kill = () => true;
	child.releaseTransport = async () => {};
	child.closeTerminal = async () => {};
	child.once = child.once.bind(child) as ManagedChild["once"];
	child.on = child.on.bind(child) as ManagedChild["on"];
	process.nextTick(() => {
		stdout.end(JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
			},
		}) + "\n" + JSON.stringify({ type: "agent_settled" }) + "\n");
		stderr.end();
		emitter.emit("exit", 0, null);
		emitter.emit("close", 0, null);
	});
	return child;
}

type WriterState = { state: "none" | "spawning" } | { state: "running"; pid: number };

describe("background runner Pi process backend", () => {
	it("launches exactly one async Pi child through the backend with the structured request", async () => {
		const launches: ChildLaunchRequest[] = [];
		const writerStates: WriterState[] = [];
		const result = await runPiStreaming(
			["run", "task"],
			"/tmp/project",
			tempOutputPath("pi-subagents-backend-launch-"),
			{ CUSTOM_ENV: "yes" },
			undefined,
			undefined,
			3,
			{ eventsPath: tempOutputPath("pi-subagents-backend-events-"), runId: "async-run-1", stepIndex: 7, agent: "worker" },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			(writer: WriterState) => writerStates.push(writer),
			HEADLESS_TERMINAL_CONFIG,
			{
				createChildProcessBackend: (terminalConfig: ResolvedTerminalConfig | undefined): ChildProcessBackend => {
					assert.deepEqual(terminalConfig, HEADLESS_TERMINAL_CONFIG);
					return {
						launch: async (request: ChildLaunchRequest) => {
							launches.push(request);
							return createSettlingChild(4242);
						},
					};
				},
			},
		);

		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput.trim(), "done");
		assert.equal(launches.length, 1);
		assert.equal(launches[0].cwd, "/tmp/project");
		assert.deepEqual(launches[0].args.slice(-2), ["run", "task"]);
		assert.equal(launches[0].label, "worker");
		assert.equal(launches[0].runId, "async-run-1");
		assert.equal(launches[0].childIndex, 7);
		assert.equal(launches[0].env.CUSTOM_ENV, "yes");
		assert.equal(launches[0].env.PI_SUBAGENT_DEPTH, String(Number(process.env.PI_SUBAGENT_DEPTH ?? "0") + 1));
		assert.equal(launches[0].env.PI_SUBAGENT_MAX_DEPTH, "3");
		assert.deepEqual(writerStates, [{ state: "spawning" }, { state: "running", pid: 4242 }, { state: "none" }]);
	});

	it("keeps detached async supervisor launch outside the child process backend", () => {
		const source = fs.readFileSync(path.resolve("src/runs/background/async-execution.ts"), "utf-8");
		assert.doesNotMatch(source, /createChildProcessBackend/);
		assert.match(__testSpawnRunner.toString(), /detached:\s*true/);
	});

	it("returns a failed result and clears writer state when backend launch rejects", async () => {
		const outputFile = tempOutputPath("pi-subagents-backend-reject-");
		const writerStates: WriterState[] = [];
		const result = await runPiStreaming(
			["run", "task"],
			"/tmp/project",
			outputFile,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			(writer: WriterState) => writerStates.push(writer),
			HEADLESS_TERMINAL_CONFIG,
			{
				createChildProcessBackend: (): ChildProcessBackend => ({
					launch: async () => {
						throw new Error("backend launch failed");
					},
				}),
			},
		);

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "backend launch failed");
		assert.deepEqual(result.messages, []);
		assert.deepEqual(writerStates, [{ state: "spawning" }, { state: "none" }]);
		assert.equal(fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf-8") : "", "");
	});
});
