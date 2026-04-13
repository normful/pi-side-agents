# Unit Test Plan: pi-side-agents

Each set of new tests gets its own git commit. Tests are organized by the feature commit they cover.

## Source Commits (from `main`..HEAD)

| # | Commit | Message |
|---|--------|---------|
| 1 | `ff48f9b` | fix(portability): avoid non-portable shell commands |
| 2 | `9daeefe` | fix(side-agents): prevent worktree double-allocation |
| 3 | `b4d717d` | fix(side-agents): keep worktree locked for failed/crashed agents |
| 4 | `4329c26` | feat(side-agents): auto-inherit mode from modes.json |
| 5 | `872ab79` | fix(side-agents): source start script instead of executing |
| 6 | `46536da` | fix(side-agents): don't create meta dir for no-op refresh |
| 7 | `356698d` | feat(side-agents): wait for shell prompt before sending commands |
| 8 | `3da9330` | fix: add missing worktrees property to RegistryFile |
| 9 | `3d3ef76` | A (added) UPSTREAM_SYNC_PLAN.md |

Commits 8 and 9 are skipped (documentation/typo-fix only, no testable behavior).

---

## Commit 1: `356698d` — tmuxWaitForShellReady

**Test commit**: `test(tmux): add tmuxWaitForShellReady tests`

Waits for a shell prompt (`$`, `#`, `%`, `>`) in a newly created tmux window before sending commands. Prevents race condition where tmux send-keys arrive before bash initializes.

| # | Subject | Description |
|---|---------|-------------|
| 1 | `test(tmux): tmuxWaitForShellReady resolves when dollar prompt detected` | Mock `tmux capture-pane` returning lines ending with `$`, verify function resolves within timeout |
| 2 | `test(tmux): tmuxWaitForShellReady resolves when hash prompt detected` | Same with `#` prompt |
| 3 | `test(tmux): tmuxWaitForShellReady ignores empty lines` | Mock output with whitespace-only lines, verify it keeps polling |
| 4 | `test(tmux): tmuxWaitForShellReady times out gracefully` | Mock empty output, verify it returns without throwing after timeout |
| 5 | `test(tmux): tmuxWaitForShellReady handles tmux failure` | Mock failed `capture-pane`, verify graceful timeout (proceed anyway) |

**File under test**: `extensions/side-agents/tmux.ts`
**Function**: `tmuxWaitForShellReady`

---

## Commit 2: `46536da` — refreshAllAgents no-op

**Test commit**: `test(agent): add refreshAllAgents no-op tests`

`refreshAllAgents()` now returns early with empty registry if the meta dir doesn't exist, avoiding unnecessary directory creation.

| # | Subject | Description |
|---|---------|-------------|
| 6 | `test(agent): refreshAllAgents returns empty registry when meta dir missing` | Call `refreshAllAgents()` on a `stateRoot` where meta dir does not exist; verify it returns `{ version: 1, agents: {} }` without throwing |
| 7 | `test(agent): refreshAllAgents does not create meta dir` | Verify the meta directory is NOT created after calling `refreshAllAgents` on a fresh `stateRoot` |

**File under test**: `extensions/side-agents/agent.ts`
**Function**: `refreshAllAgents`

---

## Commit 3: `872ab79` — buildLaunchScript sourcing

**Test commit**: `test(tmux): add buildLaunchScript sourcing tests`

The launch script now uses `source` instead of executing the start script directly. Also adds `iso_now()` helper for portable timestamps.

| # | Subject | Description |
|---|---------|-------------|
| 8 | `test(tmux): buildLaunchScript sources start script instead of executing` | Call `buildLaunchScript()`, parse the output string, verify it contains `source "$START_SCRIPT"` and NOT `"$START_SCRIPT"` |
| 9 | `test(tmux): buildLaunchScript includes iso_now helper` | Verify the script contains the `iso_now()` function definition using portable `date -u` |

**File under test**: `extensions/side-agents/tmux.ts`
**Function**: `buildLaunchScript`

---

## Commit 4: `4329c26` — modes.json inheritance

