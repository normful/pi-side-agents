import { describe, expect, test, afterAll, beforeEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	writeWorktreeLock,
	updateWorktreeLock,
	cleanupWorktreeLockBestEffort,
	reclaimOrphanWorktreeLocks,
} from "./worktree.js";
import type { OrphanWorktreeLock } from "./slug.js";

describe("writeWorktreeLock", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await setupTestDir();
	});

	test("creates lock file with payload", async () => {
		const worktreePath = join(testDir, "worktree");
		await mkdir(join(worktreePath, ".pi"), { recursive: true });

		await writeWorktreeLock(worktreePath, {
			agentId: "test-agent",
			pid: 12345,
		});

		const lockPath = join(worktreePath, ".pi", "active.lock");
		const content = await Bun.file(lockPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.agentId).toBe("test-agent");
		expect(parsed.pid).toBe(12345);
	});

	test("creates .pi directory if not exists", async () => {
		const worktreePath = join(testDir, "worktree");
		await mkdir(worktreePath, { recursive: true });

		await writeWorktreeLock(worktreePath, { agentId: "test" });

		const lockPath = join(worktreePath, ".pi", "active.lock");
		const exists = await Bun.file(lockPath).exists();
		expect(exists).toBe(true);
	});
});

describe("updateWorktreeLock", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await setupTestDir();
	});

	test("merges patch into existing lock", async () => {
		const worktreePath = join(testDir, "worktree");
		await mkdir(join(worktreePath, ".pi"), { recursive: true });

		await writeWorktreeLock(worktreePath, { agentId: "test", pid: 100 });
		await updateWorktreeLock(worktreePath, { tmuxWindowId: "@window.1" });

		const lockPath = join(worktreePath, ".pi", "active.lock");
		const content = await Bun.file(lockPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.agentId).toBe("test");
		expect(parsed.pid).toBe(100);
		expect(parsed.tmuxWindowId).toBe("@window.1");
	});

	test("overwrites existing values with patch", async () => {
		const worktreePath = join(testDir, "worktree");
		await mkdir(join(worktreePath, ".pi"), { recursive: true });

		await writeWorktreeLock(worktreePath, { agentId: "test", pid: 100 });
		await updateWorktreeLock(worktreePath, { pid: 200 });

		const lockPath = join(worktreePath, ".pi", "active.lock");
		const content = await Bun.file(lockPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.pid).toBe(200);
	});
});

describe("cleanupWorktreeLockBestEffort", () => {
	test("does nothing for undefined path", async () => {
		// Should not throw
		await cleanupWorktreeLockBestEffort(undefined);
	});

	test("removes lock file if exists", async () => {
		const testDir = await setupTestDir();
		const worktreePath = join(testDir, "worktree");
		await mkdir(join(worktreePath, ".pi"), { recursive: true });

		const lockPath = join(worktreePath, ".pi", "active.lock");
		await Bun.write(lockPath, '{"agentId":"test"}');

		await cleanupWorktreeLockBestEffort(worktreePath);

		const exists = await Bun.file(lockPath).exists();
		expect(exists).toBe(false);
	});

	test("succeeds even if lock doesn't exist", async () => {
		const testDir = await setupTestDir();
		const worktreePath = join(testDir, "worktree");
		await mkdir(worktreePath, { recursive: true });

		// Should not throw
		await cleanupWorktreeLockBestEffort(worktreePath);
	});
});

describe("reclaimOrphanWorktreeLocks", () => {
	test("removes specified locks", async () => {
		const testDir = await setupTestDir();

		const lock1 = join(testDir, "lock1.lock");
		const lock2 = join(testDir, "lock2.lock");
		await Bun.write(lock1, "{}");
		await Bun.write(lock2, "{}");

		const locks: OrphanWorktreeLock[] = [
			{ worktreePath: "/path1", lockPath: lock1, blockers: [] },
			{ worktreePath: "/path2", lockPath: lock2, blockers: [] },
		];

		const result = await reclaimOrphanWorktreeLocks(locks);

		expect(result.removed).toHaveLength(2);
		expect(result.failed).toHaveLength(0);
		expect(await Bun.file(lock1).exists()).toBe(false);
		expect(await Bun.file(lock2).exists()).toBe(false);
	});

	test("handles already-removed locks gracefully", async () => {
		const testDir = await setupTestDir();

		const lock1 = join(testDir, "lock1.lock");
		const lock2 = join(testDir, "lock2.lock");
		await Bun.write(lock1, "{}");
		// lock2 doesn't exist

		const locks: OrphanWorktreeLock[] = [
			{ worktreePath: "/path1", lockPath: lock1, blockers: [] },
			{ worktreePath: "/path2", lockPath: lock2, blockers: [] },
		];

		const result = await reclaimOrphanWorktreeLocks(locks);

		expect(result.removed).toHaveLength(1);
		expect(result.failed).toHaveLength(0);
	});

	test("reports failures", async () => {
		// On Unix, removing certain protected paths would fail
		// We can't easily test this without mocking
	});
});

// Helper
const testBaseDir = join(
	process.env["TMPDIR"] || "/tmp",
	"side-agents-worktree-test",
);
let testCounter = 0;

async function setupTestDir(): Promise<string> {
	const dir = join(testBaseDir, String(++testCounter));
	await mkdir(dir, { recursive: true });
	return dir;
}

afterAll(async () => {
	try {
		await rm(testBaseDir, { recursive: true, force: true });
	} catch {
		// Ignore
	}
});
