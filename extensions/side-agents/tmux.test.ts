import { describe, expect, test } from "bun:test";
import { buildLaunchScript } from "./tmux.js";

describe("buildLaunchScript", () => {
	test("generates valid bash script", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentSessionId: "parent-session-123",
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test-agent",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/test-agent/kickoff.md",
			exitFile: "/repo/.pi/runtime/test-agent/exit.json",
			modelSpec: "anthropic/claude-3-5-sonnet",
			runtimeDir: "/repo/.pi/runtime/test-agent",
		});

		// Should start with shebang
		expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);

		// Should export environment variables
		expect(script).toContain("export ${_ENV_AGENT_ID}=");

		// Should set WORKTREE
		expect(script).toContain("WORKTREE=");

		// Should include pi command with model
		expect(script).toContain("PI_CMD=(pi)");
		expect(script).toContain("PI_CMD+=(--model");

		// Should have write_exit function
		expect(script).toContain("write_exit()");

		// Should have exit handling
		expect(script).toContain('write_exit "$exit_code"');
	});

	test("handles missing model spec", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test-agent",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/test-agent/kickoff.md",
			exitFile: "/repo/.pi/runtime/test-agent/exit.json",
			runtimeDir: "/repo/.pi/runtime/test-agent",
		});

		// MODEL_SPEC is empty, so model flag should not be added to PI_CMD
		// The script will still have the conditional, but it won't execute
		expect(script).toContain("PI_CMD=(pi)");
	});

	test("handles empty parent session", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test-agent",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/test-agent/kickoff.md",
			exitFile: "/repo/.pi/runtime/test-agent/exit.json",
			runtimeDir: "/repo/.pi/runtime/test-agent",
		});

		// Should handle empty parent session
		expect(script).toContain("PARENT_SESSION=''");
	});

	test("includes child skills directory when present", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test-agent",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/test-agent/kickoff.md",
			exitFile: "/repo/.pi/runtime/test-agent/exit.json",
			runtimeDir: "/repo/.pi/runtime/test-agent",
		});

		// Should reference skills directory
		expect(script).toContain("CHILD_SKILLS_DIR");
		expect(script).toContain("--skill");
	});

	test("includes start script check", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test-agent",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/test-agent/kickoff.md",
			exitFile: "/repo/.pi/runtime/test-agent/exit.json",
			runtimeDir: "/repo/.pi/runtime/test-agent",
		});

		// Should check for start script
		expect(script).toContain("START_SCRIPT=");
		expect(script).toContain('[[ -x "$START_SCRIPT" ]]');
	});

	test("handles special characters in parameters", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentSessionId: "session with spaces",
			parentRepoRoot: "/repo/path with spaces",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test-agent",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/test-agent/kickoff.md",
			exitFile: "/repo/.pi/runtime/test-agent/exit.json",
			modelSpec: "provider/model'with\"special",
			runtimeDir: "/repo/.pi/runtime/test-agent",
		});

		// Should properly escape single quotes
		expect(script).toContain("'\"'\"'");
	});
});