**Test commit**: `test(agent): add modes.json inheritance tests`

When starting an agent without a model specified, the code infers the full model spec (provider/modelId:thinkingLevel) from `~/.pi/agent/modes.json` or project `.pi/modes.json`.

| # | Subject | Description |
|---|---------|-------------|
| 10 | `test(agent): readModesFile returns project-level modes.json` | Create a `.pi/modes.json` in cwd, call `readModesFile(cwd)`, verify it returns the project-level file |
| 11 | `test(agent): readModesFile falls back to global modes.json` | No project file exists, verify `readModesFile()` falls back to `~/.pi/agent/modes.json` |
| 12 | `test(agent): readModesFile returns undefined for empty modes` | Create modes.json with `modes: {}`, verify `readModesFile()` returns undefined |
| 13 | `test(agent): readModesFile returns undefined when no files exist` | Neither project nor global file exists, verify graceful undefined return |
| 14 | `test(agent): modeSpecToModelSpec builds spec without thinkingLevel` | Input `{ provider: "anthropic", modelId: "claude-3" }` → `"anthropic/claude-3"` |
| 15 | `test(agent): modeSpecToModelSpec builds spec with thinkingLevel` | Input `{ provider: "anthropic", modelId: "claude-3", thinkingLevel: "high" }` → `"anthropic/claude-3:high"` |
| 16 | `test(agent): modeSpecToModelSpec returns undefined for missing fields` | Missing provider or modelId → undefined |
| 17 | `test(agent): inferCurrentModeModelSpec returns undefined without ctx.model` | `ctx.model` is null → undefined |
| 18 | `test(agent): inferCurrentModeModelSpec returns undefined when no match` | Active model not in modes.json → undefined |
| 19 | `test(agent): inferCurrentModeModelSpec returns mode spec when matched` | Provider, modelId, and thinkingLevel all match → full spec with thinking |
| 20 | `test(agent): inferCurrentModeModelSpec ignores mode with wrong thinkingLevel` | Provider/modelId match but thinkingLevel differs → undefined |
| 21 | `test(agent): resolveModelSpecForChild inherits mode when no model requested` | `requested` is empty, `thinkingLevel` provided → inherits from modes.json |

**Files under test**: `extensions/side-agents/agent.ts`
**Functions**: `readModesFile`, `modeSpecToModelSpec`, `inferCurrentModeModelSpec`, `resolveModelSpecForChild`

---

## Commit 5: `b4d717d` — crash lock behavior

**Test commit**: `test(agent): add crash lock behavior tests`

Worktree lock is now kept for crashed/failed agents. The workspace remains blocked from reuse until the agent is explicitly cleared.

| # | Subject | Description |
|---|---------|-------------|
| 22 | `test(agent): refreshOneAgentRuntime cleans lock for done agent` | Agent status is `"done"` → `cleanupWorktreeLockBestEffort` IS called, agent removed from registry |
| 23 | `test(agent): refreshOneAgentRuntime cleans lock for successful exit` | Exit code 0 → removes from registry, cleans lock |
| 24 | `test(agent): refreshOneAgentRuntime cleans lock for failed exit` | Exit code != 0 → removes from registry, cleans lock |
| 25 | `test(agent): refreshOneAgentRuntime does NOT clean lock for crashed agent` | No tmux window → status becomes `"crashed"`, lock is NOT cleaned |

**File under test**: `extensions/side-agents/agent.ts`
**Function**: `refreshOneAgentRuntime`

---

## Commit 6: `9daeefe` — double-allocation guard

**Test commit**: `test(worktree): add double-allocation guard tests`

`claimWorktree()` now checks the registry for an existing active agent on the same path before claiming. Also adds `agentId` parameter to `cleanupWorktreeLockBestEffort()` to verify lock ownership.

