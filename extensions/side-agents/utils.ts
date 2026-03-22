import { spawnSync } from "node:child_process";

export type CommandResult = {
	ok: boolean;
	status: number | null;
	stdout: string;
	stderr: string;
	error?: string;
};

// Constants that could be imported by other modules
export const ALL_AGENT_STATUSES = [
	"allocating_worktree",
	"spawning_tmux",
	"running",
	"waiting_user",
	"done",
	"failed",
	"crashed",
] as const;

export const DEFAULT_WAIT_STATES = [
	"waiting_user",
	"failed",
	"crashed",
] as const;

export function nowIso(): string {
	return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolveNow) => setTimeout(resolveNow, ms));
}

export function stringifyError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function truncateWithEllipsis(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	if (maxChars === 1) return "…";
	return `${text.slice(0, maxChars - 1)}…`;
}

// ANSI escape sequence patterns
// biome-ignore lint/suspicious/noControlCharactersInRegex: ignored using `--suppress`
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ignored using `--suppress`
const ANSI_OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ignored using `--suppress`
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripTerminalNoise(text: string): string {
	return text
		.replace(ANSI_CSI_RE, "")
		.replace(ANSI_OSC_RE, "")
		.replace(/\r/g, "")
		.replace(CONTROL_RE, "");
}

export function isBacklogSeparatorLine(line: string): boolean {
	// Matches 5 or more consecutive separator characters
	return /^[-─—_=]{5,}$/u.test(line.trim());
}

export function splitLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.filter((line, i, arr) => !(i === arr.length - 1 && line.length === 0));
}

export function tailLines(text: string, count: number): string[] {
	return splitLines(text).slice(-count);
}

export function normalizeWaitStates(input?: string[]): {
	values: (typeof ALL_AGENT_STATUSES)[number][];
	error?: string;
} {
	if (!input || input.length === 0) {
		return { values: [...DEFAULT_WAIT_STATES] };
	}

	const trimmed = [
		...new Set(input.map((value) => value.trim()).filter(Boolean)),
	];
	if (trimmed.length === 0) {
		return { values: [...DEFAULT_WAIT_STATES] };
	}

	const known = new Set(ALL_AGENT_STATUSES);
	const invalid = trimmed.filter(
		(value) => !known.has(value as (typeof ALL_AGENT_STATUSES)[number]),
	);
	if (invalid.length > 0) {
		return {
			values: [],
			error: `Unknown status value(s): ${invalid.join(", ")}`,
		};
	}

	return {
		values: trimmed as (typeof ALL_AGENT_STATUSES)[number][],
	};
}

export function run(
	command: string,
	args: string[],
	options?: { cwd?: string; input?: string },
): CommandResult {
	const result = spawnSync(command, args, {
		cwd: options?.cwd,
		input: options?.input,
		encoding: "utf8",
	});

	if (result.error) {
		return {
			ok: false,
			status: result.status,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			error: result.error.message,
		};
	}

	return {
		ok: result.status === 0,
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

export function runOrThrow(
	command: string,
	args: string[],
	options?: { cwd?: string; input?: string },
): CommandResult {
	const result = run(command, args, options);
	if (!result.ok) {
		const reason = result.error
			? `error=${result.error}`
			: `exit=${result.status}`;
		throw new Error(
			`Command failed: ${command} ${args.join(" ")} (${reason})\n${result.stderr || result.stdout}`.trim(),
		);
	}
	return result;
}

/**
 * Check if a tmux window exists by querying it.
 * Lives in utils.ts to break the worktree → tmux → worktree circular dependency.
 */
export function tmuxWindowExists(windowId: string): boolean {
	const result = run("tmux", [
		"display-message",
		"-p",
		"-t",
		windowId,
		"#{window_id}",
	]);
	return result.ok && result.stdout.trim() === windowId;
}

/**
 * Shortcut for JSON.stringify(value, null, 2).
 */
export function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
