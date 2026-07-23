#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
let mode = process.env.FAKE_HERDR_MODE ?? "ok";
let logPath = process.env.FAKE_HERDR_LOG;
const WORKSPACE_PATTERN = /^w[1-9][0-9]*$/;
const PLUGIN_ID = "pi-subagents.hybrid";
const PLUGIN_ROOT = path.resolve("test/fixtures/herdr-plugin");
const PLUGIN_ACTIONS = ["inspect", "stop", "retry"];
const PLUGIN_ENTRYPOINT = "relay-runner";
const DOCUMENTED_ENV_KEYS = new Set([
	"HERDR_SOCKET_PATH",
	"HERDR_BIN_PATH",
	"HERDR_ENV",
	"HERDR_PLUGIN_ID",
	"HERDR_PLUGIN_ROOT",
	"HERDR_PLUGIN_CONFIG_DIR",
	"HERDR_PLUGIN_STATE_DIR",
	"HERDR_PLUGIN_CONTEXT_JSON",
	"HERDR_PLUGIN_ACTION_ID",
	"HERDR_PLUGIN_ENTRYPOINT_ID",
	"HERDR_WORKSPACE_ID",
	"HERDR_TAB_ID",
	"HERDR_PANE_ID",
	"PI_RUN_ID",
]);

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

function invalidArgv(message) {
	throw new Error(`invalid fake-herdr argv: ${message}`);
}

function parseStrictOptions(tokens, allowed, repeatable = new Set()) {
	const values = new Map();
	if (tokens.length % 2 !== 0) invalidArgv("missing option value");
	for (let index = 0; index < tokens.length; index += 2) {
		const option = tokens[index];
		const value = tokens[index + 1];
		if (!allowed.has(option) || value === undefined || value.startsWith("--")) invalidArgv(String(option));
		if (values.has(option) && !repeatable.has(option)) invalidArgv(`duplicate ${option}`);
		values.set(option, [...(values.get(option) ?? []), value]);
	}
	return values;
}

function validatePluginArgv(tokens) {
	if (tokens[1] === "link") {
		if (tokens.length !== 3 || tokens[2].startsWith("--")) invalidArgv("plugin link");
		return;
	}
	if (tokens[1] === "list") {
		if (tokens.length !== 3 || tokens[2] !== "--json") invalidArgv("plugin list");
		return;
	}
	if (tokens[1] === "action" && tokens[2] === "invoke") {
		if (tokens.length !== 6 || tokens[4] !== "--plugin" || !tokens[3] || !tokens[5]) invalidArgv("plugin action invoke");
		return;
	}
	if (tokens[1] === "pane" && tokens[2] === "open") {
		const options = parseStrictOptions(tokens.slice(3), new Set(["--plugin", "--entrypoint", "--placement", "--cwd", "--workspace", "--target-pane", "--direction", "--env"]), new Set(["--env"]));
		for (const required of ["--plugin", "--entrypoint", "--placement", "--cwd"]) if (!options.has(required)) invalidArgv(`missing ${required}`);
		return;
	}
	if (tokens[1] === "log" && tokens[2] === "list") {
		if (tokens.length !== 3) invalidArgv("plugin log list");
	}
}

if (argv[0] === "plugin") validatePluginArgv(argv);

function documentedEnv(input) {
	const env = {};
	for (const [key, value] of Object.entries(input)) {
		if (DOCUMENTED_ENV_KEYS.has(key) && typeof value === "string") env[key] = value;
	}
	return env;
}

function isSecretKey(key) {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	return ["capability", "secret", "token", "apikey", "password", "credential", "privatekey"].some((alias) => normalized.includes(alias));
}

function isSecretValue(value) {
	return typeof value === "string" && isSecretKey(value);
}

function scrubCommandEnv(input) {
	const env = {};
	for (const [key, value] of Object.entries(input)) {
		if (!isSecretKey(key) && typeof value === "string") env[key] = value;
	}
	return env;
}

if (logPath && argv[0] !== "plugin") {
	fs.appendFileSync(logPath, JSON.stringify({ argv, cwd: process.cwd(), env: scrubCommandEnv(process.env) }) + "\n");
}

function json(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseValue(raw) {
	const trimmed = raw.trim();
	if (/^"(?:[^"\\]|\\.)*"$/.test(trimmed)) return JSON.parse(trimmed);
	if (/^\[(.*)\]$/.test(trimmed)) {
		const body = trimmed.slice(1, -1).trim();
		if (body === "") return [];
		return body.split(",").map((part) => parseValue(part.trim()));
	}
	throw new Error("unsupported plugin manifest value");
}

