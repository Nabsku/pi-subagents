import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createHerdrSubagentLifecycle,
	HERDR_SUBAGENT_EVENT,
	type HerdrSubagentEvent,
} from "../../src/runs/shared/herdr-subagent-events.ts";

function harness() {
	const events: HerdrSubagentEvent[] = [];
	return {
		events,
		bus: {
			on: () => () => {},
			emit(channel: string, payload: unknown) {
				assert.equal(channel, HERDR_SUBAGENT_EVENT);
				events.push(payload as HerdrSubagentEvent);
			},
		},
	};
}

const terminal = {
	backend: "herdr" as const,
	workspaceId: "workspace-1",
	tabId: "tab-1",
	paneId: "pane-1",
	terminalId: "terminal-1",
	ownsWorkspace: false,
	ownsTab: true,
	ownsPane: true,
};

describe("native Herdr subagent lifecycle contract", () => {
	it("emits ordered exact events only after terminal publication and suppresses duplicates", () => {
		const { bus, events } = harness();
		let now = 100;
		const lifecycle = createHerdrSubagentLifecycle({ events: bus, enabled: true, runId: "run-1", childIndex: 0, agent: "worker", now: () => ++now })!;
		lifecycle.state("running");
		assert.deepEqual(events, []);
		lifecycle.registered(terminal);
		lifecycle.registered(terminal);
		lifecycle.state("running");
		lifecycle.state("running");
		lifecycle.state("completed");
		lifecycle.released();
		lifecycle.released();
		lifecycle.state("failed");
		assert.deepEqual(events.map(({ kind, state, sequence }) => ({ kind, state, sequence })), [
			{ kind: "registered", state: "starting", sequence: 1 },
			{ kind: "state", state: "running", sequence: 2 },
			{ kind: "state", state: "completed", sequence: 3 },
			{ kind: "released", state: "completed", sequence: 4 },
		]);
		for (const event of events) {
			assert.deepEqual(Object.keys(event).sort(), ["agent", "childIndex", "generation", "kind", "runId", "sequence", "state", "terminal", "timestamp", "version"]);
			assert.deepEqual(event.terminal, { workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" });
			assert.equal(event.version, 1);
			assert.equal(event.childIndex, 0);
			assert.equal(event.generation, 1);
		}
	});

	it("keeps sequence monotonic across replacement generations", () => {
		const { bus, events } = harness();
		const first = createHerdrSubagentLifecycle({ events: bus, enabled: true, runId: "retry", childIndex: 2, agent: "a" })!;
		first.registered(terminal);
		first.state("failed");
		first.released();
		const replacement = createHerdrSubagentLifecycle({ events: bus, enabled: true, runId: "retry", childIndex: 2, agent: "a" })!;
		replacement.registered(terminal);
		replacement.state("running");
		replacement.state("stopped");
		replacement.released();
		assert.deepEqual(events.map((event) => [event.generation, event.sequence]), [[1, 1], [1, 2], [1, 3], [2, 4], [2, 5], [2, 6], [2, 7]]);
	});

	it("never observes prompts, outputs, paths, secrets, argv, env, tokens, or capabilities", () => {
		const { bus, events } = harness();
		const secret = "TOP_SECRET_PROMPT_OUTPUT_TOKEN";
		const lifecycle = createHerdrSubagentLifecycle({ events: bus, enabled: true, runId: "safe", childIndex: 1, agent: "worker" })!;
		lifecycle.registered({ ...terminal, terminalId: `terminal-${secret.length}` });
		lifecycle.state("failed");
		lifecycle.released();
		const serialized = JSON.stringify(events);
		assert.equal(serialized.includes(secret), false);
		for (const forbidden of ["prompt", "output", "path", "argv", "environment", "token", "capabilit"]) assert.equal(serialized.toLowerCase().includes(forbidden), false);
	});

	it("emits nothing for headless/default or absent event buses and validates bounds", () => {
		const { bus, events } = harness();
		assert.equal(createHerdrSubagentLifecycle({ events: bus, enabled: false, runId: "headless", childIndex: 0, agent: "a" }), undefined);
		assert.equal(createHerdrSubagentLifecycle({ enabled: true, runId: "no-bus", childIndex: 0, agent: "a" }), undefined);
		assert.deepEqual(events, []);
		assert.throws(() => createHerdrSubagentLifecycle({ events: bus, enabled: true, runId: "bad", childIndex: -1, agent: "a" }), /zero-based safe integer/);
	});
});
