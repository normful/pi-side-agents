import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { atomicWrite, ensureDir, readJsonFile } from "./fs.js";
import type { RegistryFile } from "./registry.js";
import {
	isPidAlive,
	parseOptionalPid,
} from "./slug.js";
import {
	gitRunOpts,
	nowIso,
	run,
	runOrThrow,
	stringifyError,
	tmuxWindowExists,
} from "./utils.js";
export async function writeWorktreeLock(
	worktreePath: string,
	payload: Record<string, unknown>,
): Promise<void> {
	const lockPath = join(worktreePath, ".pi", "active.lock");
	await ensureDir(dirname(lockPath));
	// biome-ignore lint/style/useTemplate: ignored using `--suppress`
	await atomicWrite(lockPath, JSON.stringify(payload, null, 2) + "\n");
}

export async function updateWorktreeLock(
	worktreePath: string,
	patch: Record<string, unknown>,
): Promise<void> {
	const lockPath = join(worktreePath, ".pi", "active.lock");
	const current = (await readJsonFile<Record<string, unknown>>(lockPath)) ?? {};
	await writeWorktreeLock(worktreePath, { ...current, ...patch });
}

export async function cleanupWorktreeLockBestEffort(
	worktreePath?: string,
): Promise<void> {
	if (!worktreePath) return;
	const lockPath = join(worktreePath, ".pi", "active.lock");
	await fs.unlink(lockPath).catch(() => {});
}

export function listRegisteredWorktrees(repoRoot: string): Set<string> {
	const result = runOrThrow("git", [
		"-C",
		repoRoot,
		"worktree",
		"list",
		"--porcelain",
	], gitRunOpts);
	const set = new Set<string>();
	for (const line of result.stdout.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) {
			set.add(resolve(line.slice("worktree ".length).trim()));
		}
	}
	return set;
}

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

export async function scanOrphanWorktreeLocks(
	repoRoot: string,
	registry: RegistryFile,
): Promise<OrphanWorktreeLockScan> {
	// Use git worktree list --porcelain to find all worktrees
	const result = runOrThrow(
		"git",
		["-C", repoRoot, "worktree", "list", "--porcelain"],
		gitRunOpts,
	);

	// Parse the output to find worktrees with side-agent/ branches
	const worktrees: Array<{ path: string; branch: string | null }> = [];
	let currentWorktree: { path: string; branch: string | null } | null = null;

	for (const line of result.stdout.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) {
			if (currentWorktree) {
				worktrees.push(currentWorktree);
			}
			currentWorktree = {
				path: line.slice("worktree ".length).trim(),
				branch: null,
			};
		} else if (line.startsWith("branch ")) {
			if (currentWorktree) {
				currentWorktree.branch = line.slice("branch ".length).trim();
			}
		}
	}
	if (currentWorktree) {
		worktrees.push(currentWorktree);
	}

	// Filter to side-agent/ worktrees
	const sideAgentWorktrees = worktrees.filter(
		(wt) => wt.branch && wt.branch.startsWith("refs/heads/side-agent/"),
	);

	const reclaimable: OrphanWorktreeLock[] = [];
	const blocked: OrphanWorktreeLock[] = [];

	for (const wt of sideAgentWorktrees) {
		const lockPath = join(wt.path, ".pi", "active.lock");
		if (!(await readJsonFile<Record<string, unknown>>(lockPath))) continue;

		const raw = (await readJsonFile<Record<string, unknown>>(lockPath)) ?? {};
		const lockAgentId =
			typeof raw["agentId"] === "string" ? raw["agentId"] : undefined;
		if (lockAgentId && registry.agents[lockAgentId]) {
			continue;
		}

		const lockPid = parseOptionalPid(raw["pid"]);
		const lockTmuxWindowId =
			typeof raw["tmuxWindowId"] === "string" ? raw["tmuxWindowId"] : undefined;

		const blockers: string[] = [];
		if (isPidAlive(lockPid)) {
			blockers.push(`pid ${lockPid} is still alive`);
		}
		if (lockTmuxWindowId && tmuxWindowExists(lockTmuxWindowId)) {
			blockers.push(`tmux window ${lockTmuxWindowId} is active`);
		}

		const candidate: OrphanWorktreeLock = {
			worktreePath: wt.path,
			lockPath,
			blockers,
			...(lockAgentId !== undefined && { lockAgentId }),
			...(lockPid !== undefined && { lockPid }),
			...(lockTmuxWindowId !== undefined && { lockTmuxWindowId }),
		};

		if (blockers.length > 0) {
			blocked.push(candidate);
		} else {
			reclaimable.push(candidate);
		}
	}

	return { reclaimable, blocked };
}

