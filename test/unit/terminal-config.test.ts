import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfig, loadResolvedTerminalConfig } from "../../src/extension/config.ts";
import { resolveTerminalConfig } from "../../src/runs/shared/terminal-config.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

function withTempAgentDir(configJson: string): string {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-terminal-config-"));
	const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, configJson, "utf-8");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return agentDir;
}

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

describe("resolveTerminalConfig", () => {
	it("defaults to headless tab placement without focus, cleanup, or fallback", () => {
		assert.deepEqual(resolveTerminalConfig(undefined), {
			backend: "headless",
			placement: "tab",
			splitDirection: "right",
			focus: false,
			closeOnExit: false,
			fallback: "error",
		});
	});

	it("accepts an explicit Herdr tab config", () => {
		assert.deepEqual(resolveTerminalConfig({
			backend: "herdr",
			placement: "tab",
			focus: false,
			closeOnExit: true,
			fallback: "headless",
		}), {
			backend: "herdr",
			placement: "tab",
			splitDirection: "right",
			focus: false,
			closeOnExit: true,
			fallback: "headless",
		});
	});

	it("rejects invalid explicit terminal blocks before launch", () => {
		assert.throws(
			() => resolveTerminalConfig({ backend: "xterm" }),
			/terminal\.backend must be "headless" or "herdr"/,
		);
		assert.throws(
			() => resolveTerminalConfig({ backnd: "herdr" } as any),
			/terminal\.backnd is not supported/,
		);
		assert.throws(
			() => resolveTerminalConfig({ placement: "window" } as any),
			/terminal\.placement must be "tab" or "pane"/,
		);
		assert.throws(
			() => resolveTerminalConfig({ splitDirection: "left" } as any),
			/terminal\.splitDirection must be "right" or "down"/,
		);
		assert.throws(
			() => resolveTerminalConfig({ fallback: "always" } as any),
			/terminal\.fallback must be "error" or "headless"/,
		);
		assert.throws(
			() => resolveTerminalConfig({ focus: "false" } as any),
			/terminal\.focus must be a boolean/,
		);
		assert.throws(
			() => resolveTerminalConfig({ closeOnExit: "true" } as any),
			/terminal\.closeOnExit must be a boolean/,
		);
	});

	it("preserves malformed whole-file config compatibility", () => {
		const agentDir = withTempAgentDir("{ malformed json");
		try {
			assert.deepEqual(loadConfig(), {});
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("loads explicit terminal config so launch code can fail closed", () => {
		const agentDir = withTempAgentDir(JSON.stringify({ terminal: { backend: "xterm" } }));
		try {
			const config = loadConfig();
			assert.deepEqual(config.terminal, { backend: "xterm" });
			assert.throws(() => resolveTerminalConfig(config.terminal), /terminal\.backend/);
			assert.throws(() => loadResolvedTerminalConfig(), /terminal\.backend/);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	for (const [name, terminal, errorPattern] of [
		["unknown terminal keys", { backnd: "herdr" }, /terminal\.backnd is not supported/],
		["invalid split direction", { splitDirection: "left" }, /terminal\.splitDirection/],
		["invalid close on exit", { closeOnExit: "true" }, /terminal\.closeOnExit/],
		["null terminal block", null, /terminal must be a JSON object/],
		["array terminal block", [], /terminal must be a JSON object/],
		["scalar terminal block", "herdr", /terminal must be a JSON object/],
	] as const) {
		it(`rejects ${name} from loaded config before launch`, () => {
			const agentDir = withTempAgentDir(JSON.stringify({ terminal }));
			try {
				assert.throws(() => loadResolvedTerminalConfig(), errorPattern);
			} finally {
				fs.rmSync(agentDir, { recursive: true, force: true });
			}
		});
	}
});
