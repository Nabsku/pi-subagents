interface PostExitStdioGuardOptions {
	idleMs: number;
	hardMs: number;
}

interface DestroyableReadableStdio {
	on(event: "data", listener: (...args: any[]) => void): this;
	on(event: "end", listener: () => void): this;
	destroy(error?: Error): void;
}

interface ChildWithPipedStdio {
	stdout?: DestroyableReadableStdio | null;
	stderr?: DestroyableReadableStdio | null;
	on(event: "exit" | "close" | "error", listener: (...args: any[]) => void): unknown;
}

interface ChildWithKill {
	kill(signal?: NodeJS.Signals | number): boolean;
}

export function trySignalChild(child: ChildWithKill, signal: NodeJS.Signals): boolean {
	try {
		return child.kill(signal);
	} catch {
		return false;
	}
}

export function attachPostExitStdioGuard(
	child: ChildWithPipedStdio,
	options: PostExitStdioGuardOptions,
): () => void {
	const { idleMs, hardMs } = options;
	let exited = false;
	let stdoutEnded = false;
	let stderrEnded = false;
	let idleTimer: NodeJS.Timeout | undefined;
	let hardTimer: NodeJS.Timeout | undefined;

	const destroyUnendedStdio = () => {
		if (!stdoutEnded) {
			try { child.stdout?.destroy(); } catch {}
		}
		if (!stderrEnded) {
			try { child.stderr?.destroy(); } catch {}
		}
	};

	const clearTimers = () => {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
		if (hardTimer) {
			clearTimeout(hardTimer);
			hardTimer = undefined;
		}
	};

	const armIdleTimer = () => {
		if (!exited) return;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(destroyUnendedStdio, idleMs);
		idleTimer.unref?.();
	};

	child.stdout?.on("data", armIdleTimer);
	child.stderr?.on("data", armIdleTimer);
	child.stdout?.on("end", () => {
		stdoutEnded = true;
		if (stdoutEnded && stderrEnded) clearTimers();
	});
	child.stderr?.on("end", () => {
		stderrEnded = true;
		if (stdoutEnded && stderrEnded) clearTimers();
	});
	child.on("exit", () => {
		exited = true;
		armIdleTimer();
		if (hardTimer) return;
		hardTimer = setTimeout(destroyUnendedStdio, hardMs);
		hardTimer.unref?.();
	});
	child.on("close", clearTimers);
	child.on("error", clearTimers);

	return clearTimers;
}
