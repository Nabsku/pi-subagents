#!/usr/bin/env node
import fs from "node:fs";

const argv = process.argv.slice(2);
let mode = process.env.FAKE_HERDR_MODE ?? "ok";
let logPath = process.env.FAKE_HERDR_LOG;
const WORKSPACE_PATTERN = /^w[1-9][0-9]*$/;
for (let index = 0; index < argv.length;) {
	if (argv[index] === "--control-mode") {
		mode = argv[index + 1] ?? mode;
		argv.splice(index, 2);
		continue;
	}
	if (argv[index] === "--control-log") {
		logPath = argv[index + 1] ?? logPath;
		argv.splice(index, 2);
		continue;
	}
	index += 1;
}

if (logPath) {
	fs.appendFileSync(logPath, JSON.stringify({ argv, cwd: process.cwd(), env: process.env }) + "\n");
}

function json(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (mode === "server-stopped") {
	process.stderr.write("Herdr server is not running\n");
	process.exit(2);
}
if (mode === "malformed-json" || (mode === "malformed-start" && argv[0] === "agent" && argv[1] === "start")) {
	process.stdout.write("{not json\n");
	process.exit(0);
}
if (mode === "timeout" || (mode === "start-timeout" && argv[0] === "agent" && argv[1] === "start")) {
	setTimeout(() => {}, 60_000);
	process.stdin.resume();
	process.exitCode = 0;
	await new Promise(() => {});
}
if (mode === "bad-protocol" && argv.join(" ") === "api schema --json") {
	json({ protocol: 15, schema_version: 1, request: {}, response: {}, event: {}, version: "0.7.4" });
	process.exit(0);
}
if (mode === "bad-version" && argv.join(" ") === "api schema --json") {
	json({ protocol: 16, schema_version: 1, request: {}, response: {}, event: {}, version: "0.7.3" });
	process.exit(0);
}
if (mode === "bad-ids" && argv[0] === "agent" && argv[1] === "start") {
	json({ workspace_id: "workspace-1", tab_id: "tab-1", pane_id: "pane-1" });
	process.exit(0);
}
if (mode === "large-output") {
	process.stdout.write("x".repeat(128 * 1024));
	process.exit(0);
}

if (argv.join(" ") === "api schema --json") {
	json({ protocol: 16, schema_version: 1, request: {}, response: {}, event: {}, version: "0.7.4" });
	process.exit(0);
}
if (argv.join(" ") === "api snapshot") {
	const inside = mode !== "parent-outside";
	if (mode === "active-later") {
		json({
			workspaces: [
				{ id: "w1", tabs: [{ id: "w1:t1", panes: [{ id: "w1:p1", active: false }] }] },
				{ id: "w2", tabs: [{ id: "w2:t1", panes: [{ id: "w2:p1", active: true }] }] },
			],
		});
		process.exit(0);
	}
	json({ workspaces: [{ id: "w1", tabs: [{ id: "w1:t1", panes: [{ id: "w1:p1", active: inside }] }] }] });
	process.exit(0);
}
if (argv[0] === "agent" && argv[1] === "start") {
	if (mode === "wrong-workspace-start") {
		json({ workspace_id: "w2", tab_id: "w2:t2", pane_id: "w2:p2", terminal_id: "term_abc-123" });
		process.exit(0);
	}
	const workspaceArg = argv[argv.indexOf("--workspace") + 1];
	if (WORKSPACE_PATTERN.test(workspaceArg)) {
		json({ workspace_id: workspaceArg, tab_id: `${workspaceArg}:t2`, pane_id: `${workspaceArg}:p2`, terminal_id: "term_abc-123" });
		process.exit(0);
	}
	json({ workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p2", terminal_id: "term_abc-123" });
	process.exit(0);
}
if (argv[0] === "pane" && argv[1] === "inspect") {
	if (mode === "malformed-inspect") {
		json({ workspace_id: "w1", tab_id: "not-a-tab", pane_id: "w1:p2" });
		process.exit(0);
	}
	json({ workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p2", terminal_id: "term_abc-123", title: "child" });
	process.exit(0);
}
if (argv[0] === "pane" && argv[1] === "read") {
	if (mode === "malformed-read") {
		json({ text: 42 });
		process.exit(0);
	}
	json({ text: "display text" });
	process.exit(0);
}
if ((argv[0] === "pane" || argv[0] === "tab" || argv[0] === "workspace") && argv[1] === "close") {
	if (mode === "malformed-close") {
		json({ closed: "yes" });
		process.exit(0);
	}
	json({ closed: true });
	process.exit(0);
}

process.stderr.write(`unexpected fake-herdr argv: ${argv.join(" ")}\n`);
process.exit(64);