| # | Subject | Description |
|---|---------|-------------|
| 26 | `test(worktree): cleanupWorktreeLockBestEffort skips deletion when agentId mismatch` | Lock file has `agentId: "other"`, call with `agentId: "self"` → lock is NOT deleted |
| 27 | `test(worktree): cleanupWorktreeLockBestEffort deletes when agentId matches` | Lock and call use same `agentId` → lock IS deleted |
| 28 | `test(worktree): cleanupWorktreeLockBestEffort deletes when no agentId provided` | No `agentId` param (backward compatible) → lock IS deleted |
| 29 | `test(worktree): allocateWorktree warns on double-allocation` | Registry already has active agent on same path → `warnings` array contains the double-allocation message |
| 30 | `test(worktree): allocateWorktree does not warn for terminal status agents` | Registry has `done`/`failed` agent on same path → no warning |
| 31 | `test(worktree): allocateWorktree handles registry load failure gracefully` | `loadRegistry()` throws → allocation succeeds, no warning added |

**Files under test**: `extensions/side-agents/worktree.ts`, `extensions/side-agents/registry.ts`
**Functions**: `cleanupWorktreeLockBestEffort`, `allocateWorktree`

---

## Commit 7: `ff48f9b` — portable date

**Test commit**: `test(tmux): add portable date tests`

The launch script now uses portable `date` command (`date -u +"%Y-%m-%dT%H:%M:%SZ"`) via the `iso_now()` helper instead of non-portable `date -Is`.

| # | Subject | Description |
|---|---------|-------------|
| 32 | `test(tmux): buildLaunchScript uses portable iso_now for timestamps` | Verify script contains `date -u +"%Y-%m-%dT%H:%M:%SZ"` (ISO 8601 UTC format) |
| 33 | `test(tmux): buildLaunchScript output is valid bash` | Pass script output through `bash -n` syntax check |

**File under test**: `extensions/side-agents/tmux.ts`
**Function**: `buildLaunchScript`

---

## Summary Table

| Test # | Feature Commit | File | Description |
|--------|----------------|------|-------------|
| 1 | `356698d` | tmux.ts | Dollar prompt detected |
| 2 | `356698d` | tmux.ts | Hash prompt detected |
| 3 | `356698d` | tmux.ts | Ignores empty lines |
| 4 | `356698d` | tmux.ts | Times out gracefully |
| 5 | `356698d` | tmux.ts | Handles tmux failure |
| 6 | `46536da` | agent.ts | Returns empty registry |
| 7 | `46536da` | agent.ts | Does not create meta dir |
| 8 | `872ab79` | tmux.ts | Sources start script |
| 9 | `872ab79` | tmux.ts | Includes iso_now |
| 10 | `4329c26` | agent.ts | Project-level modes.json |
| 11 | `4329c26` | agent.ts | Global fallback |
| 12 | `4329c26` | agent.ts | Empty modes object |
| 13 | `4329c26` | agent.ts | No files exist |
| 14 | `4329c26` | agent.ts | Spec without thinking |
| 15 | `4329c26` | agent.ts | Spec with thinking |
| 16 | `4329c26` | agent.ts | Missing fields |
| 17 | `4329c26` | agent.ts | No ctx.model |
| 18 | `4329c26` | agent.ts | No match found |
| 19 | `4329c26` | agent.ts | Full match |
| 20 | `4329c26` | agent.ts | Wrong thinking level |
| 21 | `4329c26` | agent.ts | Inherits mode |
| 22 | `b4d717d` | agent.ts | Cleans lock for done |
| 23 | `b4d717d` | agent.ts | Cleans lock on success |
| 24 | `b4d717d` | agent.ts | Cleans lock on fail |
| 25 | `b4d717d` | agent.ts | Keeps lock for crash |
| 26 | `9daeefe` | worktree.ts | Skips on mismatch |
| 27 | `9daeefe` | worktree.ts | Deletes on match |
| 28 | `9daeefe` | worktree.ts | Deletes no agentId |
| 29 | `9daeefe` | worktree.ts | Warns on double |
| 30 | `9daeefe` | worktree.ts | No warn terminal |
| 31 | `9daeefe` | worktree.ts | Handles error |
| 32 | `ff48f9b` | tmux.ts | Portable date |
| 33 | `ff48f9b` | tmux.ts | Valid bash |

**Total: 7 test commits, 33 tests**
