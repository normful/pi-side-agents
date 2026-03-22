import { run, runOrThrow, shellQuote, splitLines } from "./utils.js";

// These constants must match what the pi-side-agents extension reads.
// Keep in sync with extensions/side-agents.ts
export const PI_SIDE_AGENT_ID = "PI_SIDE_AGENT_ID";
export const PI_SIDE_PARENT_SESSION = "PI_SIDE_PARENT_SESSION";
export const PI_SIDE_PARENT_REPO = "PI_SIDE_PARENT_REPO";
export const PI_SIDE_AGENTS_ROOT = "PI_SIDE_AGENTS_ROOT";
export const PI_SIDE_RUNTIME_DIR = "PI_SIDE_RUNTIME_DIR";

export function ensureTmuxReady(): void {
	const version = run("tmux", ["-V"]);
	if (!version.ok) {
		throw new Error(
			"tmux is required for /agent but was not found or is not working",
		);
	}

	const session = run("tmux", ["display-message", "-p", "#S"]);
	if (!session.ok) {
		throw new Error(
			"/agent must be run from inside tmux (current tmux session was not detected)",
		);
	}
}

export function getCurrentTmuxSession(): string {
	const result = runOrThrow("tmux", ["display-message", "-p", "#S"]);
	const value = result.stdout.trim();
	if (!value) throw new Error("Failed to determine current tmux session");
	return value;
}

export function createTmuxWindow(
	tmuxSession: string,
	name: string,
): { windowId: string; windowIndex: number } {
	const result = runOrThrow("tmux", [
		"new-window",
		"-d",
		"-t",
		`${tmuxSession}:`,
		"-P",
		"-F",
		"#{window_id} #{window_index}",
		"-n",
		name,
	]);
	const out = result.stdout.trim();
	const [windowId, indexRaw] = out.split(/\s+/);
	const windowIndex = Number(indexRaw);
	if (!windowId || !Number.isFinite(windowIndex)) {
		throw new Error(`Unable to parse tmux window identity: ${out}`);
	}
	return { windowId, windowIndex };
}

export function tmuxPipePaneToFile(windowId: string, logPath: string): void {
	runOrThrow("tmux", [
		"pipe-pane",
		"-t",
		windowId,
		"-o",
		`cat >> ${shellQuote(logPath)}`,
	]);
}

export function tmuxSendLine(windowId: string, line: string): void {
	runOrThrow("tmux", ["send-keys", "-t", windowId, line, "Enter"]);
}

export function tmuxInterrupt(windowId: string): void {
	run("tmux", ["send-keys", "-t", windowId, "C-c"]);
}

export function tmuxSendPrompt(windowId: string, prompt: string): void {
	const loaded = run("tmux", ["load-buffer", "-"], { input: prompt });
	if (!loaded.ok) {
		throw new Error(
			`Failed to send input to tmux window ${windowId}: ${loaded.stderr || loaded.error || "unknown error"}`,
		);
	}
	runOrThrow("tmux", ["paste-buffer", "-d", "-t", windowId]);
	runOrThrow("tmux", ["send-keys", "-t", windowId, "Enter"]);
}

/** Capture the currently visible tmux pane content (no scrollback). */
export function tmuxCaptureVisible(windowId: string): string[] {
	const captured = run("tmux", ["capture-pane", "-p", "-t", windowId]);
	if (!captured.ok) return [];
	return splitLines(captured.stdout);
}

