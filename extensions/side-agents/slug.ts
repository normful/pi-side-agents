import type { RegistryFile } from "./registry.js";
import { gitRunOpts, run } from "./utils.js";

export type OrphanWorktreeLock = {
	worktreePath: string;
	lockPath: string;
	lockAgentId?: string;
	lockPid?: number;
	lockTmuxWindowId?: string;
	blockers: string[];
};

/** Sanitize a raw string into a kebab-case slug suitable for branch names and agent IDs. */
export function sanitizeSlug(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.split("-")
		.filter(Boolean)
		.slice(0, 3)
		.join("-");
}

/**
 * Stop words are filtered out before slug extraction.
 * They are common grammatical words that don't help distinguish tasks.
 */
const STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"to",
	"in",
	"on",
	"at",
	"of",
	"for",
	"and",
	"or",
	"is",
	"it",
	"be",
	"do",
	"with",
	"by",
	"from",
	"as",
	"that",
	"this",
	"these",
	"those",
	"will",
	"can",
	"all",
	"any",
	"but",
	"not",
	"have",
	"has",
	"had",
	"use",
	"used",
	"using",
]);

/** Pull out the meaningful (non-stop) words from a task, preserving order. */
function meaningfulWords(task: string): string[] {
	return task
		.replace(/[^a-zA-Z0-9\s]/g, " ")
		.split(/\s+/)
		.map((w) => w.toLowerCase())
		.filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

/**
 * Extract a collision-free slug for a task by trying tail-first sliding windows.
 *
 * Strategy:
 *  1. Prefer 2-word tail windows (most specific — noun + modifier).
 *  2. Then 3-word tail windows (verb/object/modifier).
 *  3. Then 1-word tail windows.
 *  4. Finally 3-word head windows as a last resort.
 *  5. If every candidate collides, fall back to numeric deduplication.
 *
 * Within each size group, windows are ordered from tail-most to head-most,
 * so the most specific words always win first.
 *
 * Examples (empty existing):
 *   "write tests for login page"  → "login-page"     (2-word tail window)
 *   "write tests for signup page"  → "signup-page"    (2-word tail window)
 *   "implement dark mode"          → "dark-mode"      (2-word tail window)
 *   "fix auth bug"                 → "auth-bug"       (2-word tail window)
 *   "fix login bug"                → "login-bug"      (2-word tail window)
 *
 * Examples (with collisions):
 *   existing = { "login-page" }
 *   "write tests for login page"  → "login-page-2"   (collision → dedup)
 *   "write tests for signup"      → "signup"         (2-word tail, unique)
 *   "write tests for login"       → "login"          (1-word tail, unique)
 */
export function slugFromTask(task: string): string {
	return slugFromTaskWithExisting(task, new Set());
}

/**
 * Like slugFromTask but checks against a set of already-taken slugs to avoid
 * generating a colliding slug in the first place.
 */
export function slugFromTaskWithExisting(
	task: string,
	existing: Set<string>,
): string {
	const words = meaningfulWords(task);
	if (words.length === 0) return "agent";

	// Collect all windows grouped by size, then flatten in strict priority order:
	// all size-4 (tail→head), then all size-3 (tail→head), then all size-2 (tail→head).
	// Within each size group, iterate start tail→head so the most specific words
	// (those closest to the end of the task) appear first.
	const candidates: string[] = [];
	for (const size of [4, 3, 2, 1] as const) {
		if (size > words.length) continue;
		for (let start = words.length - size; start >= 0; start--) {
			const window = words.slice(start, start + size);
			candidates.push(window.join("-"));
		}
	}

	// Return the first candidate that doesn't collide.
	for (const candidate of candidates) {
		if (candidate.length > 0 && !existing.has(candidate)) {
			return candidate;
		}
	}

	// Everything collides. Use the best candidate + numeric dedup.
	const base = candidates[0] ?? "agent";
	return deduplicateSlug(base, existing);
}

/** Turn a task description into a slug by taking the first 3 meaningful words. */
export function slugFromTaskLegacy(task: string): string {
	const stopWords = new Set([
		"a",
		"an",
		"the",
		"to",
		"in",
		"on",
		"at",
		"of",
		"for",
		"and",
		"or",
		"is",
		"it",
		"be",
		"do",
		"with",
	]);
	const words = task
		.replace(/[^a-zA-Z0-9\s]/g, " ")
		.split(/\s+/)
		.map((w) => w.toLowerCase())
		.filter((w) => w.length > 0 && !stopWords.has(w));
	const slug = words.slice(0, 3).join("-");
	return slug || "agent";
}

// Note: generateSlug is async and uses ctx.model, so it's in agent.ts

/** Collect all agent IDs currently known in the registry or checked out as side-agent branches. */
export function existingAgentIds(
	registry: RegistryFile,
	repoRoot: string,
): Set<string> {
	const ids = new Set<string>(Object.keys(registry.agents));

	const listed = run(
		"git",
		["-C", repoRoot, "worktree", "list", "--porcelain"],
		gitRunOpts,
	);
	if (listed.ok) {
		for (const line of listed.stdout.split(/\r?\n/)) {
			if (!line.startsWith("branch ")) continue;
			const branchRef = line.slice("branch ".length).trim();
			if (!branchRef || branchRef === "(detached)") continue;
			const branch = branchRef.startsWith("refs/heads/")
				? branchRef.slice("refs/heads/".length)
				: branchRef;
			if (branch.startsWith("side-agent/")) {
				ids.add(branch.slice("side-agent/".length));
			}
		}
	}

	return ids;
}

/** Deduplicate a slug against existing IDs by appending -2, -3, etc. */
export function deduplicateSlug(slug: string, existing: Set<string>): string {
	if (!existing.has(slug)) return slug;
	for (let i = 2; ; i++) {
		const candidate = `${slug}-${i}`;
		if (!existing.has(candidate)) return candidate;
	}
}

export function parseOptionalPid(value: unknown): number | undefined {
	if (
		typeof value === "number" &&
		Number.isFinite(value) &&
		Number.isInteger(value) &&
		value > 0
	) {
		return value;
	}
	if (typeof value === "string" && /^\d+$/.test(value)) {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

export function isPidAlive(pid?: number): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
		// biome-ignore lint/suspicious/noExplicitAny: ignored using `--suppress`
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}

export function summarizeOrphanLock(lock: OrphanWorktreeLock): string {
	const details: string[] = [];
	if (lock.lockAgentId) details.push(`agent:${lock.lockAgentId}`);
	if (lock.lockTmuxWindowId) details.push(`tmux:${lock.lockTmuxWindowId}`);
	if (lock.lockPid !== undefined) details.push(`pid:${lock.lockPid}`);
	if (details.length === 0) return lock.worktreePath;
	return `${lock.worktreePath} (${details.join(" ")})`;
}