export async function reclaimOrphanWorktreeLocks(
	locks: OrphanWorktreeLock[],
): Promise<{
	removed: string[];
	failed: Array<{ lockPath: string; error: string }>;
}> {
	const removed: string[] = [];
	const failed: Array<{ lockPath: string; error: string }> = [];

	for (const lock of locks) {
		try {
			await fs.unlink(lock.lockPath);
			removed.push(lock.lockPath);
			// biome-ignore lint/suspicious/noExplicitAny: ignored using `--suppress`
		} catch (err: any) {
			if (err?.code === "ENOENT") continue;
			failed.push({ lockPath: lock.lockPath, error: stringifyError(err) });
		}
	}

	return { removed, failed };
}

export async function syncParallelAgentPiFiles(
	parentRepoRoot: string,
	worktreePath: string,
): Promise<void> {
	const parentPiDir = join(parentRepoRoot, ".pi");
	const { fileExists: exists } = await import("./fs.js");
	if (!(await exists(parentPiDir))) return;

	const sourceEntries = await fs.readdir(parentPiDir, { withFileTypes: true });
	const names = sourceEntries
		.filter((entry) => entry.name.startsWith("side-agent-"))
		.map((entry) => entry.name);
	if (names.length === 0) return;

	const worktreePiDir = join(worktreePath, ".pi");
	await ensureDir(worktreePiDir);

	for (const name of names) {
		const source = join(parentPiDir, name);
		const target = join(worktreePiDir, name);

		let shouldLink = true;
		try {
			const st = await fs.lstat(target);
			if (st.isSymbolicLink()) {
				const existing = await fs.readlink(target);
				if (resolve(dirname(target), existing) === resolve(source)) {
					shouldLink = false;
				}
			}
			if (shouldLink) {
				await fs.rm(target, { recursive: true, force: true });
			}
		} catch {
			// missing target
		}

		if (shouldLink) {
			await fs.symlink(source, target);
		}
	}
}

export async function allocateWorktree(options: {
	repoRoot: string;
	stateRoot: string;
	agentId: string;
	parentSessionId?: string;
}): Promise<{
	worktreePath: string;
	slotIndex: number;
	branch: string;
	warnings: string[];
}> {
	const { repoRoot, agentId, parentSessionId } = options;

	const warnings: string[] = [];
	const branch = `side-agent/${agentId}`;
	const mainHead = runOrThrow("git", [
		"-C",
		repoRoot,
		"rev-parse",
		"HEAD",
	], gitRunOpts).stdout.trim();

	// Use mkdtemp to create a fresh worktree directory in tmp
	// Format: <tmpdir>/pi-side-agent-worktrees/<repoBasename>-<4-digit-index>
	// We don't need to scan for existing slots anymore — mkdtemp always creates fresh dirs
	const repoBasename = repoRoot.split("/").pop() ?? "repo";
	const worktreeParentDirName = "pi-side-agent-worktrees";
	const worktreeParentDir = join(tmpdir(), worktreeParentDirName);
	await fs.mkdir(worktreeParentDir, { recursive: true });
	const worktreePath = await fs.mkdtemp(
		join(worktreeParentDir, `${repoBasename}-`),
	);

	const chosenPath = worktreePath;
	const registered = listRegisteredWorktrees(repoRoot);
	const isRegistered = registered.has(resolve(chosenPath));

	if (isRegistered) {
		// Remember old branch so we can try to clean it up after switching away.
		const oldBranchResult = run("git", [
			"-C",
			chosenPath,
			"branch",
			"--show-current",
		], gitRunOpts);
		const oldBranch = oldBranchResult.ok ? oldBranchResult.stdout.trim() : "";

		run("git", ["-C", chosenPath, "merge", "--abort"], gitRunOpts);
		runOrThrow(
			"git",
			["-C", chosenPath, "reset", "--hard", mainHead],
			gitRunOpts,
		);
		runOrThrow("git", ["-C", chosenPath, "clean", "-fd"], gitRunOpts);
		runOrThrow(
			"git",
			["-C", chosenPath, "checkout", "-B", branch, mainHead],
			gitRunOpts,
		);

		// Best-effort cleanup: delete old branch if fully merged (-d, not -D).
		if (oldBranch && oldBranch !== branch) {
			run("git", ["-C", repoRoot, "branch", "-d", oldBranch], gitRunOpts);
		}
	} else {
		runOrThrow("git", [
			"-C",
			repoRoot,
			"worktree",
			"add",
			"-B",
			branch,
			chosenPath,
			mainHead,
		], gitRunOpts);
	}

	await ensureDir(join(chosenPath, ".pi"));
	await syncParallelAgentPiFiles(repoRoot, chosenPath);
	await writeWorktreeLock(chosenPath, {
		agentId,
		sessionId: parentSessionId,
		parentSessionId,
		pid: process.pid,
		branch,
		startedAt: nowIso(),
	});

	return {
		worktreePath: chosenPath,
		slotIndex: 0,
		branch,
		warnings,
	};
}