function parseManifest(root) {
	const manifestPath = path.join(root, "herdr-plugin.toml");
	if (!fs.existsSync(manifestPath)) throw new Error("plugin manifest not found");
	const manifest = { actions: [], panes: [] };
	let section = manifest;
	const seenTop = new Set();
	for (const [lineNumber, rawLine] of fs.readFileSync(manifestPath, "utf-8").split(/\r?\n/).entries()) {
		const line = rawLine.replace(/\s+#.*$/, "").trim();
		if (!line) continue;
		if (line === "[[actions]]") {
			section = {};
			manifest.actions.push(section);
			continue;
		}
		if (line === "[[panes]]") {
			section = {};
			manifest.panes.push(section);
			continue;
		}
		const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
		if (!match) throw new Error(`invalid plugin manifest line ${lineNumber + 1}`);
		const [, key, rawValue] = match;
		if (section === manifest) {
			if (seenTop.has(key)) throw new Error("invalid plugin manifest duplicate top-level key");
			seenTop.add(key);
		}
		if (Object.hasOwn(section, key)) throw new Error(`invalid plugin manifest duplicate ${key}`);
		section[key] = parseValue(rawValue);
	}
	validateManifest(root, manifest);
	return manifest;
}

function assertString(record, key, label) {
	if (typeof record[key] !== "string" || record[key].length === 0) throw new Error(`invalid plugin manifest ${label}.${key}`);
}

function assertStringArray(record, key, label) {
	if (!Array.isArray(record[key]) || record[key].some((item) => typeof item !== "string" || item.length === 0)) throw new Error(`invalid plugin manifest ${label}.${key}`);
}

function rejectUnknown(record, allowed, label) {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) throw new Error(`unsupported plugin manifest ${label}.${key}`);
	}
}

function validateScript(root, command) {
	if (!Array.isArray(command) || command.length < 2 || command.some((part) => typeof part !== "string" || part.length === 0)) throw new Error("invalid plugin manifest command");
	const script = command.find((part) => part.startsWith("./scripts/"));
	if (!script || script.includes("..") || path.isAbsolute(script)) throw new Error("invalid plugin manifest command script");
	if (!fs.existsSync(path.join(root, script))) throw new Error("missing plugin script");
}

function validateManifest(root, manifest) {
	rejectUnknown(manifest, ["id", "name", "version", "min_herdr_version", "description", "actions", "panes"], "root");
	for (const key of ["id", "name", "version", "min_herdr_version", "description"]) assertString(manifest, key, "root");
	if (manifest.id !== PLUGIN_ID) throw new Error("invalid plugin manifest root.id");
	if (manifest.min_herdr_version !== "0.7.4") throw new Error("invalid plugin manifest root.min_herdr_version");
	if (manifest.actions.length !== PLUGIN_ACTIONS.length) throw new Error("invalid plugin manifest actions");
	const actionIds = new Set();
	for (const action of manifest.actions) {
		rejectUnknown(action, ["id", "title", "command", "contexts"], "actions");
		assertString(action, "id", "actions");
		assertString(action, "title", "actions");
		assertStringArray(action, "contexts", "actions");
		if (!PLUGIN_ACTIONS.includes(action.id)) throw new Error("invalid plugin manifest actions.id");
		if (actionIds.has(action.id)) throw new Error("invalid plugin manifest duplicate action id");
		actionIds.add(action.id);
		if (action.contexts.length !== 1 || action.contexts[0] !== "pane") throw new Error("unsupported plugin manifest actions.contexts");
		validateScript(root, action.command);
	}
	if (manifest.panes.length !== 1) throw new Error("invalid plugin manifest panes");
	const pane = manifest.panes[0];
	rejectUnknown(pane, ["id", "title", "command", "placement"], "panes");
	assertString(pane, "id", "panes");
	assertString(pane, "title", "panes");
	assertString(pane, "placement", "panes");
	if (pane.id !== PLUGIN_ENTRYPOINT) throw new Error("invalid plugin manifest panes.id");
	if (pane.placement !== "tab") throw new Error("unsupported plugin manifest panes.placement");
	validateScript(root, pane.command);
}

function pluginManifest(root = PLUGIN_ROOT) {
	return parseManifest(root);
}

