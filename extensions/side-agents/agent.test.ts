import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	modeSpecToModelSpec,
	normalizeAgentId,
	parseAgentCommandArgs,
	splitModelPatternAndThinking,
	statusColorRole,
	statusShort,
} from "./agent.js";
import { getMetaDir } from "./registry.js";

describe("statusShort", () => {
	test("returns abbreviated status", () => {
		expect(statusShort("allocating_worktree")).toBe("alloc");
		expect(statusShort("spawning_tmux")).toBe("tmux");
		expect(statusShort("running")).toBe("run");
		expect(statusShort("waiting_user")).toBe("wait");
		expect(statusShort("done")).toBe("done");
		expect(statusShort("failed")).toBe("fail");
		expect(statusShort("crashed")).toBe("crash");
	});
});

describe("statusColorRole", () => {
	test("allocating_worktree and spawning_tmux are warnings", () => {
		expect(statusColorRole("allocating_worktree")).toBe("warning");
		expect(statusColorRole("spawning_tmux")).toBe("warning");
	});

	test("running and done are muted", () => {
		expect(statusColorRole("running")).toBe("muted");
		expect(statusColorRole("done")).toBe("muted");
	});

	test("waiting_user is accent", () => {
		expect(statusColorRole("waiting_user")).toBe("accent");
	});

	test("failed and crashed are errors", () => {
		expect(statusColorRole("failed")).toBe("error");
		expect(statusColorRole("crashed")).toBe("error");
	});
});

describe("parseAgentCommandArgs", () => {
	test("extracts task without model", () => {
		const result = parseAgentCommandArgs("fix the auth bug");
		expect(result.task).toBe("fix the auth bug");
		expect(result.model).toBeUndefined();
	});

	test("extracts model with -model flag", () => {
		const result = parseAgentCommandArgs(
			"-model anthropic/claude-3 fix the bug",
		);
		expect(result.task).toBe("fix the bug");
		expect(result.model).toBe("anthropic/claude-3");
	});

	test("handles model at start of args", () => {
		const result = parseAgentCommandArgs(
			"-model openai/gpt-4o task description",
		);
		expect(result.task).toBe("task description");
		expect(result.model).toBe("openai/gpt-4o");
	});

	test("handles multiple -model flags (uses first)", () => {
		const result = parseAgentCommandArgs(
			"-model first/model -model second/model task",
		);
		expect(result.model).toBe("first/model");
	});

	test("handles empty string", () => {
		const result = parseAgentCommandArgs("");
		expect(result.task).toBe("");
		expect(result.model).toBeUndefined();
	});
});

describe("splitModelPatternAndThinking", () => {
	test("returns pattern as-is without thinking", () => {
		const result = splitModelPatternAndThinking("anthropic/claude-3");
		expect(result.pattern).toBe("anthropic/claude-3");
		expect(result.thinking).toBeUndefined();
	});

	test("extracts thinking level", () => {
		const result = splitModelPatternAndThinking("anthropic/claude-3:medium");
		expect(result.pattern).toBe("anthropic/claude-3");
		expect(result.thinking).toBe("medium");
	});

	test("handles valid thinking levels", () => {
		const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
		for (const level of levels) {
			const result = splitModelPatternAndThinking(`model:${level}`);
			expect(result.pattern).toBe("model");
			expect(result.thinking).toBe(level);
		}
	});

	test("returns pattern as-is for invalid thinking suffix", () => {
		const result = splitModelPatternAndThinking("model:invalid");
		expect(result.pattern).toBe("model:invalid");
		expect(result.thinking).toBeUndefined();
	});

	test("handles colon at start", () => {
		const result = splitModelPatternAndThinking(":medium");
		expect(result.pattern).toBe(":medium");
	});

	test("handles colon at end", () => {
		const result = splitModelPatternAndThinking("model:");
		expect(result.pattern).toBe("model:");
	});
});

