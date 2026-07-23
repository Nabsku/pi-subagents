const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;

function safeText(value, maxBytes = MAX_TEXT_BYTES) {
	if (typeof value !== "string") return "";
	const stripped = value
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?|[@-_])/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
	const bytes = Buffer.from(stripped, "utf8");
	if (bytes.length <= maxBytes) return stripped;
	return `${bytes.subarray(0, maxBytes).toString("utf8")}\n… output truncated …`;
}

function textParts(content) {
	if (!Array.isArray(content)) return [];
	return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => safeText(part.text));
}

function safeToolName(value) {
	if (typeof value !== "string") return "tool";
	const safe = safeText(value, 80).replace(/\s+/g, " ").trim();
	return safe || "tool";
}

export function createPiSessionDisplay(output = process.stdout, options = {}) {
	let buffered = "";
	let started = false;
	let taskShown = false;
	const write = (text) => output.write(text);
	const banner = () => {
		if (started) return;
		started = true;
		const label = safeText(options.label ?? "", 128).replace(/\s+/g, " ").trim();
		const cwd = safeText(options.cwd ?? "", 4096).replace(/[\r\n]/g, "");
		write(`${BOLD}${CYAN}π subagent${RESET}${label ? ` ${DIM}· ${label}${RESET}` : ""}\n${DIM}${cwd}${RESET}\n\n`);
	};
	const render = (event) => {
		if (!event || typeof event !== "object") return;
		banner();
		switch (event.type) {
			case "agent_start":
				write(`${CYAN}●${RESET} Working\n`);
				break;
			case "tool_execution_start":
				write(`\n${YELLOW}› ${safeToolName(event.toolName)}${RESET}\n`);
				break;
			case "tool_execution_end":
				write(`${GREEN}✓${RESET} ${safeToolName(event.toolName)}\n`);
				break;
			case "message_end":
				if (event.message?.role === "user" && !taskShown) {
					taskShown = true;
					const task = textParts(event.message.content).join("\n").trim();
					if (task) write(`${BOLD}Task${RESET}\n${safeText(task, 4096)}\n\n`);
				}
				if (event.message?.role === "assistant") for (const text of textParts(event.message.content)) write(`\n${text.trim()}\n`);
				break;
			case "tool_result_end":
				if (event.message?.isError) {
					const error = textParts(event.message.content).join("\n");
					write(`${RED}✗ ${safeToolName(event.message.toolName)}${RESET}${error ? `\n${error.trim()}\n` : "\n"}`);
				}
				break;
			case "agent_end":
				write(`\n${event.willRetry ? `${YELLOW}↻ Retrying${RESET}` : `${GREEN}● Done${RESET}`}\n`);
				break;
			case "agent_settled":
				write(`${DIM}Session settled${RESET}\n`);
				break;
		}
	};
	return {
		write(chunk) {
			buffered += chunk.toString("utf8");
			if (Buffer.byteLength(buffered) > MAX_BUFFER_BYTES && !buffered.includes("\n")) {
				buffered = "";
				banner();
				write(`${YELLOW}… oversized event discarded …${RESET}\n`);
				return;
			}
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline < 0) break;
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (!line.startsWith("{")) continue;
				try { render(JSON.parse(line)); } catch {}
			}
		},
		end() { if (!started) banner(); buffered = ""; },
	};
}
