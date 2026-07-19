import type { IntercomEventBus } from "../../shared/types.ts";
import type { TerminalHandle } from "./process-backend.ts";

export const HERDR_SUBAGENT_EVENT = "herdr:subagent";
export const HERDR_SUBAGENT_EVENT_VERSION = 1 as const;

export type HerdrSubagentState = "starting" | "running" | "completed" | "failed" | "stopped";
export type HerdrSubagentEventKind = "registered" | "state" | "released";

export interface HerdrSubagentTerminalIdentity {
	workspaceId: string;
	tabId: string;
	paneId: string;
	terminalId?: string;
}

export interface HerdrSubagentEvent {
	version: typeof HERDR_SUBAGENT_EVENT_VERSION;
	kind: HerdrSubagentEventKind;
	runId: string;
	childIndex: number;
	generation: number;
	sequence: number;
	timestamp: number;
	agent: string;
	state: HerdrSubagentState;
	terminal?: HerdrSubagentTerminalIdentity;
}

interface ChildLedger {
	generation: number;
	sequence: number;
	state?: HerdrSubagentState;
	released: boolean;
}

const ledgersByBus = new WeakMap<IntercomEventBus, Map<string, ChildLedger>>();

function bounded(value: string, max: number, label: string): string {
	const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
	if (!clean) throw new Error(`${label} must not be empty`);
	return clean.slice(0, max);
}

function terminalIdentity(handle: TerminalHandle): HerdrSubagentTerminalIdentity {
	return {
		workspaceId: bounded(handle.workspaceId, 256, "terminal.workspaceId"),
		tabId: bounded(handle.tabId, 256, "terminal.tabId"),
		paneId: bounded(handle.paneId, 256, "terminal.paneId"),
		...(handle.terminalId ? { terminalId: bounded(handle.terminalId, 256, "terminal.terminalId") } : {}),
	};
}

export interface HerdrSubagentLifecycle {
	registered(terminal: TerminalHandle): void;
	state(state: HerdrSubagentState): void;
	released(): void;
}

export function createHerdrSubagentLifecycle(input: {
	events?: IntercomEventBus;
	enabled: boolean;
	runId: string;
	childIndex: number;
	agent: string;
	now?: () => number;
}): HerdrSubagentLifecycle | undefined {
	if (!input.enabled || !input.events) return undefined;
	if (!Number.isSafeInteger(input.childIndex) || input.childIndex < 0 || input.childIndex > 1_000_000) {
		throw new Error("childIndex must be a zero-based safe integer no greater than 1000000");
	}
	const runId = bounded(input.runId, 256, "runId");
	const agent = bounded(input.agent, 128, "agent");
	const key = `${runId}\u0000${input.childIndex}`;
	let ledgers = ledgersByBus.get(input.events);
	if (!ledgers) {
		ledgers = new Map();
		ledgersByBus.set(input.events, ledgers);
	}
	const previous = ledgers.get(key);
	const ledger: ChildLedger = {
		generation: (previous?.generation ?? 0) + 1,
		sequence: previous?.sequence ?? 0,
		released: false,
	};
	ledgers.set(key, ledger);
	const now = input.now ?? Date.now;
	let terminal: HerdrSubagentTerminalIdentity | undefined;
	let registered = false;
	const emit = (kind: HerdrSubagentEventKind, state: HerdrSubagentState, includeTerminal: boolean): void => {
		ledger.sequence += 1;
		input.events!.emit(HERDR_SUBAGENT_EVENT, {
			version: HERDR_SUBAGENT_EVENT_VERSION,
			kind,
			runId,
			childIndex: input.childIndex,
			generation: ledger.generation,
			sequence: ledger.sequence,
			timestamp: now(),
			agent,
			state,
			...(includeTerminal && terminal ? { terminal } : {}),
		} satisfies HerdrSubagentEvent);
	};
	return {
		registered(handle) {
			if (registered || ledger.released) return;
			terminal = terminalIdentity(handle);
			registered = true;
			ledger.state = "starting";
			emit("registered", "starting", true);
		},
		state(state) {
			if (!registered || ledger.released || ledger.state === state) return;
			ledger.state = state;
			emit("state", state, true);
		},
		released() {
			if (!registered || ledger.released) return;
			ledger.released = true;
			emit("released", ledger.state ?? "failed", true);
		},
	};
}
