#!/usr/bin/env node
import fs from "node:fs";

const optionsWithValues = new Set([
	"--append-system-prompt",
	"--extension",
	"--mode",
	"--model",
	"--session",
	"--session-dir",
	"--system-prompt",
	"--tools",
]);

const positional = [];
for (let index = 2; index < process.argv.length; index += 1) {
	const arg = process.argv[index];
	if (optionsWithValues.has(arg)) {
		index += 1;
		continue;
	}
	if (arg.startsWith("-")) continue;
	positional.push(arg);
}

const promptArg = positional[0];
if (!promptArg) throw new Error("fake Pi child received no prompt");
const prompt = promptArg.startsWith("@") ? fs.readFileSync(promptArg.slice(1), "utf8") : promptArg;
const event = {
	type: "message_end",
	message: { role: "user", content: [{ type: "text", text: prompt }] },
	argv: process.argv.slice(1),
};
process.stdout.write(`${JSON.stringify(event)}\n`);
await new Promise((resolve) => setTimeout(resolve, 1_500));