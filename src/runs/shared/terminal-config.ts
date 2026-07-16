import type { ResolvedTerminalConfig, TerminalConfig } from "../../shared/types.ts";

export const DEFAULT_TERMINAL_CONFIG: ResolvedTerminalConfig = {
	backend: "headless",
	placement: "tab",
	splitDirection: "right",
	focus: false,
	closeOnExit: false,
	fallback: "error",
};

const TERMINAL_CONFIG_KEYS = ["backend", "placement", "splitDirection", "focus", "closeOnExit", "fallback"] as const;

function invalidTerminalConfig(message: string): Error {
	return new Error(`Invalid subagent terminal config: ${message}`);
}

function readStringOption<T extends string>(
	config: Record<string, unknown>,
	key: string,
	allowed: readonly T[],
	defaultValue: T,
): T {
	const value = config[key];
	if (value === undefined) return defaultValue;
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw invalidTerminalConfig(`terminal.${key} must be ${allowed.map((item) => `"${item}"`).join(" or ")}`);
	}
	return value as T;
}

function readBooleanOption(
	config: Record<string, unknown>,
	key: string,
	defaultValue: boolean,
): boolean {
	const value = config[key];
	if (value === undefined) return defaultValue;
	if (typeof value !== "boolean") {
		throw invalidTerminalConfig(`terminal.${key} must be a boolean`);
	}
	return value;
}

function rejectUnsupportedKeys(config: Record<string, unknown>): void {
	const supportedKeys = new Set<string>(TERMINAL_CONFIG_KEYS);
	for (const key of Object.keys(config)) {
		if (!supportedKeys.has(key)) {
			throw invalidTerminalConfig(
				`terminal.${key} is not supported; expected one of ${TERMINAL_CONFIG_KEYS.map((item) => `"${item}"`).join(", ")}`,
			);
		}
	}
}

export function resolveTerminalConfig(config: TerminalConfig | undefined): ResolvedTerminalConfig {
	if (config === undefined) return { ...DEFAULT_TERMINAL_CONFIG };
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw invalidTerminalConfig("terminal must be a JSON object");
	}
	const raw = config as Record<string, unknown>;
	rejectUnsupportedKeys(raw);
	return {
		backend: readStringOption(raw, "backend", ["headless", "herdr"] as const, DEFAULT_TERMINAL_CONFIG.backend),
		placement: readStringOption(raw, "placement", ["tab", "pane"] as const, DEFAULT_TERMINAL_CONFIG.placement),
		splitDirection: readStringOption(raw, "splitDirection", ["right", "down"] as const, DEFAULT_TERMINAL_CONFIG.splitDirection),
		focus: readBooleanOption(raw, "focus", DEFAULT_TERMINAL_CONFIG.focus),
		closeOnExit: readBooleanOption(raw, "closeOnExit", DEFAULT_TERMINAL_CONFIG.closeOnExit),
		fallback: readStringOption(raw, "fallback", ["error", "headless"] as const, DEFAULT_TERMINAL_CONFIG.fallback),
	};
}
