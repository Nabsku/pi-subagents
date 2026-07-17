import type { HerdrRelayTerminalMetadata } from "./herdr-relay-protocol.ts";

export const HERDR_PLUGIN_CONTRACT_VERSION = 1;
export const HERDR_PLUGIN_ID = "pi-subagents.hybrid";
export const HERDR_PLUGIN_RELAY_ENTRYPOINT = "relay-runner";
export const HERDR_PLUGIN_ACTIONS = ["inspect", "stop", "retry"] as const;

export type HerdrPluginAction = typeof HERDR_PLUGIN_ACTIONS[number];

export interface HerdrCapabilityChannel {
	kind: "controller-local-one-shot";
	transport: "unix-socket" | "named-pipe";
	id: string;
}

export interface HerdrPluginInvocationContext {
	schema: "pi-herdr-plugin-context/v1";
	contractVersion: 1;
	pluginId: typeof HERDR_PLUGIN_ID;
	runId: string;
	childIndex: number;
	capabilityChannel: HerdrCapabilityChannel;
	terminal?: HerdrRelayTerminalMetadata;
}

export interface HerdrPluginLaunchRequest {
	schema: "pi-herdr-launch/v1";
	contractVersion: 1;
	runId: string;
	childIndex: number;
	cwd: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	label: string;
	capabilityChannel: HerdrCapabilityChannel;
	terminal?: HerdrRelayTerminalMetadata;
}

export interface HerdrPluginOperatorActionRequest {
	schema: "pi-herdr-operator-action/v1";
	contractVersion: 1;
	action: HerdrPluginAction;
	runId: string;
	terminal: HerdrRelayTerminalMetadata;
	reason: "operator" | "pane-exit" | "plugin-cleanup";
	correlationId: string;
}

export interface HerdrPluginOperatorActionResult {
	schema: "pi-herdr-operator-action-result/v1";
	contractVersion: 1;
	action: HerdrPluginAction;
	runId: string;
	accepted: boolean;
	decision: "inspection" | "controller-stop-requested" | "controller-retry-requested" | "rejected";
	message?: string;
}

const WORKSPACE_ID = /^w[1-9][0-9]{0,8}$/;
const TAB_ID = /^w[1-9][0-9]{0,8}:t[1-9][0-9]{0,8}$/;
const PANE_ID = /^w[1-9][0-9]{0,8}:p[1-9][0-9]{0,8}$/;
const TERMINAL_ID = /^term_[A-Za-z0-9_-]{1,64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CAPABILITY_CHANNEL_ID = /^pi-subagents:capchan-[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const SECRET_ALIASES = ["capability", "secret", "token", "apikey", "password", "credential", "privatekey"];
const MAX_ARGS = 64;
const MAX_ARG_BYTES = 4096;
const MAX_ARGS_BYTES = 16 * 1024;
const MAX_ENV = 64;
const MAX_ENV_VALUE_BYTES = 4096;
const MAX_ENV_BYTES = 16 * 1024;
const MAX_LABEL_BYTES = 128;
const MAX_PATH_BYTES = 4096;
const MAX_CONTEXT_BYTES = 32 * 1024;

function contractError(message: string): never {
	throw new Error(`Invalid Herdr plugin contract: ${message}`);
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function hasControl(value: string): boolean {
	return CONTROL_CHAR.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	try {
		const proto = Object.getPrototypeOf(value);
		return proto === null || proto === Object.prototype;
	} catch {
		return false;
	}
}

function assertOwnDataProperties(value: Record<string, unknown>, label: string): void {
	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!("value" in descriptor)) contractError(`${label}.${key} must use own data properties`);
	}
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isPlainRecord(value)) contractError(`${label} must be a plain record`);
	assertOwnDataProperties(value, label);
	return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const keys = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!keys.has(key)) contractError(`${label}.${key} is not supported`);
	}
}

function normalizedKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretKey(key: string): boolean {
	const normalized = normalizedKey(key);
	return SECRET_ALIASES.some((alias) => normalized.includes(alias));
}

function isSecretValue(value: string): boolean {
	return SECRET_ALIASES.some((alias) => normalizedKey(value).includes(alias));
}