function canonicalPluginContext(raw) {
	if (raw === undefined || raw === "{}") return "{}";
	let value;
	try { value = JSON.parse(raw); } catch { throw new Error("invalid HERDR_PLUGIN_CONTEXT_JSON"); }
	const containsSecretValue = (input) => {
		if (typeof input === "string") {
			const normalized = input.toLowerCase().replace(/[^a-z0-9]/g, "");
			return ["capability", "secret", "token", "apikey", "password", "credential", "privatekey"].some((alias) => normalized.includes(alias));
		}
		if (Array.isArray(input)) return input.some(containsSecretValue);
		return Boolean(input && typeof input === "object" && Object.values(input).some(containsSecretValue));
	};
	if (containsSecretValue(value)) throw new Error("invalid HERDR_PLUGIN_CONTEXT_JSON");
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("invalid HERDR_PLUGIN_CONTEXT_JSON");
	const allowed = new Set(["schema", "contractVersion", "pluginId", "runId", "childIndex", "capabilityChannel", "terminal"]);
	if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("invalid HERDR_PLUGIN_CONTEXT_JSON");
	if (value.schema !== "pi-herdr-plugin-context/v1" || value.contractVersion !== 1 || value.pluginId !== PLUGIN_ID || typeof value.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.runId) || !Number.isSafeInteger(value.childIndex) || value.childIndex < 0) throw new Error("invalid HERDR_PLUGIN_CONTEXT_JSON");
	const channel = value.capabilityChannel;
	if (!channel || typeof channel !== "object" || Array.isArray(channel) || Object.getPrototypeOf(channel) !== Object.prototype || Object.keys(channel).some((key) => !["kind", "transport", "id"].includes(key)) || channel.kind !== "controller-local-one-shot" || !["unix-socket", "named-pipe"].includes(channel.transport) || !/^pi-subagents:capchan-[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(channel.id)) throw new Error("invalid HERDR_PLUGIN_CONTEXT_JSON");
	let canonicalTerminal;
	if (value.terminal !== undefined) {
		const terminal = value.terminal;
		if (!terminal || typeof terminal !== "object" || Array.isArray(terminal) || Object.getPrototypeOf(terminal) !== Object.prototype || Object.keys(terminal).some((key) => !["workspaceId", "tabId", "paneId", "terminalId"].includes(key)) || !/^w[1-9][0-9]{0,8}$/.test(terminal.workspaceId) || !new RegExp(`^${terminal.workspaceId}:t[1-9][0-9]{0,8}$`).test(terminal.tabId) || !new RegExp(`^${terminal.workspaceId}:p[1-9][0-9]{0,8}$`).test(terminal.paneId) || (terminal.terminalId !== undefined && !/^term_[A-Za-z0-9_-]{1,64}$/.test(terminal.terminalId))) throw new Error("invalid HERDR_PLUGIN_CONTEXT_JSON");
		canonicalTerminal = { workspaceId: terminal.workspaceId, tabId: terminal.tabId, paneId: terminal.paneId };
		if (terminal.terminalId !== undefined) canonicalTerminal.terminalId = terminal.terminalId;
	}
	const canonical = {
		schema: value.schema,
		contractVersion: value.contractVersion,
		pluginId: value.pluginId,
		runId: value.runId,
		childIndex: value.childIndex,
		capabilityChannel: { kind: channel.kind, transport: channel.transport, id: channel.id },
	};
	if (canonicalTerminal !== undefined) canonical.terminal = canonicalTerminal;
	const pending = [canonical];
	while (pending.length > 0) {
		const current = pending.pop();
		for (const item of Object.values(current)) {
			if (isSecretValue(item)) throw new Error("invalid HERDR_PLUGIN_CONTEXT_JSON");
			if (item && typeof item === "object") pending.push(item);
		}
	}
	return JSON.stringify(canonical);
}

function pluginEnv(extra = {}) {
	return documentedEnv({
		HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH ?? "/tmp/fake-herdr.sock",
		HERDR_BIN_PATH: process.env.HERDR_BIN_PATH ?? process.execPath,
		HERDR_ENV: "1",
		HERDR_PLUGIN_ID: PLUGIN_ID,
		HERDR_PLUGIN_ROOT: PLUGIN_ROOT,
		HERDR_PLUGIN_CONFIG_DIR: path.join(PLUGIN_ROOT, ".fake-config"),
		HERDR_PLUGIN_STATE_DIR: path.join(PLUGIN_ROOT, ".fake-state"),
		HERDR_PLUGIN_CONTEXT_JSON: canonicalPluginContext(process.env.HERDR_PLUGIN_CONTEXT_JSON),
		...extra,
	});
}

function logPluginCommand(argv, env) {
	if (logPath) fs.appendFileSync(logPath, JSON.stringify({ argv, cwd: process.cwd(), env: documentedEnv(env) }) + "\n");
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
	json({ protocol: 16, schema_version: 1, request: {}, response: {}, event: {}, version: "0.7.4" });
	process.exit(0);
}
if (mode === "bad-version" && argv.join(" ") === "api schema --json") {
	json({ protocol: 17, schema_version: 1, request: {}, response: {}, event: {}, version: "0.7.3" });
	process.exit(0);
}
if (mode === "future-version" && argv.join(" ") === "api schema --json") {
	json({ protocol: 17, schema_version: 1, request: {}, response: {}, event: {}, version: "0.7.5" });
	process.exit(0);
}
if (mode === "bad-ids" && argv[0] === "tab" && argv[1] === "create") {
	json({ result: { root_pane: { workspace_id: "workspace-1", tab_id: "tab-1", pane_id: "pane-1" } } });
	process.exit(0);
}
if (mode === "large-output") {
	process.stdout.write("x".repeat(128 * 1024));
	process.exit(0);
}

