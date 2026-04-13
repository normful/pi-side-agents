# Detailed Change Plan: Upstream Sync — normful fork

The upstream repo is at git@github.com:pasky/pi-side-agents.git

## Context

This plan captures changes from upstream commits applicable to the local fork (`origin/main`) of `pi-side-agents`. The fork has diverged significantly from upstream and cannot simply merge. This is a selective cherry-pick of backward-compatible improvements.

**Upstream commits to port:** 2, 3, 4, 5, 11, 12, 13
**Commits skipped:** 1 (version bump), 6 (pi-0.65.0 compat — already done equivalently, see below), 8 (README only), 9 (version bump), 10 (API mismatch — `getApiKeyAndHeaders` not applicable to this fork's `getApiKeyForProvider`)

### Commit 6 note: pi-0.65.0 compat already done

Upstream commit `e619583` removes the `session_switch` event handler and updates peer dependencies. This fork has no `session_switch` handler. The `getApiKeyAndHeaders` migration (commit 10) and `getThinkingLevel` API (part of commit 5) do NOT apply — this fork uses `getApiKeyForProvider` which is a distinct API surface. **No action needed for commit 6.**

---

## Commit 2: `39c2959` — Fix tmux race (wait for shell prompt)

### Problem
When spawning a new tmux window for an agent, commands sent via `tmux send-keys` can arrive before bash has fully initialized and are silently lost (displayed as text but never executed).

### Solution
Poll the tmux pane until a shell prompt (ending in `$`, `#`, `%`, or `>`) is detected, then proceed.

---

### File: `extensions/side-agents/tmux.ts`

**Add new async function after `tmuxCaptureVisible` (lines 95–101). Export it so agent.ts can call it:**

```typescript
// ===== INSERT AFTER LINE 101 (after the closing brace of tmuxCaptureVisible) =====

/** Wait for a shell prompt to appear in a newly created tmux window. */
export async function tmuxWaitForShellReady(
    windowId: string,
    timeoutMs = 5000,
): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const captured = run("tmux", ["capture-pane", "-p", "-t", windowId]);
        if (captured.ok) {
            const lines = captured.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
            if (lines.some((l) => /[\$#%>]\s*$/.test(l))) {
                return;
            }
        }
        await sleep(50);
    }
    // Timed out — proceed anyway rather than failing the whole agent start.
}
```

Note: `run` and `sleep` are already imported at line 1 of `tmux.ts`.

---

### File: `extensions/side-agents/agent.ts`

**Step 1 — Add `tmuxWaitForShellReady` to the `./tmux.js` import block (lines 46–48):**

```typescript
// CURRENT (lines 46–48):
import {
    buildLaunchScript,
    createTmuxWindow,
    ensureTmuxReady,
    getCurrentTmuxSession,
    tmuxCaptureVisible,
    tmuxInterrupt,
    tmuxPipePaneToFile,
    tmuxSendLine,
    tmuxSendPrompt,
} from "./tmux.js";

// REPLACE WITH:
import {
    buildLaunchScript,
    createTmuxWindow,
    ensureTmuxReady,
    getCurrentTmuxSession,
    tmuxCaptureVisible,
    tmuxInterrupt,
    tmuxPipePaneToFile,
    tmuxSendLine,
    tmuxSendPrompt,
    tmuxWaitForShellReady,
} from "./tmux.js";
```

**Step 2 — Call it in `startAgent` after `tmuxPipePaneToFile` and before `tmuxSendLine` (~line 609):**

```typescript
// CURRENT (lines 609–610):
        tmuxPipePaneToFile(windowId, logPath);
        tmuxSendLine(windowId, `cd ${JSON.stringify(worktree.worktreePath)}`);
        tmuxSendLine(windowId, `bash ${JSON.stringify(launchScriptPath)}`);

// REPLACE lines 613–614 WITH:
        tmuxPipePaneToFile(windowId, logPath);
        // Wait for the shell in the new tmux window to be ready before sending
        // commands — otherwise the keystrokes arrive before bash has initialised
        // and are silently lost (displayed as text but never executed).
        await tmuxWaitForShellReady(windowId);
        tmuxSendLine(windowId, `cd ${JSON.stringify(worktree.worktreePath)}`);
```

---

## Commit 3: `be38cd5` — Don't create meta dir for no-op refresh

### Problem
`refreshAllAgents` creates the `.pi/side-agents/` meta directory even when there are no agents to refresh, just to discover the directory is empty.

### Solution
Return early with an empty registry if the meta directory doesn't exist.

---

### File: `extensions/side-agents/agent.ts`

**In `refreshAllAgents` (~line 406), add a guard before `mutateRegistry`:**

```typescript
// CURRENT (lines 423–430):
export async function refreshAllAgents(stateRoot: string) {
    return mutateRegistry(stateRoot, async (registry) => {
        for (const [agentId, record] of Object.entries(registry.agents)) {
            const refreshed = await refreshOneAgentRuntime(stateRoot, record);
            if (refreshed.removeFromRegistry) {
                delete registry.agents[agentId];
            }
        }
    });
}

// REPLACE lines 423–430 WITH:
export async function refreshAllAgents(stateRoot: string) {
    // Don't create the meta dir just to discover there are no agents.
    if (!(await fileExists(getMetaDir(stateRoot)))) return {};
    return mutateRegistry(stateRoot, async (registry) => {
        for (const [agentId, record] of Object.entries(registry.agents)) {
            const refreshed = await refreshOneAgentRuntime(stateRoot, record);
            if (refreshed.removeFromRegistry) {
                delete registry.agents[agentId];
            }
        }
    });
}
```

`fileExists` and `getMetaDir` are already in scope (imported from `./registry.js` on line 49).

---

## Commit 4: `1b77d52` — Source start script instead of subprocess

### Problem
The start script is executed as a subprocess (`"$START_SCRIPT" ...`), so any environment modifications it makes are discarded when the subprocess exits.

### Solution
Source the script in the current shell (`source "$START_SCRIPT" ...`) so it can modify the shell's environment (e.g., set variables, change directory, load configs) for the `pi` command that follows.

---

### File: `extensions/side-agents/tmux.ts`

**In `buildLaunchScript`, change the start script invocation ~line 176:**

```typescript
// CURRENT (lines 174–177):
if [[ -x "$START_SCRIPT" ]]; then
  set +e
  "$START_SCRIPT" "$PARENT_REPO" "$WORKTREE" "$AGENT_ID"
  start_exit=$?
  set -e

// REPLACE lines 174–177 WITH:
if [[ -x "$START_SCRIPT" ]]; then
  set +e
  source "$START_SCRIPT" "$PARENT_REPO" "$WORKTREE" "$AGENT_ID"
  start_exit=$?
  set -e
```

---

## Commit 5: `5571541` — Auto-inherit mode (project-local modes.json + thinking level)

### Problem
When starting a child agent without an explicit model, the thinking level from the parent's mode is not carried over. Also, the global `modes.json` is not consulted for project-level overrides.

### Solution
1. Check project-local `.pi/modes.json` before falling back to global `~/.pi/agent/modes.json`.
2. When no model is requested, infer the current mode by matching the active model+thinking level against `modes.json` definitions.

**Note:** The `getThinkingLevel()` call requires pi 0.65 API. If not available, skip the inference step — the project-local modes.json lookup is independent of any mode flag parsing. This fork's `resolveModelSpecForChild` does NOT have a `getThinkingLevel` equivalent (it uses `getApiKeyForProvider`, not `getApiKeyAndHeaders`), so the call site change is a no-op guard only.

---

### File: `extensions/side-agents/agent.ts`

**Step 1 — Add import** (after line 39, alongside other node: imports):

```typescript
// ===== INSERT after line 39 (after "import { join } from "node:path";" ) =====
import os from "node:os";
```

**Step 2 — Add type aliases** (before `parseAgentCommandArgs`, ~line 136):

```typescript
// ===== INSERT before line 136 (before parseAgentCommandArgs function) =====

type ModeFileSpec = { provider?: string; modelId?: string; thinkingLevel?: string };
type ParsedModesFile = { currentMode?: string; modes?: Record<string, ModeFileSpec> };
```

**Step 3 — Add `readModesFile` helper** (before `parseAgentCommandArgs`, before the type aliases or alongside them):

```typescript
// ===== INSERT before parseAgentCommandArgs (~line 136) =====

/** Read and parse modes.json, checking project-level first, then global. */
async function readModesFile(cwd: string): Promise<{ parsed: ParsedModesFile; path: string } | undefined> {
    const homedir = os.homedir();
    const agentDir = process.env.PI_CODING_AGENT_DIR
        ? resolve(process.env.PI_CODING_AGENT_DIR.replace(/^~/, homedir))
        : join(homedir, ".pi", "agent");

    const candidates = [
        join(cwd, ".pi", "modes.json"),
        join(agentDir, "modes.json"),
    ];

    for (const modesPath of candidates) {
        try {
            const raw = await fs.readFile(modesPath, "utf8");
            const parsed = JSON.parse(raw) as ParsedModesFile;
            if (parsed.modes && typeof parsed.modes === "object" && Object.keys(parsed.modes).length > 0) {
                return { parsed, path: modesPath };
            }
        } catch {
            continue;
        }
    }
    return undefined;
}
```

Note: `fs`, `join`, `resolve`, and `os` need to be in scope. `join` is already imported on line 39. `fs` is imported at line 35. `resolve` is imported at line 40. `os` is added in Step 1.

**Step 4 — Add `modeSpecToModelSpec` helper:**

```typescript
// ===== INSERT alongside the helpers above (~line 136 area) =====

function modeSpecToModelSpec(spec: ModeFileSpec): string | undefined {
    if (!spec.provider || !spec.modelId) return undefined;
    return spec.thinkingLevel
        ? `${spec.provider}/${spec.modelId}:${spec.thinkingLevel}`
        : `${spec.provider}/${spec.modelId}`;
}
```

**Step 5 — Add `inferCurrentModeModelSpec`:**

```typescript
// ===== INSERT alongside the helpers above (~line 136 area) =====

/**
 * Infer the current mode name by matching the active model+thinking level
 * against modes.json definitions. Returns the mode's full model spec if found.
 */
async function inferCurrentModeModelSpec(
    cwd: string,
    ctx: ExtensionContext,
    thinkingLevel: string,
): Promise<string | undefined> {
    if (!ctx.model) return undefined;
    const file = await readModesFile(cwd);
    if (!file?.parsed.modes) return undefined;

    const provider = ctx.model.provider;
    const modelId = ctx.model.id;

    for (const spec of Object.values(file.parsed.modes)) {
        if (
            spec.provider === provider &&
            spec.modelId === modelId &&
            (spec.thinkingLevel ?? undefined) === (thinkingLevel || undefined)
        ) {
            return modeSpecToModelSpec(spec);
        }
    }

    return undefined;
}
```

**Step 6 — Modify `resolveModelSpecForChild` (~line 259). Add `thinkingLevel?: string` parameter and handle auto-inheritance:**

```typescript
// CURRENT (lines 259–280):
export async function resolveModelSpecForChild(
    ctx: ExtensionContext,
    requested?: string,
): Promise<{ modelSpec?: string; warning?: string }> {
    const currentModelSpec = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;
    if (!requested || requested.trim().length === 0) {
        return { ...(currentModelSpec ? { modelSpec: currentModelSpec } : {}) };
    }
    // ... rest unchanged from line 267 onward

// REPLACE lines 259–267 WITH:
export async function resolveModelSpecForChild(
    ctx: ExtensionContext,
    requested?: string,
    thinkingLevel?: string,
): Promise<{ modelSpec?: string; warning?: string }> {
    const currentModelSpec = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;
    if (!requested || requested.trim().length === 0) {
        // Try to inherit the full mode (model + thinking level) from modes.json
        if (thinkingLevel !== undefined) {
            const modeSpec = await inferCurrentModeModelSpec(ctx.cwd, ctx, thinkingLevel);
            if (modeSpec) return { modelSpec: modeSpec };
        }
        return { ...(currentModelSpec ? { modelSpec: currentModelSpec } : {}) };
    }
    // ... rest of function unchanged (lines 267–302 remain the same)
```

**Step 7 — Update the call site in `startAgent` (~line 581):**

```typescript
// CURRENT (line 594):
        const resolvedModel = await resolveModelSpecForChild(ctx, params.model);

// REPLACE line 594 WITH:
        // Try to infer thinking level for auto-inherit (best-effort; getThinkingLevel
        // may not exist in all pi versions).
        const thinkingLevel = (pi as unknown as { getThinkingLevel?: () => string | undefined }).getThinkingLevel?.();
        const resolvedModel = await resolveModelSpecForChild(ctx, params.model, thinkingLevel);
```

Note: `pi` is the `ExtensionAPI` parameter of `startAgent` (line 527).

---

## Commit 11: `e981050` — Keep worktree locked for failed/crashed agents

### Problem
Worktree locks are released when agents crash, allowing the worktree to be reallocated to a new agent before the user has reviewed or cleaned up the failed agent's state.

### Solution
1. Only release worktree locks on successful completion (exit code 0) or explicit user cleanup.
2. When explicitly clearing failed agents, collect worktree paths first, then release locks after registry removal.
3. Add an `agentId` guard to lock deletion to prevent one agent from accidentally deleting another's lock.

---

### File: `extensions/side-agents/worktree.ts`

**Modify `cleanupWorktreeLockBestEffort` (~line 37). Add `agentId?: string` parameter and read-before-delete guard:**

```typescript
// CURRENT (lines 116–121):
export async function cleanupWorktreeLockBestEffort(
    worktreePath?: string,
): Promise<void> {
    if (!worktreePath) return;
    const lockPath = join(worktreePath, ".pi", "active.lock");
    await fs.unlink(lockPath).catch(() => {});
}

// REPLACE lines 116–121 WITH:
export async function cleanupWorktreeLockBestEffort(
    worktreePath?: string,
    agentId?: string,
): Promise<void> {
    if (!worktreePath) return;
    const lockPath = join(worktreePath, ".pi", "active.lock");
    // If an agentId is provided, verify the lock actually belongs to this agent
    // before deleting — another agent may have since claimed the same worktree.
    if (agentId) {
        try {
            const lock = await readJsonFile<Record<string, unknown>>(lockPath);
            if (lock && typeof lock.agentId === "string" && lock.agentId !== agentId) {
                return;
            }
        } catch {
            // If we can't read the lock, proceed with deletion attempt.
        }
    }
    await fs.unlink(lockPath).catch(() => {});
}
```

`readJsonFile` is already imported at line 6 of `worktree.ts`.

---

### File: `extensions/side-agents/agent.ts`

**Update all call sites of `cleanupWorktreeLockBestEffort` in `refreshOneAgentRuntime` (~lines 334, 352, 382):**

#### Call site 1: `record.status === "done"` (~line 334)

```typescript
// CURRENT (line 334):
        await cleanupWorktreeLockBestEffort(record.worktreePath);

// REPLACE line 334 WITH:
        await cleanupWorktreeLockBestEffort(record.worktreePath, record.id);
```

#### Call site 2: `exitFile` success path (~line 352)

```typescript
// CURRENT (line 352):
            await cleanupWorktreeLockBestEffort(record.worktreePath);

// REPLACE line 352 WITH:
            await cleanupWorktreeLockBestEffort(record.worktreePath, record.id);
```

#### Call site 3: Crashed block (~lines 378–384) — **DELETE the lock cleanup line entirely**

```typescript
// CURRENT (lines 378–384):
    if (!isTerminalStatus(record.status)) {
        record.finishedAt = record.finishedAt ?? new Date().toISOString();
        await setRecordStatus(stateRoot, record, "crashed");
        if (!record.error) {
            record.error =
                "tmux window disappeared before an exit marker was recorded";
        }
        await cleanupWorktreeLockBestEffort(record.worktreePath);
    }

// REPLACE lines 378–384 WITH:
    if (!isTerminalStatus(record.status)) {
        record.finishedAt = record.finishedAt ?? new Date().toISOString();
        await setRecordStatus(stateRoot, record, "crashed");
        if (!record.error) {
            record.error =
                "tmux window disappeared before an exit marker was recorded";
        }
        // Do NOT release worktree lock for crashed agents; the workspace
        // is blocked from reuse until the agent is explicitly cleared.
    }
```

---

### File: `extensions/side-agents/index.ts`

**In the `/agents` command handler, failed agent cleanup block (~lines 413–425). Add worktree lock release after registry removal:**

```typescript
// CURRENT (lines 418–425):
            if (confirmed) {
                registry = await mutateRegistry(stateRoot, async (next) => {
                    for (const id of failedIds) {
                        delete next.agents[id];
                    }
                });
                ctx.ui.notify(
                    `Removed ${failedIds.length} agent(s): ${failedIds.join(", ")}`,
                    "info",
                );
            }

// REPLACE lines 418–425 WITH:
            if (confirmed) {
                // Collect worktree paths before removing records so we can
                // release their locks after the registry is updated.
                const worktreePaths: string[] = [];
                registry = await mutateRegistry(stateRoot, async (next) => {
                    for (const id of failedIds) {
                        const rec = next.agents[id];
                        if (rec?.worktreePath) worktreePaths.push(rec.worktreePath);
                        delete next.agents[id];
                    }
                });
                // Release worktree locks now that the agents are cleared.
                for (const wt of worktreePaths) {
                    await cleanupWorktreeLockBestEffort(wt);
                }
                ctx.ui.notify(
                    `Removed ${failedIds.length} agent(s): ${failedIds.join(", ")}`,
                    "info",
                );
            }
```

**Add `cleanupWorktreeLockBestEffort` to the `./worktree.js` import** (line 53):

```typescript
// CURRENT (line 53):
import {
    reclaimOrphanWorktreeLocks,
    scanOrphanWorktreeLocks,
} from "./worktree.js";

// REPLACE WITH:
import {
    cleanupWorktreeLockBestEffort,
    reclaimOrphanWorktreeLocks,
    scanOrphanWorktreeLocks,
} from "./worktree.js";
```

---

## Commit 12: `4fa02bb` — Prevent worktree double-allocation and lock deletion races

### Problem
Worktree allocation only checks for lock files on disk. If a lock file is inadvertently deleted (e.g., by a race condition or a bug), the same worktree could be allocated to two agents simultaneously.

### Solution
Also check the registry for active agents already claiming a worktree, even if the lock file is missing.

---

### File: `extensions/side-agents/worktree.ts`

**In `allocateWorktree`, before the `if (isRegistered)` block (~line 260), build the claimed-by-active-agent set:**

```typescript
// CURRENT (lines 260–263):
    const isRegistered = registered.has(resolve(chosenPath));

    if (isRegistered) {

// REPLACE lines 260–263 WITH:
    const isRegistered = registered.has(resolve(chosenPath));

    // Build a set of worktrees already claimed by active agents in the registry.
    // This guards against double-allocation even if a lock file is missing.
    const claimedByActiveAgent = new Set<string>();
    for (const record of Object.values(registry.agents)) {
        if (record.id !== agentId && record.worktreePath && !isTerminalStatus(record.status)) {
            claimedByActiveAgent.add(resolve(record.worktreePath));
        }
    }

    if (isRegistered) {
```

**In the `allocateWorktree` function, inside the `for (const slot of slots)` loop — but this fork doesn't have a slots loop (it uses `mkdtemp` directly). Instead, add the registry-based check after the existing `fileExists(lockPath)` check, within the `allocateWorktree` function.** Locate the `allocateWorktree` function's body and add the check after the `if (isRegistered)` block, before returning:

```typescript
// CURRENT (in allocateWorktree, after the isRegistered block ~line 285):
    } else {
        runOrThrow("git", [
            "-C",
            repoRoot,
            "worktree",
            "add",
            "-B",
            branch,
            chosenPath,
            mainHead,
        ], gitRunOpts);
    }

    await ensureDir(join(chosenPath, ".pi"));

// REPLACE the closing of the isRegistered/else block and add check ~line 285:
    } else {
        runOrThrow("git", [
            "-C",
            repoRoot,
            "worktree",
            "add",
            "-B",
            branch,
            chosenPath,
            mainHead,
        ], gitRunOpts);
    }

    // Check: is this worktree already claimed by an active agent in the registry
    // (even if the lock file is missing)?
    const resolvedChosenPath = resolve(chosenPath);
    if (claimedByActiveAgent.has(resolvedChosenPath)) {
        warnings.push(
            `Worktree already claimed by an active agent in registry (missing lock?): ${chosenPath}`,
        );
    }

    await ensureDir(join(chosenPath, ".pi"));
```

Note: `isTerminalStatus` is imported from `./registry.js` (line 19 of `worktree.ts`). `resolve` is imported at line 38.

---

## Commit 13: `b4ee224` — Portability fixes (avoid non-portable shell commands)

### Problem
`git branch --show-current` is not available on all git versions. `date -Is` is a GNU extension, not portable to macOS/BSD. `head -1` is ambiguous (POSIX uses `head -n`).

### Solution
Use `git rev-parse --abbrev-ref HEAD` instead of `git branch --show-current`. Use `date -u +"%Y-%m-%dT%H:%M:%SZ"` instead of `date -Is`. Use `head -n 1` instead of `head -1`. Add a TypeScript `getCurrentBranch` helper and a shell `iso_now()` helper function.

---

### File: `extensions/side-agents/tmux.ts`

**In `buildLaunchScript`, add `iso_now()` helper and update `write_exit` (~line 172):**

```typescript
// CURRENT (lines 170–175):
write_exit() {
  local code="$1"
  printf '{"exitCode":%d,"finishedAt":"%s"}\n' "$code" "$(date -Is)" > "$EXIT_FILE"
}

// REPLACE lines 170–175 WITH:
iso_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

write_exit() {
  local code="$1"
  printf '{"exitCode":%d,"finishedAt":"%s"}\n' "$code" "$(iso_now)" > "$EXIT_FILE"
}
```

---

### File: `extensions/side-agents/worktree.ts`

**Commit 13 — portability: Add `loadRegistry` to the `./registry.js` import (line 19):**

```typescript
// CURRENT (line 19):
import {
    isTerminalStatus,
} from "./registry.js";

// REPLACE WITH:
import {
    isTerminalStatus,
    loadRegistry,
} from "./registry.js";
```

**Commit 13 — portability: Replace `git branch --show-current` with `getCurrentBranch` helper (~line 269):**

```typescript
// CURRENT (lines 269–276):
        // Remember old branch so we can try to clean it up after switching away.
        const oldBranchResult = run("git", [
            "-C",
            chosenPath,
            "branch",
            "--show-current",
        ], gitRunOpts);
        const oldBranch = oldBranchResult.ok ? oldBranchResult.stdout.trim() : "";

// REPLACE lines 269–276 WITH:
        // Remember old branch so we can try to clean it up after switching away.
        const getCurrentBranch = (cwd: string): string => {
            const result = run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], gitRunOpts);
            if (!result.ok) return "";
            const branch = result.stdout.trim();
            if (!branch || branch === "HEAD") return "";
            return branch;
        };

        const oldBranch = getCurrentBranch(chosenPath);
```

**Commit 12 — double-allocation guard: Add registry-based check in `allocateWorktree` after the `isRegistered` block (~line 300).**

Note: This fork's `allocateWorktree` uses `mkdtemp` directly (no slots loop) and doesn't receive `registry` as a parameter, so we load it internally:

```typescript
// CURRENT (lines 298–300):
    }

    await ensureDir(join(chosenPath, ".pi"));

// REPLACE lines 298–300 WITH:
    }

    // Guard against double-allocation: if the registry already tracks an active
    // agent on this path (even if the lock file is missing), warn and continue.
    const resolvedChosenPath = resolve(chosenPath);
    try {
        const registry = await loadRegistry(options.stateRoot);
        for (const record of Object.values(registry.agents)) {
            if (
                record.id !== agentId &&
                record.worktreePath &&
                !isTerminalStatus(record.status) &&
                resolve(record.worktreePath) === resolvedChosenPath
            ) {
                warnings.push(
                    `Worktree already claimed by active agent '${record.id}' in registry (missing lock?): ${chosenPath}`,
                );
                break;
            }
        }
    } catch {
        // If we can't load the registry, skip the double-allocation check.
    }

    await ensureDir(join(chosenPath, ".pi"));
```

---

### File: `skills/agent-setup/SKILL.md`

**Five changes to the embedded shell script content:**

#### Change 1 — Start script branch detection (~line 69)

```bash
# CURRENT (line ~69):
BRANCH="$(git -C "$WORKTREE" branch --show-current 2>/dev/null || true)"
if [[ -z "$BRANCH" ]]; then
  echo "[side-agent-start] Could not determine current branch in $WORKTREE."
  exit 1
fi

# REPLACE WITH:
BRANCH="$(git -C "$WORKTREE" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ -z "$BRANCH" ]] || [[ "$BRANCH" == "HEAD" ]]; then
  echo "[side-agent-start] Could not determine current branch in $WORKTREE."
  exit 1
fi
```

#### Change 2 — Finish script branch detection (~line 128)

```bash
# CURRENT (line ~128):
BRANCH="$(git branch --show-current)"

# REPLACE WITH:
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ "$BRANCH" == "HEAD" ]]; then
  BRANCH=""
fi
```

#### Change 3 — Finish script `iso_now` helper + use in `acquire_lock` payload (~line 149)

```bash
# CURRENT (line ~149, inside acquire_lock function):
  payload="{\"agentId\":\"$AGENT_ID\",\"pid\":$$,\"acquiredAt\":\"$(date -Is)\"}"

# REPLACE with (add iso_now helper near top of script, then update the payload):
iso_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}
# ... then in acquire_lock:
  payload="{\"agentId\":\"$AGENT_ID\",\"pid\":$$,\"acquiredAt\":\"$(iso_now)\"}"
```

#### Change 4 — `head -1` → `head -n 1` (~line 160)

```bash
# CURRENT (line ~160):
      holder_pid="$(grep -o '"pid":[0-9]*' "$LOCK_FILE" 2>/dev/null | head -1 | grep -o '[0-9]*' || true)"

# REPLACE WITH:
      holder_pid="$(grep -o '"pid":[0-9]*' "$LOCK_FILE" 2>/dev/null | head -n 1 | grep -o '[0-9]*' || true)"
```

#### Change 5 — Push script branch detection (~line 225)

Same as Change 2 (PR policy finish script uses `git branch --show-current`).

---

### File: `tests/integration/side-agents.integration.test.mjs`

**One change in the embedded finish script string literal (~lines 1443–1463).** This embedded script appears in the `merge-lock serialization` integration test (starting ~line 1405).

```javascript
// CURRENT (inside the embedded finishScript string, ~lines 1443–1463):
BRANCH="$(git branch --show-current)"
// ...
payload="{"agentId":"$AGENT_ID","pid":$$,"acquiredAt":"$(date -Is)"}"

// REPLACE WITH:
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ "$BRANCH" == "HEAD" ]]; then
  BRANCH=""
fi
// ...
payload="{"agentId":"$AGENT_ID","pid":$$,"acquiredAt":"$(date -u +"%Y-%m-%dT%H:%M:%SZ")"}"
```

Note: This embedded script is inside a JavaScript template literal, so `$` characters must be escaped as `$$` and template expressions like `$(date ...)` must use the `$$(date ...)` form, or be carefully managed to avoid unintended interpolation. The `iso_now()` helper approach may be cleaner — define it in the script body and call it in the payload.

---

## Summary: Files to Edit

| File | Commits | Key changes |
|---|---|---|
| `extensions/side-agents/tmux.ts` | 2, 4, 13 | Add `tmuxWaitForShellReady`; `source` vs `"$START_SCRIPT"`; `iso_now()` + `date -u` |
| `extensions/side-agents/agent.ts` | 2, 3, 5, 11 | Import `tmuxWaitForShellReady`; early return in `refreshAllAgents`; modes.json helpers + `resolveModelSpecForChild` sig; `agentId` guard on lock cleanup; remove lock cleanup from crashed path |
| `extensions/side-agents/worktree.ts` | 11, 12, 13 | `agentId` param + guard in `cleanupWorktreeLockBestEffort`; registry-based double-allocation check + `getCurrentBranch` helper |
| `extensions/side-agents/index.ts` | 11 | Import `cleanupWorktreeLockBestEffort`; release locks on explicit failed-agent cleanup |
| `skills/agent-setup/SKILL.md` | 13 | `git rev-parse --abbrev-ref`; `date -u`; `head -n` |
| `tests/integration/side-agents.integration.test.mjs` | 13 | Portability in embedded finish script |