export function buildLaunchScript(params: {
	agentId: string;
	parentSessionId?: string;
	parentRepoRoot: string;
	stateRoot: string;
	worktreePath: string;
	tmuxWindowId: string;
	promptPath: string;
	exitFile: string;
	modelSpec?: string;
	runtimeDir: string;
}): string {
	// Shell-quoted values for use in the generated script
	const agentId = shellQuote(params.agentId);
	const parentSession = shellQuote(params.parentSessionId ?? "");
	const parentRepo = shellQuote(params.parentRepoRoot);
	const stateRoot = shellQuote(params.stateRoot);
	const worktree = shellQuote(params.worktreePath);
	const windowId = shellQuote(params.tmuxWindowId);
	const promptFile = shellQuote(params.promptPath);
	const exitFile = shellQuote(params.exitFile);
	const modelSpec = shellQuote(params.modelSpec ?? "");
	const runtimeDir = shellQuote(params.runtimeDir);

	// Direct export of known environment variable names
	// Using $$ to produce a single $ that bash expands, then the const value
	const envAgentId = PI_SIDE_AGENT_ID;
	const envParentSession = PI_SIDE_PARENT_SESSION;
	const envParentRepo = PI_SIDE_PARENT_REPO;
	const envStateRoot = PI_SIDE_AGENTS_ROOT;
	const envRuntimeDir = PI_SIDE_RUNTIME_DIR;

	return `#!/usr/bin/env bash
set -euo pipefail

# Verify cco is available
if ! command -v cco &>/dev/null; then
  echo "[side-agent] Error: 'cco' command not found." >&2
  echo "[side-agent] cco is required for filesystem sandboxing" >&2
  echo "[side-agent] See: https://github.com/nikvdp/cco" >&2
  exit 1
fi

AGENT_ID=${agentId}
PARENT_SESSION=${parentSession}
PARENT_REPO=${parentRepo}
STATE_ROOT=${stateRoot}
WORKTREE=${worktree}
WINDOW_ID=${windowId}
PROMPT_FILE=${promptFile}
EXIT_FILE=${exitFile}
MODEL_SPEC=${modelSpec}
RUNTIME_DIR=${runtimeDir}
START_SCRIPT="$WORKTREE/.pi/side-agent-start.sh"
CHILD_SKILLS_DIR="$WORKTREE/.pi/side-agent-skills"

export ${envAgentId}="$AGENT_ID"
export ${envParentSession}="$PARENT_SESSION"
export ${envParentRepo}="$PARENT_REPO"
export ${envStateRoot}="$STATE_ROOT"
export ${envRuntimeDir}="$RUNTIME_DIR"

write_exit() {
  local code="$1"
  printf '{"exitCode":%d,"finishedAt":"%s"}\n' "$code" "$(date -Is)" > "$EXIT_FILE"
}

cd "$WORKTREE"

if [[ -x "$START_SCRIPT" ]]; then
  set +e
  "$START_SCRIPT" "$PARENT_REPO" "$WORKTREE" "$AGENT_ID"
  start_exit=$?
  set -e
  if [[ "$start_exit" -ne 0 ]]; then
    echo "[side-agent] start script failed with code $start_exit"
    write_exit "$start_exit"
    read -n 1 -s -r -p "[side-agent] Press any key to close this tmux window..." || true
    echo
    tmux kill-window -t "$WINDOW_ID" || true
    exit "$start_exit"
  fi
fi

PI_CMD=(cco --safe --add-dir "~/.bun:ro" --add-dir "~/code/ai-agents-configs:ro" --add-dir "$(dirname "$PARENT_SESSION"):ro" --add-dir "$PARENT_REPO:ro" --add-dir "$STATE_ROOT:ro" --add-dir "$RUNTIME_DIR:rw" pi --skill "$CHILD_SKILLS_DIR")
if [[ -n "$MODEL_SPEC" ]]; then
  PI_CMD+=(--model "$MODEL_SPEC")
fi

set +e
"\${PI_CMD[@]}" "$(cat "$PROMPT_FILE")"
exit_code=$?
set -e

write_exit "$exit_code"

if [[ "$exit_code" -eq 0 ]]; then
  echo "[side-agent] Agent finished."
else
  echo "[side-agent] Agent exited with code $exit_code."
fi

read -n 1 -s -r -p "[side-agent] Press any key to close this tmux window..." || true
echo

tmux kill-window -t "$WINDOW_ID" || true
`;
}