if (argv.join(" ") === "api schema --json") {
	json({ protocol: 17, schema_version: 1, request: {}, response: {}, event: {}, version: "0.7.4" });
	process.exit(0);
}
if (argv[0] === "plugin" && argv[1] === "link") {
	const root = argv[2];
	try {
		if (!root) throw new Error("plugin manifest not found");
		pluginManifest(root);
		json({ type: "plugin_linked", plugin_id: PLUGIN_ID, root });
		process.exit(0);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exit(2);
	}
}
if (argv[0] === "plugin" && argv[1] === "list" && argv[2] === "--json") {
	const manifest = pluginManifest();
	json({
		type: "plugin_list",
		plugins: [{
			id: manifest.id,
			root: PLUGIN_ROOT,
			enabled: true,
			actions: manifest.actions.map((action) => ({ id: action.id, title: action.title, contexts: action.contexts })),
			panes: manifest.panes.map((pane) => ({ id: pane.id, title: pane.title, placement: pane.placement })),
		}],
	});
	process.exit(0);
}
if (argv[0] === "plugin" && argv[1] === "action" && argv[2] === "invoke") {
	const action = argv[3];
	const pluginId = argv[argv.indexOf("--plugin") + 1];
	pluginManifest();
	if (pluginId !== PLUGIN_ID || !PLUGIN_ACTIONS.includes(action)) {
		process.stderr.write("unknown plugin action\n");
		process.exit(2);
	}
	logPluginCommand(["node", "./scripts/action.mjs", action], pluginEnv({
		HERDR_PLUGIN_ACTION_ID: action,
		HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID ?? "w1",
		HERDR_TAB_ID: process.env.HERDR_TAB_ID ?? "w1:t1",
		HERDR_PANE_ID: process.env.HERDR_PANE_ID ?? "w1:p1",
	}));
	json({ type: "plugin_action_result", plugin_id: PLUGIN_ID, action_id: action, ok: true });
	process.exit(0);
}
if (argv[0] === "plugin" && argv[1] === "pane" && argv[2] === "open") {
	const pluginId = argv[argv.indexOf("--plugin") + 1];
	const entrypoint = argv[argv.indexOf("--entrypoint") + 1];
	pluginManifest();
	if (pluginId !== PLUGIN_ID || entrypoint !== PLUGIN_ENTRYPOINT) {
		process.stderr.write("unknown plugin pane\n");
		process.exit(2);
	}
	const workspaceId = argv.includes("--workspace") ? argv[argv.indexOf("--workspace") + 1] : "w1";
	const inheritedEnv = {};
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--env") {
			const [key, ...rest] = String(argv[index + 1] ?? "").split("=");
			if (key) inheritedEnv[key] = rest.join("=");
		}
	}
	logPluginCommand(["node", "./scripts/relay-runner.mjs"], pluginEnv({
		HERDR_PLUGIN_ENTRYPOINT_ID: PLUGIN_ENTRYPOINT,
		HERDR_WORKSPACE_ID: workspaceId,
		HERDR_TAB_ID: `${workspaceId}:t3`,
		HERDR_PANE_ID: `${workspaceId}:p3`,
		...inheritedEnv,
	}));
	json({ type: "plugin_pane_opened", plugin_id: PLUGIN_ID, entrypoint_id: PLUGIN_ENTRYPOINT, workspace_id: workspaceId, tab_id: `${workspaceId}:t3`, pane_id: `${workspaceId}:p3`, terminal_id: "term_plugin-123" });
	process.exit(0);
}
if (argv[0] === "plugin" && argv[1] === "log" && argv[2] === "list") {
	json({ type: "plugin_log_list", plugin_id: PLUGIN_ID, entries: [] });
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
if (argv[0] === "tab" && argv[1] === "create") {
	const workspaceArg = argv[argv.indexOf("--workspace") + 1];
	const workspaceId = mode === "wrong-workspace-start" ? "w2" : (WORKSPACE_PATTERN.test(workspaceArg) ? workspaceArg : "w1");
	json({ result: { root_pane: { workspace_id: workspaceId, tab_id: `${workspaceId}:t2`, pane_id: `${workspaceId}:p2`, terminal_id: "term_abc-123" } } });
	process.exit(0);
}
if (argv[0] === "pane" && argv[1] === "process-info") {
	json({ result: { process_info: { shell_pid: 4242, foreground_process_group_id: 4242, foreground_processes: [{ pid: 4242, name: "zsh" }] } } });
	process.exit(0);
}
if (argv[0] === "pane" && argv[1] === "run") {
	json({ type: "ok" });
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
