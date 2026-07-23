import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildDoctorReport, diagnoseHerdr } from "../../src/extension/doctor.ts";
import type { AgentConfig, ChainConfig } from "../../src/agents/agents.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function makeState(cwd: string): SubagentState {
	return {
		baseCwd: cwd,
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function makeAgent(name: string, source: AgentConfig["source"]): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: "Prompt",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source,
		filePath: `/tmp/${name}.md`,
	};
}

function makeChain(name: string, source: ChainConfig["source"]): ChainConfig {
	return {
		name,
		description: `${name} chain`,
		source,
		filePath: `/tmp/${name}.chain.md`,
		steps: [{ agent: "worker", task: "Work" }],
	};
}

function fixturePath(): string {
	return path.resolve("test/fixtures/fake-herdr.mjs");
}

describe("buildDoctorReport", () => {
	it("probes Herdr and its plugin by capability", () => {
		const fake = diagnoseHerdr(process.execPath, [path.resolve("test/fixtures/fake-herdr.mjs")]);
		assert.deepEqual(fake, {
			version: "0.7.4", protocol: 17, schemaVersion: 1,
			pluginInstalled: true, pluginEnabled: true, splitSupported: true,
			parentIdentity: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
		});
	});

	it("parses the live plugin-list envelope and rejects incompatible plugin capabilities", () => {
		const modes = [
			["legacy-plugin", { pluginInstalled: false, pluginEnabled: false, splitSupported: false }],
			["wrong-plugin", { pluginInstalled: false, pluginEnabled: false, splitSupported: false }],
			["missing-plugin", { pluginInstalled: false, pluginEnabled: false, splitSupported: false }],
			["disabled-plugin", { pluginInstalled: true, pluginEnabled: false, splitSupported: false }],
			["legacy-entrypoint", { pluginInstalled: true, pluginEnabled: true, splitSupported: false }],
		] as const;
		for (const [mode, expected] of modes) {
			const diagnostic = diagnoseHerdr(process.execPath, [fixturePath(), "--control-mode", mode]);
			assert.deepEqual({
				pluginInstalled: diagnostic.pluginInstalled,
				pluginEnabled: diagnostic.pluginEnabled,
				splitSupported: diagnostic.splitSupported,
			}, expected, mode);
		}
		const malformed = diagnoseHerdr(process.execPath, [fixturePath(), "--control-mode", "malformed-plugin-list"]);
		assert.match(malformed.error ?? "", /plugin list response missing plugins array/);
	});

	it("prefers explicit parent identity from the Pi environment over focused snapshot state", () => {
		const keys = ["HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"] as const;
		const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
		try {
			process.env.HERDR_WORKSPACE_ID = "w9";
			process.env.HERDR_TAB_ID = "w9:t8";
			process.env.HERDR_PANE_ID = "w9:p7";
			const fake = diagnoseHerdr(process.execPath, [path.resolve("test/fixtures/fake-herdr.mjs")]);
			assert.deepEqual(fake.parentIdentity, { workspaceId: "w9", tabId: "w9:t8", paneId: "w9:p7" });
		} finally {
			for (const key of keys) {
				const value = prior[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("reports Herdr plugin capabilities and private prompt transport", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-herdr-"));
		try {
			const report = buildDoctorReport({
				cwd: root,
				config: { terminal: { backend: "herdr-plugin", placement: "tab", focus: false, closeOnExit: false, fallback: "error" } },
				state: makeState(root),
				paths: {
					tempRootDir: root,
					asyncDir: root,
					resultsDir: root,
					chainRunsDir: root,
				},
				deps: {
					diagnoseHerdr: () => ({
						version: "0.8.0", protocol: 17, schemaVersion: 1,
						pluginInstalled: true, pluginEnabled: true, splitSupported: true,
						parentIdentity: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
					}),
					isAsyncAvailable: () => true,
					discoverAgentsAll: () => ({
						builtin: [], package: [], user: [], project: [], chains: [], packageErrors: [],
						userDir: root, projectDir: root, userChainDir: root, projectChainDir: root,
						userSettingsPath: path.join(root, "settings.json"), projectSettingsPath: path.join(root, "settings.json"),
					}),
					discoverAvailableSkills: () => [],
					diagnoseIntercomBridge: () => ({ active: false, mode: "off", wantsIntercom: false, supervisorChannelAvailable: true, extensionDir: "native" }),
				},
			});

			assert.match(report, /Terminal backend/);
			assert.match(report, /- backend: herdr-plugin/);
			assert.match(report, /- placement: tab/);
			assert.match(report, /- focus: false/);
			assert.match(report, /- fallback: error/);
			assert.match(report, /Herdr: version 0\.8\.0; protocol 17; schema 1/);
			assert.match(report, /plugin: installed; enabled/);
			assert.match(report, /split support: available/);
			assert.match(report, /parent identity: w1 \/ w1:t1 \/ w1:p1/);
			assert.match(report, /prompt transport: private file descriptors supported/);
			assert.match(report, /verdict: compatible/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("gives actionable Herdr plugin compatibility failures", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-herdr-failure-"));
		try {
			const report = buildDoctorReport({
				cwd: root,
				config: { terminal: { backend: "herdr-plugin", placement: "pane" } },
				state: makeState(root),
				deps: { diagnoseHerdr: () => ({ protocol: 17, schemaVersion: 1, pluginInstalled: false, pluginEnabled: false, splitSupported: false }) },
			});
			assert.match(report, /plugin: missing; disabled/);
			assert.match(report, /install pi-subagents\.herdr/);
			assert.match(report, /plugin pane\/split entrypoint/);
			assert.match(report, /parent Herdr pane identity/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("formats a bounded successful environment summary", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-success-"));
		try {
			const state = makeState(root);
			state.subagentSpawns = {
				sessionId: "session-abc123",
				count: 3,
				configuredLimit: 4,
				granted: 1,
				grantHistory: [{ sessionId: "session-abc123", amount: 1, grantedAt: 0, previousLimit: 4, limit: 5 }],
			};
			const paths = {
				tempRootDir: path.join(root, "temp-root"),
				asyncDir: path.join(root, "async"),
				resultsDir: path.join(root, "results"),
				chainRunsDir: path.join(root, "chains"),
			};
			for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });

			const report = buildDoctorReport({
				cwd: root,
				config: { defaultSessionDir: "~/subagent-sessions", intercomBridge: { mode: "always" }, maxSubagentSpawnsPerSession: 4 },
				state,
				currentSessionFile: path.join(root, "sessions", "parent.jsonl"),
				currentSessionId: "session-abc123",
				orchestratorTarget: "subagent-chat-abc123",
				expandTilde: (value) => value.replace(/^~\//, `${root}/home/`),
				paths,
				deps: {
					isAsyncAvailable: () => true,
					discoverAgentsAll: () => ({
						builtin: [makeAgent("builtin-a", "builtin")],
						user: [makeAgent("user-a", "user")],
						project: [makeAgent("project-a", "project"), makeAgent("project-b", "project")],
						chains: [makeChain("user-flow", "user"), makeChain("project-flow", "project")],
						userDir: path.join(root, "home", ".agents"),
						projectDir: path.join(root, ".pi", "agents"),
						userChainDir: path.join(root, "home", ".pi", "agent", "chains"),
						projectChainDir: path.join(root, ".pi", "chains"),
						userSettingsPath: path.join(root, "home", ".pi", "agent", "settings.json"),
						projectSettingsPath: path.join(root, ".pi", "settings.json"),
					}),
					discoverAvailableSkills: () => [
						{ name: "project-skill", source: "project" },
						{ name: "package-skill", source: "user-package" },
					],
					diagnoseIntercomBridge: () => ({
						active: true,
						mode: "always",
						wantsIntercom: true,
						supervisorChannelAvailable: true,
						extensionDir: "native:pi-subagents-supervisor-channel",
						orchestratorTarget: "subagent-chat-abc123",
					}),
				},
			});

			assert.match(report, /^Subagents doctor report/);
			assert.ok(report.includes(`- cwd: ${root}`));
			assert.match(report, /- async support: available/);
			assert.match(report, /- configured session dir: .*subagent-sessions/);
			assert.match(report, /- current session file: .*parent\.jsonl/);
			assert.match(report, /- temp root: ok /);
			assert.match(report, /- agents: total 4 \(builtin 1, package 0, user 1, project 2\)/);
			assert.match(report, /- chains: total 2 \(builtin 0, package 0, user 1, project 1\)/);
			assert.match(report, /Spawn budget\n- usage: 3\/5 used, 2 remaining \(configured 4; granted 1; grant allowance 3\)/);
			assert.match(report, /- recent grants: \+1 at 1970-01-01T00:00:00\.000Z \(4 → 5\)/);
			assert.match(report, /new parent session resets usage and grants; compaction does not/);
			assert.match(report, /- skills: total 2 \(project 1, user-package 1\)/);
			assert.match(report, /- bridge: active/);
			assert.match(report, /- supervisor channel: available \(native:pi-subagents-supervisor-channel\)/);
			assert.doesNotMatch(report, /Companion packages/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps reporting when a directory or discovery check fails", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-failure-"));
		try {
			const asyncPath = path.join(root, "async-file");
			fs.writeFileSync(asyncPath, "not a directory");
			const report = buildDoctorReport({
				cwd: root,
				config: {},
				state: makeState(root),
				paths: {
					tempRootDir: root,
					asyncDir: asyncPath,
					resultsDir: path.join(root, "missing-results"),
					chainRunsDir: path.join(root, "missing-chains"),
				},
				deps: {
					isAsyncAvailable: () => false,
					discoverAgentsAll: () => {
						throw new Error("discovery exploded");
					},
					discoverAvailableSkills: () => [],
					diagnoseIntercomBridge: () => ({
						active: false,
						mode: "fork-only",
						wantsIntercom: false,
						supervisorChannelAvailable: true,
						extensionDir: "native:pi-subagents-supervisor-channel",
						reason: "bridge mode is fork-only and context is not fork",
					}),
				},
			});

			assert.match(report, /- async support: unavailable/);
			assert.match(report, /- async runs: failed .*Error: not a directory:/);
			assert.match(report, /- results: missing /);
			assert.match(report, /- agents\/chains: failed — Error: discovery exploded/);
			assert.match(report, /- skills: total 0 \(none\)/);
			assert.match(report, /- bridge: inactive \(bridge mode is fork-only and context is not fork\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
