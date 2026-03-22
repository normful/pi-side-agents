import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	emptyRegistry,
	loadRegistry,
	saveRegistry,
	mutateRegistry,
	isTerminalStatus,
	setRecordStatus,
	getStateRoot,
	getMetaDir,
	getRegistryPath,
	getRuntimeDir,
	getRuntimeArchiveBaseDir,
	runtimeArchiveStamp,
	prepareFreshRuntimeDir,
	isChildRuntime,
	type AgentStatus,
} from "./registry.js";
import { fileExists } from "./fs.js";

describe("emptyRegistry", () => {
	test("creates valid registry with version 1", () => {
		const registry = emptyRegistry();
		expect(registry.version).toBe(1);
		expect(registry.agents).toEqual({});
	});
});

describe("loadRegistry", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await setupTestDir();
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test("returns empty registry for non-existing path", async () => {
		const registry = await loadRegistry(testDir);
		expect(registry.version).toBe(1);
		expect(registry.agents).toEqual({});
	});

	test("loads valid registry file", async () => {
		const stateRoot = testDir;
		const registry = emptyRegistry();
		registry.agents["test-agent"] = {
			id: "test-agent",
			task: "test task",
			status: "running",
			startedAt: "2024-01-01T00:00:00.000Z",
			updatedAt: "2024-01-01T00:00:00.000Z",
		};
		await saveRegistry(stateRoot, registry);

		const loaded = await loadRegistry(stateRoot);
		expect(loaded.version).toBe(1);
		expect(Object.keys(loaded.agents)).toEqual(["test-agent"]);
		expect(loaded.agents["test-agent"].task).toBe("test task");
	});
});

describe("saveRegistry", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await setupTestDir();
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test("saves registry to file", async () => {
		const registry = emptyRegistry();
		await saveRegistry(testDir, registry);

		const registryPath = getRegistryPath(testDir);
		const content = await Bun.file(registryPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.version).toBe(1);
	});
});

describe("mutateRegistry", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await setupTestDir();
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test("mutates and returns updated registry", async () => {
		const result = await mutateRegistry(testDir, (registry) => {
			registry.agents["mutated"] = {
				id: "mutated",
				task: "mutated task",
				status: "running",
				startedAt: "2024-01-01T00:00:00.000Z",
				updatedAt: "2024-01-01T00:00:00.000Z",
			};
		});

		expect(Object.keys(result.agents)).toContain("mutated");
	});

	test("does not save if no changes", async () => {
		await mutateRegistry(testDir, () => {});
		const registryPath = getRegistryPath(testDir);
		const exists = await Bun.file(registryPath).exists();
		expect(exists).toBe(false);
	});

	test("saves when changes are made", async () => {
		await mutateRegistry(testDir, (registry) => {
			registry.agents["changed"] = {
				id: "changed",
				task: "task",
				status: "running",
				startedAt: "2024-01-01T00:00:00.000Z",
				updatedAt: "2024-01-01T00:00:00.000Z",
			};
		});
		const registryPath = getRegistryPath(testDir);
		const exists = await Bun.file(registryPath).exists();
		expect(exists).toBe(true);
	});
});

describe("isTerminalStatus", () => {
	test("returns true for terminal statuses", () => {
		expect(isTerminalStatus("done")).toBe(true);
		expect(isTerminalStatus("failed")).toBe(true);
		expect(isTerminalStatus("crashed")).toBe(true);
	});

	test("returns false for non-terminal statuses", () => {
		expect(isTerminalStatus("running")).toBe(false);
		expect(isTerminalStatus("waiting_user")).toBe(false);
		expect(isTerminalStatus("allocating_worktree")).toBe(false);
		expect(isTerminalStatus("spawning_tmux")).toBe(false);
	});
});

describe("setRecordStatus", () => {
	test("updates status and timestamp", async () => {
		const record = {
			id: "test",
			task: "test",
			status: "running" as AgentStatus,
			startedAt: "2024-01-01T00:00:00.000Z",
			updatedAt: "2024-01-01T00:00:00.000Z",
		};
		const testDir = await setupTestDir();
		await rm(testDir, { recursive: true, force: true });

		const changed = await setRecordStatus(testDir, record, "done");
		expect(changed).toBe(true);
		expect(record.status).toBe("done");
		expect(record.updatedAt).not.toBe("2024-01-01T00:00:00.000Z");
	});

	test("returns false if status unchanged", async () => {
		const record = {
			id: "test",
			task: "test",
			status: "running" as AgentStatus,
			startedAt: "2024-01-01T00:00:00.000Z",
			updatedAt: "2024-01-01T00:00:00.000Z",
		};
		const testDir = await setupTestDir();
		await rm(testDir, { recursive: true, force: true });

		const changed = await setRecordStatus(testDir, record, "running");
		expect(changed).toBe(false);
	});
});