function rejectSecretFields(value: unknown, path = "payload"): void {
	if (typeof value === "string") {
		if (isSecretValue(value)) contractError(`${path} must not carry inline secrets`);
		return;
	}
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		const descriptors = Object.getOwnPropertyDescriptors(value);
		for (let index = 0; index < value.length; index += 1) {
			const descriptor = descriptors[String(index)];
			if (!descriptor || !("value" in descriptor)) contractError(`${path}[${index}] must use own data properties`);
			rejectSecretFields(descriptor.value, `${path}[${index}]`);
		}
		return;
	}
	const record = asRecord(value, path);
	for (const key of Object.keys(record)) {
		if (key !== "capabilityChannel" && isSecretKey(key)) contractError(`${path}.${key} must not carry inline secrets`);
		rejectSecretFields(record[key], `${path}.${key}`);
	}
}

function readString(record: Record<string, unknown>, key: string, label: string, pattern?: RegExp, maxBytes = 128): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0 || hasControl(value) || byteLength(value) > maxBytes || (pattern && !pattern.test(value))) contractError(`${label}.${key}`);
	return value;
}

function readAbsolutePath(record: Record<string, unknown>, key: string, label: string): string {
	const value = readString(record, key, label, undefined, MAX_PATH_BYTES);
	if (!value.startsWith("/")) contractError(`${label}.${key}`);
	return value;
}

function readInteger(record: Record<string, unknown>, key: string, label: string): number {
	const value = record[key];
	if (!Number.isSafeInteger(value) || (value as number) < 0) contractError(`${label}.${key}`);
	return value as number;
}

function validateTerminal(value: unknown): HerdrRelayTerminalMetadata {
	const terminal = asRecord(value, "terminal");
	rejectUnknownKeys(terminal, ["workspaceId", "tabId", "paneId", "terminalId"], "terminal");
	const workspaceId = readString(terminal, "workspaceId", "terminal", WORKSPACE_ID);
	const tabId = readString(terminal, "tabId", "terminal", TAB_ID);
	const paneId = readString(terminal, "paneId", "terminal", PANE_ID);
	if (!tabId.startsWith(`${workspaceId}:`) || !paneId.startsWith(`${workspaceId}:`)) contractError("terminal ancestry");
	const terminalId = terminal.terminalId === undefined ? undefined : readString(terminal, "terminalId", "terminal", TERMINAL_ID);
	return Object.freeze({ workspaceId, tabId, paneId, ...(terminalId ? { terminalId } : {}) });
}

export function validateHerdrCapabilityChannel(value: unknown): HerdrCapabilityChannel {
	const channel = asRecord(value, "capabilityChannel");
	rejectUnknownKeys(channel, ["kind", "transport", "id"], "capabilityChannel");
	if (channel.kind !== "controller-local-one-shot") contractError("capabilityChannel.kind");
	if (channel.transport !== "unix-socket" && channel.transport !== "named-pipe") contractError("capabilityChannel.transport");
	const id = readString(channel, "id", "capabilityChannel", CAPABILITY_CHANNEL_ID);
	return Object.freeze({ kind: "controller-local-one-shot", transport: channel.transport, id });
}

export function validateHerdrPluginInvocationContext(value: unknown): HerdrPluginInvocationContext {
	rejectSecretFields(value, "context");
	const context = asRecord(value, "context");
	rejectUnknownKeys(context, ["schema", "contractVersion", "pluginId", "runId", "childIndex", "capabilityChannel", "terminal"], "context");
	if (context.schema !== "pi-herdr-plugin-context/v1") contractError("context.schema");
	if (context.contractVersion !== HERDR_PLUGIN_CONTRACT_VERSION) contractError("context.contractVersion");
	if (context.pluginId !== HERDR_PLUGIN_ID) contractError("context.pluginId");
	const canonical = Object.freeze({
		schema: "pi-herdr-plugin-context/v1",
		contractVersion: HERDR_PLUGIN_CONTRACT_VERSION,
		pluginId: HERDR_PLUGIN_ID,
		runId: readString(context, "runId", "context", RUN_ID),
		childIndex: readInteger(context, "childIndex", "context"),
		capabilityChannel: validateHerdrCapabilityChannel(context.capabilityChannel),
		...(context.terminal === undefined ? {} : { terminal: validateTerminal(context.terminal) }),
	});
	if (byteLength(JSON.stringify(canonical)) > MAX_CONTEXT_BYTES) contractError("context size");
	return canonical;
}