describe("normalizeAgentId", () => {
	test("extracts first token", () => {
		expect(normalizeAgentId("agent-123 task description")).toBe("agent-123");
	});

	test("handles whitespace", () => {
		expect(normalizeAgentId("  agent-123  ")).toBe("agent-123");
	});

	test("returns empty string for empty input", () => {
		expect(normalizeAgentId("")).toBe("");
		expect(normalizeAgentId("   ")).toBe("");
	});

	test("handles multiple spaces between tokens", () => {
		expect(normalizeAgentId("agent   other")).toBe("agent");
	});
});

// ============================================================================
// Commit 46536da: refreshAllAgents no-op tests
// ============================================================================

describe("refreshAllAgents no-op", () => {
	let testDir: string;

	async function setupTestDir(): Promise<string> {
		const dir = join(
			tmpdir(),
			`agent-refresh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(dir, { recursive: true });
		return dir;
	}

	afterAll(async () => {
		if (testDir) {
			await rm(testDir, { recursive: true, force: true });
		}
	});

	test("refreshAllAgents returns empty registry when meta dir missing", async () => {
		const { refreshAllAgents } = await import("./agent.js");
		testDir = await setupTestDir();
		const stateRoot = testDir;

		// Meta dir does NOT exist
		const metaDir = getMetaDir(stateRoot);
		const exists = await Bun.file(metaDir).exists();
		expect(exists).toBe(false);

		// Call refreshAllAgents - should return empty registry without throwing
		const result = await refreshAllAgents(stateRoot);
		expect(result.version).toBe(1);
		expect(Object.keys(result.agents)).toHaveLength(0);
	});

	test("refreshAllAgents does not create meta dir", async () => {
		const { refreshAllAgents } = await import("./agent.js");
		testDir = await setupTestDir();
		const stateRoot = testDir;

		const metaDir = getMetaDir(stateRoot);

		// Ensure meta dir does NOT exist
		await rm(metaDir, { recursive: true, force: true });

		// Call refreshAllAgents
		await refreshAllAgents(stateRoot);

		// Meta dir should still NOT exist
		const exists = await Bun.file(metaDir).exists();
		expect(exists).toBe(false);
	});
});

// ============================================================================
// Commit 4329c26: modes.json inheritance tests
// ============================================================================

describe("readModesFile", () => {
	let testDir: string;

	async function setupTestDir(): Promise<string> {
		const dir = join(
			tmpdir(),
			`modes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(dir, { recursive: true });
		return dir;
	}

	afterAll(async () => {
		if (testDir) {
			await rm(testDir, { recursive: true, force: true });
		}
	});

	test("readModesFile returns project-level modes.json", async () => {
		const { readModesFile } = await import("./agent.js");
		testDir = await setupTestDir();

		// Create project-level .pi/modes.json
		const projectPiDir = join(testDir, ".pi");
		await mkdir(projectPiDir, { recursive: true });
		await writeFile(
			join(projectPiDir, "modes.json"),
			JSON.stringify({
				currentMode: "test",
				modes: {
					test: { provider: "anthropic", modelId: "claude-3" },
				},
			}),
		);

		const result = await readModesFile(testDir);
		expect(result).toBeDefined();
		expect(result?.path).toContain(".pi/modes.json");
		expect(result?.parsed.modes).toBeDefined();
		expect(result?.parsed.modes?.test.provider).toBe("anthropic");
	});

	test("readModesFile falls back to global modes.json", async () => {
		const { readModesFile } = await import("./agent.js");
		// Use a completely separate directory for this test
		const fallbackTestDir = join(
			tmpdir(),
			`modes-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(fallbackTestDir, { recursive: true });

		// PI_CODING_AGENT_DIR IS the agent directory (e.g., ~/.pi/agent)
		// So modes.json should be at <PI_CODING_AGENT_DIR>/modes.json
		const globalAgentDir = join(
			tmpdir(),
			"pi-agent-global",
			Date.now().toString(),
		);
		await mkdir(globalAgentDir, { recursive: true });
		await writeFile(
			join(globalAgentDir, "modes.json"),
			JSON.stringify({
				currentMode: "global",
				modes: {
					global: { provider: "openai", modelId: "gpt-4" },
				},
			}),
		);

		// Set the env var to point to the agent directory
		const original = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = globalAgentDir;

		try {
			// No project file exists, should fall back to global
			const result = await readModesFile(fallbackTestDir);
			expect(result).toBeDefined();
			expect(result?.path).toContain("modes.json");
			expect(result?.parsed.modes?.global.provider).toBe("openai");
		} finally {
			if (original !== undefined) {
				process.env.PI_CODING_AGENT_DIR = original;
			} else {
				delete process.env.PI_CODING_AGENT_DIR;
			}
			await rm(fallbackTestDir, { recursive: true, force: true });
			await rm(globalAgentDir, { recursive: true, force: true });
		}
	});

	test("readModesFile returns undefined for empty modes", async () => {
		const { readModesFile } = await import("./agent.js");
		testDir = await setupTestDir();

		// Create project-level .pi/modes.json with empty modes object
		const projectPiDir = join(testDir, ".pi");
		await mkdir(projectPiDir, { recursive: true });
		await writeFile(
			join(projectPiDir, "modes.json"),
			JSON.stringify({ modes: {} }),
		);

		const result = await readModesFile(testDir);
		expect(result).toBeUndefined();
	});

	test("readModesFile returns undefined when no files exist", async () => {
		const { readModesFile } = await import("./agent.js");
		testDir = await setupTestDir();

		// Clear the env var to ensure no fallback
		const original = process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;

		try {
			// No project file, no global file
			const result = await readModesFile(testDir);
			expect(result).toBeUndefined();
		} finally {
			if (original !== undefined) {
				process.env.PI_CODING_AGENT_DIR = original;
			}
		}
	});
});

describe("modeSpecToModelSpec", () => {
	test("modeSpecToModelSpec builds spec without thinkingLevel", () => {
		const result = modeSpecToModelSpec({
			provider: "anthropic",
			modelId: "claude-3",
		});
		expect(result).toBe("anthropic/claude-3");
	});

	test("modeSpecToModelSpec builds spec with thinkingLevel", () => {
		const result = modeSpecToModelSpec({
			provider: "anthropic",
			modelId: "claude-3",
			thinkingLevel: "high",
		});
		expect(result).toBe("anthropic/claude-3:high");
	});

	test("modeSpecToModelSpec returns undefined for missing fields", () => {
		// Missing provider
		expect(modeSpecToModelSpec({ modelId: "claude-3" })).toBeUndefined();
		// Missing modelId
		expect(modeSpecToModelSpec({ provider: "anthropic" })).toBeUndefined();
		// Both missing
		expect(modeSpecToModelSpec({})).toBeUndefined();
	});
});

describe("inferCurrentModeModelSpec", () => {
	let testDir: string;

	async function setupTestDir(): Promise<string> {
		const dir = join(
			tmpdir(),
			`infer-mode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(dir, { recursive: true });
		return dir;
	}

	afterAll(async () => {
		if (testDir) {
			await rm(testDir, { recursive: true, force: true });
		}
	});

	test("inferCurrentModeModelSpec returns undefined without ctx.model", async () => {
		const { inferCurrentModeModelSpec } = await import("./agent.js");
		testDir = await setupTestDir();

		const ctx = { model: null } as any;
		const result = await inferCurrentModeModelSpec(testDir, ctx, "medium");
		expect(result).toBeUndefined();
	});

	test("inferCurrentModeModelSpec returns undefined when no match", async () => {
		const { inferCurrentModeModelSpec } = await import("./agent.js");
		testDir = await setupTestDir();

		// Create modes.json that doesn't match the ctx.model
		const projectPiDir = join(testDir, ".pi");
		await mkdir(projectPiDir, { recursive: true });
		await writeFile(
			join(projectPiDir, "modes.json"),
			JSON.stringify({
				modes: {
					mode1: { provider: "anthropic", modelId: "claude-3" },
				},
			}),
		);

		// ctx.model doesn't match
		const ctx = {
			model: { provider: "openai", id: "gpt-4" },
		} as any;
		const result = await inferCurrentModeModelSpec(testDir, ctx, "medium");
		expect(result).toBeUndefined();
	});

	test("inferCurrentModeModelSpec returns mode spec when matched", async () => {
		const { inferCurrentModeModelSpec } = await import("./agent.js");
		testDir = await setupTestDir();

		// Create modes.json with matching mode
		const projectPiDir = join(testDir, ".pi");
		await mkdir(projectPiDir, { recursive: true });
		await writeFile(
			join(projectPiDir, "modes.json"),
			JSON.stringify({
				modes: {
					mode1: {
						provider: "anthropic",
						modelId: "claude-3-5-sonnet",
						thinkingLevel: "high",
					},
				},
			}),
		);

		// ctx.model matches
		const ctx = {
			model: { provider: "anthropic", id: "claude-3-5-sonnet" },
		} as any;
		const result = await inferCurrentModeModelSpec(testDir, ctx, "high");
		expect(result).toBe("anthropic/claude-3-5-sonnet:high");
	});

	test("inferCurrentModeModelSpec ignores mode with wrong thinkingLevel", async () => {
		const { inferCurrentModeModelSpec } = await import("./agent.js");
		testDir = await setupTestDir();

		// Create modes.json with different thinking level
		const projectPiDir = join(testDir, ".pi");
		await mkdir(projectPiDir, { recursive: true });
		await writeFile(
			join(projectPiDir, "modes.json"),
			JSON.stringify({
				modes: {
					mode1: {
						provider: "anthropic",
						modelId: "claude-3-5-sonnet",
						thinkingLevel: "low", // Different thinking level
					},
				},
			}),
		);

		// ctx.model matches provider/modelId but thinkingLevel differs
		const ctx = {
			model: { provider: "anthropic", id: "claude-3-5-sonnet" },
		} as any;
		const result = await inferCurrentModeModelSpec(testDir, ctx, "high");
		expect(result).toBeUndefined();
	});
});

describe("resolveModelSpecForChild", () => {
	test("resolveModelSpecForChild inherits mode when no model requested", async () => {
		const { resolveModelSpecForChild } = await import("./agent.js");

		// Mock ctx with modes.json support
		const testDir = join(
			tmpdir(),
			`resolve-model-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(testDir, { recursive: true });
		await mkdir(join(testDir, ".pi"), { recursive: true });
		await writeFile(
			join(testDir, ".pi", "modes.json"),
			JSON.stringify({
				modes: {
					mode1: {
						provider: "anthropic",
						modelId: "claude-3-5-sonnet",
						thinkingLevel: "high",
					},
				},
			}),
		);

		try {
			const ctx = {
				cwd: testDir,
				model: { provider: "anthropic", id: "claude-3-5-sonnet" },
				modelRegistry: { getAvailable: () => [] },
			} as any;

			// No model requested, thinkingLevel provided - should inherit from modes.json
			const result = await resolveModelSpecForChild(ctx, undefined, "high");
			expect(result.modelSpec).toBe("anthropic/claude-3-5-sonnet:high");
		} finally {
			await rm(testDir, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// Commit b4d717d: crash lock behavior tests
// ============================================================================

describe("refreshOneAgentRuntime crash lock behavior", () => {
	let testDir: string;

	async function setupTestDir(): Promise<string> {
		const dir = join(
			tmpdir(),
			`crash-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(dir, { recursive: true });
		return dir;
	}

	beforeEach(async () => {
		testDir = await setupTestDir();
	});

	afterEach(async () => {
		if (testDir) {
			await rm(testDir, { recursive: true, force: true });
		}
	});

	test("refreshOneAgentRuntime cleans lock for done agent", async () => {
		const { refreshOneAgentRuntime } = await import("./agent.js");
		const stateRoot = testDir;

		// Create a worktree with a lock
		const worktreePath = join(testDir, "worktree");
		await mkdir(join(worktreePath, ".pi"), { recursive: true });
		await writeFile(
			join(worktreePath, ".pi", "active.lock"),
			JSON.stringify({ agentId: "done-agent" }),
		);

		const record = {
			id: "done-agent",
			task: "test",
			status: "done" as const,
			worktreePath,
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		const result = await refreshOneAgentRuntime(stateRoot, record);

		// Should mark for removal
		expect(result.removeFromRegistry).toBe(true);

		// Lock should be cleaned
		const lockExists = await Bun.file(
			join(worktreePath, ".pi", "active.lock"),
		).exists();
		expect(lockExists).toBe(false);
	});

	test("refreshOneAgentRuntime cleans lock for successful exit", async () => {
		const { refreshOneAgentRuntime } = await import("./agent.js");
		const stateRoot = testDir;

		// Create a worktree with a lock
		const worktreePath = join(testDir, "worktree");
		await mkdir(join(worktreePath, ".pi"), { recursive: true });
		await writeFile(
			join(worktreePath, ".pi", "active.lock"),
			JSON.stringify({ agentId: "success-agent" }),
		);

		// Create exit marker with code 0
		const exitFile = join(testDir, "exit.json");
		await writeFile(
			exitFile,
			JSON.stringify({ exitCode: 0, finishedAt: new Date().toISOString() }),
		);

		const record = {
			id: "success-agent",
			task: "test",
			status: "running" as const,
			worktreePath,
			exitFile,
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		const result = await refreshOneAgentRuntime(stateRoot, record);

		// Should mark for removal
		expect(result.removeFromRegistry).toBe(true);

		// Lock should be cleaned
		const lockExists = await Bun.file(
			join(worktreePath, ".pi", "active.lock"),
		).exists();
		expect(lockExists).toBe(false);
	});

	test("refreshOneAgentRuntime cleans lock for failed exit", async () => {
		const { refreshOneAgentRuntime } = await import("./agent.js");
		const stateRoot = testDir;

		// Create a worktree with a lock
		const worktreePath = join(testDir, "worktree");
		await mkdir(join(worktreePath, ".pi"), { recursive: true });
		await writeFile(
			join(worktreePath, ".pi", "active.lock"),
			JSON.stringify({ agentId: "failed-agent" }),
		);

		// Create exit marker with non-zero code
		const exitFile = join(testDir, "exit.json");
		await writeFile(
			exitFile,
			JSON.stringify({ exitCode: 1, finishedAt: new Date().toISOString() }),
		);

		const record = {
			id: "failed-agent",
			task: "test",
			status: "running" as const,
			worktreePath,
			exitFile,
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		const result = await refreshOneAgentRuntime(stateRoot, record);

		// Should NOT mark for removal (agent failed but wasn't cleaned)
		expect(result.removeFromRegistry).toBe(false);

		// Lock should be cleaned
		const lockExists = await Bun.file(
			join(worktreePath, ".pi", "active.lock"),
		).exists();
		expect(lockExists).toBe(false);
	});

	test("refreshOneAgentRuntime does NOT clean lock for crashed agent", async () => {
		const { refreshOneAgentRuntime } = await import("./agent.js");
		const stateRoot = testDir;

		// Create a worktree with a lock
		const worktreePath = join(testDir, "worktree");
		await mkdir(join(worktreePath, ".pi"), { recursive: true });
		await writeFile(
			join(worktreePath, ".pi", "active.lock"),
			JSON.stringify({ agentId: "crashed-agent" }),
		);

		// Set a tmuxWindowId that doesn't exist (simulates crashed tmux window)
		// The key is: tmuxWindowId exists but tmuxWindowExists() returns false
		const record = {
			id: "crashed-agent",
			task: "test",
			status: "running" as const,
			worktreePath,
			tmuxWindowId: "@nonexistent-window-12345", // This window doesn't exist
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		const result = await refreshOneAgentRuntime(stateRoot, record);

		// Should NOT mark for removal
		expect(result.removeFromRegistry).toBe(false);

		// Lock should NOT be cleaned (this is the key behavior)
		const lockExists = await Bun.file(
			join(worktreePath, ".pi", "active.lock"),
		).exists();
		expect(lockExists).toBe(true);

		// Status should be set to crashed
		expect(record.status).toBe("crashed");
	});
});