describe("getStateRoot", () => {
	test("uses PI_SIDE_AGENTS_ROOT env var if set", () => {
		const original = process.env.PI_SIDE_AGENTS_ROOT;
		process.env.PI_SIDE_AGENTS_ROOT = "/custom/path";
		try {
			const stateRoot = getStateRoot({ cwd: "/somewhere/else" });
			expect(stateRoot).toBe("/custom/path");
		} finally {
			if (original) {
				process.env.PI_SIDE_AGENTS_ROOT = original;
			} else {
				delete process.env.PI_SIDE_AGENTS_ROOT;
			}
		}
	});
});

describe("path helpers", () => {
	test("getMetaDir returns .pi/side-agents subdir", () => {
		expect(getMetaDir("/repo")).toBe("/repo/.pi/side-agents");
	});

	test("getRegistryPath returns registry.json path", () => {
		expect(getRegistryPath("/repo")).toBe(
			"/repo/.pi/side-agents/registry.json",
		);
	});

	test("getRuntimeDir returns runtime directory path", () => {
		expect(getRuntimeDir("/repo", "agent-1")).toBe(
			"/repo/.pi/side-agents/runtime/agent-1",
		);
	});

	test("getRuntimeArchiveBaseDir returns archive base path", () => {
		expect(getRuntimeArchiveBaseDir("/repo", "agent-1")).toBe(
			"/repo/.pi/side-agents/runtime-archive/agent-1",
		);
	});

	test("runtimeArchiveStamp returns valid timestamp", () => {
		const stamp = runtimeArchiveStamp();
		expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
	});
});

describe("prepareFreshRuntimeDir", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await setupTestDir();
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test("creates runtime directory if not exists", async () => {
		const result = await prepareFreshRuntimeDir(testDir, "new-agent");
		expect(result.runtimeDir).toContain("new-agent");
		const exists = await fileExists(result.runtimeDir);
		expect(exists).toBe(true);
	});

	test("archives existing runtime directory", async () => {
		// First create runtime dir
		await prepareFreshRuntimeDir(testDir, "archive-test");

		// Create a marker file
		const runtimeDir = getRuntimeDir(testDir, "archive-test");
		await Bun.write(join(runtimeDir, "marker.txt"), "test");

		// Call again - should archive
		const result = await prepareFreshRuntimeDir(testDir, "archive-test");
		expect(result.archivedRuntimeDir).toBeDefined();
		expect(result.runtimeDir).toBe(runtimeDir);

		// Original marker should be gone
		const markerExists = await fileExists(join(runtimeDir, "marker.txt"));
		expect(markerExists).toBe(false);
	});
});

describe("isChildRuntime", () => {
	test("returns false when PI_SIDE_AGENT_ID not set", () => {
		const original = process.env.PI_SIDE_AGENT_ID;
		delete process.env.PI_SIDE_AGENT_ID;
		try {
			expect(isChildRuntime()).toBe(false);
		} finally {
			if (original) process.env.PI_SIDE_AGENT_ID = original;
		}
	});

	test("returns true when PI_SIDE_AGENT_ID is set", () => {
		const original = process.env.PI_SIDE_AGENT_ID;
		process.env.PI_SIDE_AGENT_ID = "test-agent";
		try {
			expect(isChildRuntime()).toBe(true);
		} finally {
			if (original) {
				process.env.PI_SIDE_AGENT_ID = original;
			} else {
				delete process.env.PI_SIDE_AGENT_ID;
			}
		}
	});
});

// Helper
const testBaseDir = join(
	process.env.TMPDIR || "/tmp",
	"side-agents-registry-test",
);
let testCounter = 0;

async function setupTestDir(): Promise<string> {
	const dir = join(testBaseDir, String(++testCounter));
	await mkdir(dir, { recursive: true });
	return dir;
}