export function validateHerdrPluginLaunchRequest(value: unknown): HerdrPluginLaunchRequest {
	rejectSecretFields(value, "launch");
	const request = asRecord(value, "launch");
	rejectUnknownKeys(request, ["schema", "contractVersion", "runId", "childIndex", "cwd", "command", "args", "env", "label", "capabilityChannel", "terminal"], "launch");
	if (request.schema !== "pi-herdr-launch/v1") contractError("launch.schema");
	if (request.contractVersion !== HERDR_PLUGIN_CONTRACT_VERSION) contractError("launch.contractVersion");
	if (!Array.isArray(request.args) || request.args.length > MAX_ARGS) contractError("launch.args");
	let argsBytes = 0;
	const args = request.args.map((arg, index) => {
		if (typeof arg !== "string" || hasControl(arg) || byteLength(arg) > MAX_ARG_BYTES) contractError(`launch.args[${index}]`);
		argsBytes += byteLength(arg);
		if (argsBytes > MAX_ARGS_BYTES) contractError("launch.args");
		return arg;
	});
	const envRecord = asRecord(request.env, "launch.env");
	const envEntries = Object.entries(envRecord);
	if (envEntries.length > MAX_ENV) contractError("launch.env");
	const env: Record<string, string> = {};
	let envBytes = 0;
	for (const [key, value] of envEntries) {
		if (isSecretKey(key)) contractError(`launch.env.${key} must not carry inline secrets`);
		if (typeof value !== "string" || hasControl(key) || hasControl(value) || !ENV_KEY.test(key) || byteLength(value) > MAX_ENV_VALUE_BYTES) contractError(`launch.env.${key}`);
		envBytes += byteLength(key) + byteLength(value);
		if (envBytes > MAX_ENV_BYTES) contractError("launch.env");
		env[key] = value;
	}
	const canonical = Object.freeze({
		schema: "pi-herdr-launch/v1",
		contractVersion: HERDR_PLUGIN_CONTRACT_VERSION,
		runId: readString(request, "runId", "launch", RUN_ID),
		childIndex: readInteger(request, "childIndex", "launch"),
		cwd: readAbsolutePath(request, "cwd", "launch"),
		command: readAbsolutePath(request, "command", "launch"),
		args: Object.freeze(args) as string[],
		env: Object.freeze(env),
		label: readString(request, "label", "launch", undefined, MAX_LABEL_BYTES),
		capabilityChannel: validateHerdrCapabilityChannel(request.capabilityChannel),
		...(request.terminal === undefined ? {} : { terminal: validateTerminal(request.terminal) }),
	});
	if (byteLength(JSON.stringify(canonical)) > MAX_CONTEXT_BYTES) contractError("launch size");
	return canonical;
}

export function validateHerdrPluginOperatorActionRequest(value: unknown): HerdrPluginOperatorActionRequest {
	rejectSecretFields(value, "operatorAction");
	const request = asRecord(value, "operatorAction");
	rejectUnknownKeys(request, ["schema", "contractVersion", "action", "runId", "terminal", "reason", "correlationId"], "operatorAction");
	if (request.schema !== "pi-herdr-operator-action/v1") contractError("operatorAction.schema");
	if (request.contractVersion !== HERDR_PLUGIN_CONTRACT_VERSION) contractError("operatorAction.contractVersion");
	if (!HERDR_PLUGIN_ACTIONS.includes(request.action as HerdrPluginAction)) contractError("operatorAction.action");
	if (request.reason !== "operator" && request.reason !== "pane-exit" && request.reason !== "plugin-cleanup") contractError("operatorAction.reason");
	return Object.freeze({
		schema: "pi-herdr-operator-action/v1",
		contractVersion: HERDR_PLUGIN_CONTRACT_VERSION,
		action: request.action as HerdrPluginAction,
		runId: readString(request, "runId", "operatorAction", RUN_ID),
		terminal: validateTerminal(request.terminal),
		reason: request.reason as HerdrPluginOperatorActionRequest["reason"],
		correlationId: readString(request, "correlationId", "operatorAction", RUN_ID),
	});
}

