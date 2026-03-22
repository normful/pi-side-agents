import { describe, expect, test } from "bun:test";
import {
	normalizeAgentId,
	parseAgentCommandArgs,
	splitModelPatternAndThinking,
	statusColorRole,
	statusShort,
} from "./agent.js";

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
