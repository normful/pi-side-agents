import type { ExtensionContext, SessionEntry, Message } from "@mariozechner/pi-coding-agent";
import { basename, dirname, join, resolve } from "node:path";
import { promises as fs } from "node:fs";
import { readJsonFile } from "./fs.js";
import { run, runOrThrow, stringifyError, tmuxWindowExists } from "./utils.js";
import type { CommandResult } from "./utils.js";
import type { AgentRecord, RegistryFile } from "./registry.js";

export type WorktreeSlot = {
	index: number;
	path: string;
};

export type OrphanWorktreeLock = {
	worktreePath: string;
	lockPath: string;
	lockAgentId?: string;
	lockPid?: number;
	lockTmuxWindowId?: string;
	blockers: string[];
};

export type OrphanWorktreeLockScan = {
	reclaimable: OrphanWorktreeLock[];
	blocked: OrphanWorktreeLock[];
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

/** Turn a task description into a slug by taking the first 3 meaningful words. */
export function slugFromTask(task: string): string {
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

	const listed = run("git", [
		"-C",
		repoRoot,
		"worktree",
		"list",
		"--porcelain",
	]);
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

export async function listWorktreeSlots(repoRoot: string): Promise<WorktreeSlot[]> {
	const parent = dirname(repoRoot);
	const prefix = `${basename(repoRoot)}-agent-worktree-`;
	const re = new RegExp(
		`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d{4})$`,
	);

	const entries = await fs.readdir(parent, { withFileTypes: true });
	const slots: WorktreeSlot[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const match = entry.name.match(re);
		if (!match) continue;
		const index = Number(match[1]);
		if (!Number.isFinite(index)) continue;
		slots.push({
			index,
			path: join(parent, entry.name),
		});
	}
	slots.sort((a, b) => a.index - b.index);
	return slots;
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
