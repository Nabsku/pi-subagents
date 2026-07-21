#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { createPiSessionDisplay } from "./herdr-relay-display.mjs";

const [socketPath, nonce, retention, ...launchArgs] = process.argv.slice(2);
let envFile;
if (launchArgs[0] === "--env-file") envFile = launchArgs.splice(0, 2)[1];
const [command, ...args] = launchArgs;
if (!socketPath || !nonce || !["close", "retain"].includes(retention) || !command) process.exit(64);
let childEnv = process.env;
if (envFile) {
	try {
		const parsed = JSON.parse(fs.readFileSync(envFile, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) process.exit(65);
		childEnv = { ...process.env, ...parsed };
	} finally {
		try { fs.unlinkSync(envFile); } catch {}
	}
}

const MAGIC = Buffer.from("HRLY");
const TYPES = { handshake: 1, stdout: 2, stderr: 3, exit: 4, error: 5 };
const MAX_RETENTION_MS = 60 * 60 * 1_000;
const configuredRetentionMs = Number(process.env.PI_HERDR_RETENTION_MS ?? MAX_RETENTION_MS);
const retentionMs = Number.isSafeInteger(configuredRetentionMs) && configuredRetentionMs > 0
	? Math.min(configuredRetentionMs, MAX_RETENTION_MS)
	: MAX_RETENTION_MS;
let seq = 1;
let transportOpen = true;
let settled = false;
let paneHostTimer;
let terminationRequested = false;

const socket = net.createConnection(socketPath);
await new Promise((resolve, reject) => {
	socket.once("connect", resolve);
	socket.once("error", reject);
});

const child = spawn(command, args, { cwd: process.cwd(), env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
const send = (type, metadata = {}, payload) => {
	if (!transportOpen) return;
	const currentSeq = seq++;
	const body = payload ?? Buffer.from(JSON.stringify({ version: 1, type, seq: currentSeq, pid: child.pid, nonce, ...metadata }));
	const header = Buffer.alloc(20);
	MAGIC.copy(header, 0);
	header[4] = 1;
	header[5] = TYPES[type];
	header.writeUInt32BE(body.length, 8);
	header.writeBigUInt64BE(BigInt(currentSeq), 12);
	socket.write(Buffer.concat([header, body]));
};
socket.on("error", () => { transportOpen = false; });
socket.on("close", () => { transportOpen = false; });
send("handshake", { pgid: child.pid, terminal: { workspaceId: "local", tabId: "local:tab", paneId: "local:pane" } });
const display = createPiSessionDisplay(process.stdout, { label: childEnv.PI_SUBAGENT_AGENT ?? "child", cwd: process.cwd() });
child.stdout.on("data", (chunk) => {
	display.write(chunk);
	send("stdout", {}, Buffer.from(chunk));
});
child.stderr.on("data", (chunk) => {
	process.stderr.write(chunk);
	send("stderr", {}, Buffer.from(chunk));
});

const enterRetainedPaneHost = () => {
	// Herdr 0.7.4 pane readability is process-lifetime-bound. This local-only,
	// production-disabled MVP retains only pane stdio and one bounded timer after
	// relay EOF; it owns no child, socket, listener, or temporary path.
	if (retention !== "retain" || terminationRequested) return;
	paneHostTimer = setTimeout(() => {
		process.stdout.write("[pi-subagents] retained pane expired after 1 hour\n");
	}, retentionMs);
};
const releaseRelay = () => {
	transportOpen = false;
	child.stdout.removeAllListeners();
	child.stderr.removeAllListeners();
	socket.removeAllListeners();
	socket.destroy();
	enterRetainedPaneHost();
};
const onChildError = (error) => {
	if (settled) return;
	settled = true;
	process.stderr.write(`${error.message}\n`);
	send("error", { message: "child launch failed" });
	socket.end();
};
const onChildClose = (code, signal) => {
	if (settled) return;
	settled = true;
	display.end();
	send("exit", { code, signal });
	process.stdout.write(`\n\x1b[2mChild exited (${signal ?? code ?? "unknown"}) · pane retained\x1b[0m\n`);
	socket.end(releaseRelay);
};
child.once("error", onChildError);
child.once("close", onChildClose);

const terminate = (signal) => {
	terminationRequested = true;
	if (paneHostTimer) {
		clearTimeout(paneHostTimer);
		process.exit(0);
	}
	child.kill(signal);
};
process.on("SIGINT", () => terminate("SIGINT"));
process.on("SIGTERM", () => terminate("SIGTERM"));