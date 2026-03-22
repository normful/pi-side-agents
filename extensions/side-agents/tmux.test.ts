import { describe, expect, test } from "bun:test";
import {
	buildLaunchScript,
	PI_SIDE_AGENT_ID,
	PI_SIDE_AGENTS_ROOT,
	PI_SIDE_PARENT_REPO,
	PI_SIDE_PARENT_SESSION,
	PI_SIDE_RUNTIME_DIR,
} from "./tmux.js";

describe("buildLaunchScript", () => {
	test("generates valid bash script with shebang", () => {
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

		expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
	});

	test("checks for cco command and exits with helpful message if missing", () => {
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

		expect(script).toContain("command -v cco");
		expect(script).toContain("https://github.com/nikvdp/cco");
		expect(script).toContain("cco' command not found");
	});

	test("exports PI_SIDE_AGENT_ID environment variable (uses bash variable reference)", () => {
		const script = buildLaunchScript({
			agentId: "my-test-agent",
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-my-test-agent",
			tmuxWindowId: "@2",
			promptPath: "/repo/.pi/runtime/my-test-agent/kickoff.md",
			exitFile: "/repo/.pi/runtime/my-test-agent/exit.json",
			runtimeDir: "/repo/.pi/runtime/my-test-agent",
		});

		// The script defines AGENT_ID locally, then exports PI_SIDE_AGENT_ID referencing it
		expect(script).toContain(`export ${PI_SIDE_AGENT_ID}="$AGENT_ID"`);
		// The local variable should be set with the quoted value
		expect(script).toContain("AGENT_ID='my-test-agent'");
	});

	test("exports PI_SIDE_PARENT_SESSION environment variable", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentSessionId: "main-session-456",
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test-agent",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/test-agent/kickoff.md",
			exitFile: "/repo/.pi/runtime/test-agent/exit.json",
			runtimeDir: "/repo/.pi/runtime/test-agent",
		});

		expect(script).toContain(
			`export ${PI_SIDE_PARENT_SESSION}="$PARENT_SESSION"`,
		);
		expect(script).toContain("PARENT_SESSION='main-session-456'");
	});

	test("exports PI_SIDE_PARENT_REPO environment variable", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentRepoRoot: "/Users/norman/code/myproject",
			stateRoot: "/Users/norman/code/myproject",
			worktreePath: "/Users/norman/code/myproject/.worktrees/agent-test-agent",
			tmuxWindowId: "@1",
			promptPath:
				"/Users/norman/code/myproject/.pi/runtime/test-agent/kickoff.md",
			exitFile: "/Users/norman/code/myproject/.pi/runtime/test-agent/exit.json",
			runtimeDir: "/Users/norman/code/myproject/.pi/runtime/test-agent",
		});

		expect(script).toContain(`export ${PI_SIDE_PARENT_REPO}="$PARENT_REPO"`);
		expect(script).toContain("PARENT_REPO='/Users/norman/code/myproject'");
	});

	test("exports PI_SIDE_AGENTS_ROOT environment variable", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentRepoRoot: "/repo",
			stateRoot: "/repo/.pi/side-agents",
			worktreePath: "/repo/.worktrees/agent-test-agent",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/test-agent/kickoff.md",
			exitFile: "/repo/.pi/runtime/test-agent/exit.json",
			runtimeDir: "/repo/.pi/runtime/test-agent",
		});

		expect(script).toContain(`export ${PI_SIDE_AGENTS_ROOT}="$STATE_ROOT"`);
		expect(script).toContain("STATE_ROOT='/repo/.pi/side-agents'");
	});

	test("exports PI_SIDE_RUNTIME_DIR environment variable", () => {
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

		expect(script).toContain(`export ${PI_SIDE_RUNTIME_DIR}="$RUNTIME_DIR"`);
		expect(script).toContain("RUNTIME_DIR='/repo/.pi/runtime/test-agent'");
	});

	test("exports all five environment variables with correct names", () => {
		const script = buildLaunchScript({
			agentId: "all-envs-test",
			parentSessionId: "session-abc",
			parentRepoRoot: "/test/repo",
			stateRoot: "/test/repo/state",
			worktreePath: "/test/repo/.worktrees/agent-all-envs-test",
			tmuxWindowId: "@5",
			promptPath: "/test/repo/.pi/runtime/all-envs-test/kickoff.md",
			exitFile: "/test/repo/.pi/runtime/all-envs-test/exit.json",
			runtimeDir: "/test/repo/.pi/runtime/all-envs-test",
		});

		// Verify each environment variable is exported with its correct name
		expect(script).toContain(`export ${PI_SIDE_AGENT_ID}="$AGENT_ID"`);
		expect(script).toContain(
			`export ${PI_SIDE_PARENT_SESSION}="$PARENT_SESSION"`,
		);
		expect(script).toContain(`export ${PI_SIDE_PARENT_REPO}="$PARENT_REPO"`);
		expect(script).toContain(`export ${PI_SIDE_AGENTS_ROOT}="$STATE_ROOT"`);
		expect(script).toContain(`export ${PI_SIDE_RUNTIME_DIR}="$RUNTIME_DIR"`);
	});

	test("handles missing parentSessionId (exports empty string)", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			// parentSessionId is undefined
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test-agent",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/test-agent/kickoff.md",
			exitFile: "/repo/.pi/runtime/test-agent/exit.json",
			runtimeDir: "/repo/.pi/runtime/test-agent",
		});

		// When parentSessionId is undefined, it should be empty string
		expect(script).toContain("PARENT_SESSION=''");
		expect(script).toContain(
			`export ${PI_SIDE_PARENT_SESSION}="$PARENT_SESSION"`,
		);
	});

	test("handles missing modelSpec (model flag not added)", () => {
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

		// PI_CMD is initialized with cco wrapper but MODEL_SPEC is empty, so the conditional prevents --model
		expect(script).toContain('PI_CMD=(cco --safe --add-dir "~/.bun:ro" --add-dir "~/code/ai-agents-configs:ro" --add-dir "$RUNTIME_DIR:rw" --add-dir "$(dirname "$PARENT_REPO"):ro" pi --skill "$CHILD_SKILLS_DIR")');
		expect(script).toContain("MODEL_SPEC=''");
		// The conditional check prevents adding --model when empty
		expect(script).toContain('if [[ -n "$MODEL_SPEC" ]]; then');
	});

	test("adds model flag when modelSpec is provided", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test-agent",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/test-agent/kickoff.md",
			exitFile: "/repo/.pi/runtime/test-agent/exit.json",
			modelSpec: "anthropic/claude-3-5-sonnet",
			runtimeDir: "/repo/.pi/runtime/test-agent",
		});

		expect(script).toContain('PI_CMD=(cco --safe --add-dir "~/.bun:ro" --add-dir "~/code/ai-agents-configs:ro" --add-dir "$RUNTIME_DIR:rw" --add-dir "$(dirname "$PARENT_REPO"):ro" pi --skill "$CHILD_SKILLS_DIR")');
		expect(script).toContain('PI_CMD+=(--model "$MODEL_SPEC")');
		expect(script).toContain("MODEL_SPEC='anthropic/claude-3-5-sonnet'");
	});

	test("handles special characters in agentId", () => {
		const script = buildLaunchScript({
			agentId: "test-agent-with-special-chars",
			parentSessionId: "session-123",
			parentRepoRoot: "/repo/path with spaces",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/agent-test/kickoff.md",
			exitFile: "/repo/.pi/runtime/agent-test/exit.json",
			runtimeDir: "/repo/.pi/runtime/agent-test",
		});

		// Should still export the environment variable correctly
		expect(script).toContain(`export ${PI_SIDE_AGENT_ID}="$AGENT_ID"`);
		expect(script).toContain("AGENT_ID='test-agent-with-special-chars'");
	});

	test("handles special characters in modelSpec", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/agent-test/kickoff.md",
			exitFile: "/repo/.pi/runtime/agent-test/exit.json",
			modelSpec: "provider/model'with\"special",
			runtimeDir: "/repo/.pi/runtime/agent-test",
		});

		// shellQuote should escape single quotes properly using '"'"' pattern
		expect(script).toContain("MODEL_SPEC=");
		expect(script).toContain(`'"'"'`); // escaped single quote
	});

	test("includes write_exit function", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/agent-test/kickoff.md",
			exitFile: "/repo/.pi/runtime/agent-test/exit.json",
			runtimeDir: "/repo/.pi/runtime/agent-test",
		});

		expect(script).toContain("write_exit()");
		expect(script).toContain('write_exit "$exit_code"');
	});

	test("includes start script check", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/agent-test/kickoff.md",
			exitFile: "/repo/.pi/runtime/agent-test/exit.json",
			runtimeDir: "/repo/.pi/runtime/agent-test",
		});

		expect(script).toContain('[[ -x "$START_SCRIPT" ]]');
	});

	test("includes child skills directory setup", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/agent-test/kickoff.md",
			exitFile: "/repo/.pi/runtime/agent-test/exit.json",
			runtimeDir: "/repo/.pi/runtime/agent-test",
		});

		expect(script).toContain("CHILD_SKILLS_DIR");
		expect(script).toContain('pi --skill "$CHILD_SKILLS_DIR"');
	});

	test("sets WORKTREE correctly with single quotes", () => {
		const worktreePath = "/repo/.worktrees/agent-test";
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: worktreePath,
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/agent-test/kickoff.md",
			exitFile: "/repo/.pi/runtime/agent-test/exit.json",
			runtimeDir: "/repo/.pi/runtime/agent-test",
		});

		// shellQuote wraps values in single quotes
		expect(script).toContain(`WORKTREE='${worktreePath}'`);
	});

	test("exports the correct constant names (regression test)", () => {
		// These tests verify the constants are correct and exported properly
		expect(PI_SIDE_AGENT_ID).toBe("PI_SIDE_AGENT_ID");
		expect(PI_SIDE_PARENT_SESSION).toBe("PI_SIDE_PARENT_SESSION");
		expect(PI_SIDE_PARENT_REPO).toBe("PI_SIDE_PARENT_REPO");
		expect(PI_SIDE_AGENTS_ROOT).toBe("PI_SIDE_AGENTS_ROOT");
		expect(PI_SIDE_RUNTIME_DIR).toBe("PI_SIDE_RUNTIME_DIR");
	});

	test("generated script can be parsed as valid bash", () => {
		const script = buildLaunchScript({
			agentId: "test-agent",
			parentSessionId: "parent-123",
			parentRepoRoot: "/repo",
			stateRoot: "/repo",
			worktreePath: "/repo/.worktrees/agent-test",
			tmuxWindowId: "@1",
			promptPath: "/repo/.pi/runtime/agent-test/kickoff.md",
			exitFile: "/repo/.pi/runtime/agent-test/exit.json",
			runtimeDir: "/repo/.pi/runtime/agent-test",
		});

		// Verify the script has all required sections
		expect(script).toContain("#!/usr/bin/env bash");
		expect(script).toContain("set -euo pipefail");
		expect(script).toContain("export PI_SIDE_");
		expect(script).toContain('cd "$WORKTREE"');
		expect(script).toContain('"${PI_CMD[@]}"');
		expect(script).toContain("tmux kill-window");
	});
});
