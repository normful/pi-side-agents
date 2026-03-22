import { run, runOrThrow, shellQuote, splitLines } from "./utils.js";

const _ENV_AGENT_ID = "PI_SIDE_AGENT_ID";
const _ENV_PARENT_SESSION = "PI_SIDE_PARENT_SESSION";
const _ENV_PARENT_REPO = "PI_SIDE_PARENT_REPO";
const _ENV_STATE_ROOT = "PI_SIDE_AGENTS_ROOT";
const _ENV_RUNTIME_DIR = "PI_SIDE_RUNTIME_DIR";
// Reference constants to satisfy noUnusedLocals
const _refs = {
	_ENV_AGENT_ID,
	_ENV_PARENT_SESSION,
	_ENV_PARENT_REPO,
	_ENV_STATE_ROOT,
	_ENV_RUNTIME_DIR,
};
void _refs;

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
	runOrThrow("tmux", ["send-keys", "-t", windowId, line, "C-m"]);
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
	runOrThrow("tmux", ["send-keys", "-t", windowId, "C-m"]);
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
	return `#!/usr/bin/env bash
set -euo pipefail

AGENT_ID=${shellQuote(params.agentId)}
PARENT_SESSION=${shellQuote(params.parentSessionId ?? "")}
PARENT_REPO=${shellQuote(params.parentRepoRoot)}
STATE_ROOT=${shellQuote(params.stateRoot)}
WORKTREE=${shellQuote(params.worktreePath)}
WINDOW_ID=${shellQuote(params.tmuxWindowId)}
PROMPT_FILE=${shellQuote(params.promptPath)}
EXIT_FILE=${shellQuote(params.exitFile)}
MODEL_SPEC=${shellQuote(params.modelSpec ?? "")}
RUNTIME_DIR=${shellQuote(params.runtimeDir)}
START_SCRIPT="$WORKTREE/.pi/side-agent-start.sh"
CHILD_SKILLS_DIR="$WORKTREE/.pi/side-agent-skills"

export \${_ENV_AGENT_ID}="$AGENT_ID"
export \${_ENV_PARENT_SESSION}="$PARENT_SESSION"
export \${_ENV_PARENT_REPO}="$PARENT_REPO"
export \${_ENV_STATE_ROOT}="$STATE_ROOT"
export \${_ENV_RUNTIME_DIR}="$RUNTIME_DIR"

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

PI_CMD=(pi)
if [[ -n "$MODEL_SPEC" ]]; then
  PI_CMD+=(--model "$MODEL_SPEC")
fi
if [[ -d "$CHILD_SKILLS_DIR" ]]; then
  # agent-setup writes the child-only finish skill here; load it explicitly.
  PI_CMD+=(--skill "$CHILD_SKILLS_DIR")
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