export function resolveHerdrPluginOperatorAction(request: HerdrPluginOperatorActionRequest): HerdrPluginOperatorActionResult {
	const safe = validateHerdrPluginOperatorActionRequest(request);
	const decision = safe.action === "inspect" ? "inspection" : safe.action === "stop" ? "controller-stop-requested" : "controller-retry-requested";
	return Object.freeze({
		schema: "pi-herdr-operator-action-result/v1",
		contractVersion: HERDR_PLUGIN_CONTRACT_VERSION,
		action: safe.action,
		runId: safe.runId,
		accepted: true,
		decision,
	});
}

export function buildHerdrPluginActionInvokeArgv(action: HerdrPluginAction, pluginId = HERDR_PLUGIN_ID): string[] {
	if (!HERDR_PLUGIN_ACTIONS.includes(action)) contractError("action");
	if (pluginId !== HERDR_PLUGIN_ID) contractError("pluginId");
	return ["plugin", "action", "invoke", action, "--plugin", pluginId];
}

export function buildHerdrPluginPaneOpenArgv(input: { cwd: string; env?: Record<string, string>; workspaceId?: string; targetPaneId?: string; direction?: "right" | "down"; placement?: "overlay" | "popup" | "split" | "tab" | "zoomed"; pluginId?: string; entrypoint?: string }): string[] {
	const paneOpen = asRecord(input, "paneOpen");
	rejectUnknownKeys(paneOpen, ["cwd", "env", "workspaceId", "targetPaneId", "direction", "placement", "pluginId", "entrypoint"], "paneOpen");
	const pluginId = paneOpen.pluginId ?? HERDR_PLUGIN_ID;
	const entrypoint = paneOpen.entrypoint ?? HERDR_PLUGIN_RELAY_ENTRYPOINT;
	if (pluginId !== HERDR_PLUGIN_ID) contractError("pluginId");
	if (entrypoint !== HERDR_PLUGIN_RELAY_ENTRYPOINT) contractError("entrypoint");
	const placement = paneOpen.placement ?? "tab";
	if (!["overlay", "popup", "split", "tab", "zoomed"].includes(placement)) contractError("placement");
	const cwd = readAbsolutePath(paneOpen, "cwd", "paneOpen");
	const argv = ["plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", entrypoint, "--placement", placement, "--cwd", cwd];
	if (paneOpen.workspaceId !== undefined) argv.push("--workspace", readString(paneOpen, "workspaceId", "paneOpen", WORKSPACE_ID));
	if (paneOpen.targetPaneId !== undefined) argv.push("--target-pane", readString(paneOpen, "targetPaneId", "paneOpen", PANE_ID));
	if (paneOpen.direction !== undefined) {
		if (paneOpen.direction !== "right" && paneOpen.direction !== "down") contractError("direction");
		argv.push("--direction", paneOpen.direction);
	}
	let envBytes = 0;
	const entries = Object.entries(asRecord(paneOpen.env ?? {}, "paneOpen.env"));
	if (entries.length > MAX_ENV) contractError("paneOpen.env");
	for (const [key, value] of entries) {
		if (typeof value !== "string") contractError("paneOpen.env");
		if (isSecretKey(key) || isSecretValue(value)) contractError("paneOpen.env must not carry inline secrets");
		if (hasControl(key) || hasControl(value) || !ENV_KEY.test(key) || byteLength(key) > 64 || byteLength(value) > MAX_ENV_VALUE_BYTES) contractError("paneOpen.env");
		envBytes += byteLength(key) + byteLength(value);
		if (envBytes > MAX_ENV_BYTES) contractError("paneOpen.env");
		argv.push("--env", `${key}=${value}`);
	}
	if (argv.reduce((total, arg) => total + byteLength(arg), 0) > MAX_CONTEXT_BYTES) contractError("paneOpen.argv");
	return argv;
}
