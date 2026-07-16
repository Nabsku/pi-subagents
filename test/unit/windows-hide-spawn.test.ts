import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSource(sourcePath: string): string {
	return fs.readFileSync(path.join(projectRoot, sourcePath), "utf-8");
}

function assertNestedPiSpawnHidesWindows(sourcePath: string, pattern = /spawn\(spawnSpec\.command,\s*spawnSpec\.args,\s*\{[^}]*windowsHide:\s*true/s): void {
	const source = fs.readFileSync(path.join(projectRoot, sourcePath), "utf-8");
	assert.match(
		source,
		pattern,
		`${sourcePath} nested Pi spawn should set windowsHide: true`,
	);
}

describe("nested child Pi process visibility", () => {
	it("keeps foreground execution Promise lifecycle synchronous", () => {
		assert.doesNotMatch(
			readSource("src/runs/foreground/execution.ts"),
			/new Promise<[^>]+>\(\s*async\s*\(/,
			"foreground execution must not use async Promise executors because post-await throws become unhandled rejections",
		);
	});

	it("hides foreground child Pi process windows on Windows", () => {
		assert.match(
			readSource("src/runs/foreground/execution.ts"),
			/createChildProcessBackend\(/,
			"foreground execution should route Pi launches through the process backend",
		);
		assertNestedPiSpawnHidesWindows("src/runs/shared/process-backend.ts", /spawnImpl\(request\.command,\s*request\.args,\s*\{[^}]*windowsHide:\s*true/s);
	});

	it("hides background child Pi process windows on Windows", () => {
		assertNestedPiSpawnHidesWindows("src/runs/background/subagent-runner.ts");
	});
});
