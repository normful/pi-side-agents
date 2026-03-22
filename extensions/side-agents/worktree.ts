import { promises as fs } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { readJsonFile, atomicWrite, ensureDir } from "./fs.js";
import {
	run,
	runOrThrow,
	nowIso,
	stringifyError,
	tmuxWindowExists,
} from "./utils.js";
import {
	listWorktreeSlots,
	parseOptionalPid,
	isPidAlive,
	type WorktreeSlot,
	type OrphanWorktreeLock,
	type OrphanWorktreeLockScan,
} from "./slug.js";
import type { RegistryFile } from "./registry.js";

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
	]);
	const set = new Set<string>();
	for (const line of result.stdout.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) {
			set.add(resolve(line.slice("worktree ".length).trim()));
		}
	}
	return set;
}

export async function scanOrphanWorktreeLocks(
	repoRoot: string,
	registry: RegistryFile,
): Promise<OrphanWorktreeLockScan> {
	const slots = await listWorktreeSlots(repoRoot);
	const reclaimable: OrphanWorktreeLock[] = [];
	const blocked: OrphanWorktreeLock[] = [];

	for (const slot of slots) {
		const lockPath = join(slot.path, ".pi", "active.lock");
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
			worktreePath: slot.path,
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
	const { repoRoot, stateRoot, agentId, parentSessionId } = options;

	const warnings: string[] = [];
	const branch = `side-agent/${agentId}`;
	const mainHead = runOrThrow("git", [
		"-C",
		repoRoot,
		"rev-parse",
		"HEAD",
	]).stdout.trim();

	const registry = await (async () => {
		const { loadRegistry } = await import("./registry.js");
		return loadRegistry(stateRoot);
	})();
	const slots = await listWorktreeSlots(repoRoot);
	const registered = listRegisteredWorktrees(repoRoot);

	let chosen: WorktreeSlot | undefined;
	let maxIndex = 0;

	for (const slot of slots) {
		maxIndex = Math.max(maxIndex, slot.index);
		const lockPath = join(slot.path, ".pi", "active.lock");

		const lockExists = await (async () => {
			const { fileExists: fe } = await import("./fs.js");
			return fe(lockPath);
		})();

		if (lockExists) {
			const lock = await readJsonFile<Record<string, unknown>>(lockPath);
			const lockAgentId =
				typeof lock?.["agentId"] === "string" ? lock?.["agentId"] : undefined;
			if (!lockAgentId || !registry.agents[lockAgentId]) {
				warnings.push(
					`Locked worktree is not tracked in registry: ${slot.path}`,
				);
			}
			continue;
		}

		const isRegistered = registered.has(resolve(slot.path));
		if (isRegistered) {
			const status = run("git", ["-C", slot.path, "status", "--porcelain"]);
			if (!status.ok) {
				warnings.push(
					`Could not inspect unlocked worktree, skipping: ${slot.path}`,
				);
				continue;
			}
			if (status.stdout.trim().length > 0) {
				warnings.push(
					`Unlocked worktree has local changes, skipping: ${slot.path}`,
				);
				continue;
			}
		} else {
			const entries = await fs.readdir(slot.path).catch(() => []);
			if (entries.length > 0) {
				warnings.push(
					`Unlocked slot is not a registered worktree and not empty, skipping: ${slot.path}`,
				);
				continue;
			}
		}

		chosen = slot;
		break;
	}

	if (!chosen) {
		const next = maxIndex + 1 || 1;
		const parent = dirname(repoRoot);
		const name = `${basename(repoRoot)}-agent-worktree-${String(next).padStart(4, "0")}`;
		chosen = { index: next, path: join(parent, name) };
	}

	const chosenPath = chosen.path;
	const chosenRegistered = registered.has(resolve(chosenPath));

	if (chosenRegistered) {
		// Remember old branch so we can try to clean it up after switching away.
		const oldBranchResult = run("git", [
			"-C",
			chosenPath,
			"branch",
			"--show-current",
		]);
		const oldBranch = oldBranchResult.ok ? oldBranchResult.stdout.trim() : "";

		run("git", ["-C", chosenPath, "merge", "--abort"]);
		runOrThrow("git", ["-C", chosenPath, "reset", "--hard", mainHead]);
		runOrThrow("git", ["-C", chosenPath, "clean", "-fd"]);
		runOrThrow("git", ["-C", chosenPath, "checkout", "-B", branch, mainHead]);

		// Best-effort cleanup: delete old branch if fully merged (-d, not -D).
		if (oldBranch && oldBranch !== branch) {
			run("git", ["-C", repoRoot, "branch", "-d", oldBranch]);
		}
	} else {
		const { fileExists: exists } = await import("./fs.js");
		if (await exists(chosenPath)) {
			const entries = await fs.readdir(chosenPath).catch(() => []);
			if (entries.length > 0) {
				throw new Error(
					`Cannot use worktree slot ${chosenPath}: directory exists and is not empty`,
				);
			}
		}
		await ensureDir(dirname(chosenPath));
		runOrThrow("git", [
			"-C",
			repoRoot,
			"worktree",
			"add",
			"-B",
			branch,
			chosenPath,
			mainHead,
		]);
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
		slotIndex: chosen.index,
		branch,
		warnings,
	};
}
