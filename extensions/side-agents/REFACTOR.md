# side-agents refactor: file layout

## Dependency graph

```
extension.ts
  └── agent.ts
        ├── tmux.ts ───────────────────────────────┐
        ├── fs.ts ─────────────────────────────────┤
        ├── slug.ts ────────────────────────────────┤
        ├── worktree.ts ───────────────────────────┤
        │     └── slug.ts ──────────────────────────┤
        ├── prompt.ts ─────────────────────────────┤
        │     └── registry.ts ─────────────────────┤
        └── registry.ts ───────────────────────────┤
              └── fs.ts ───────────────────────────┤
                                              utils.ts

prompt.ts ──→ registry.ts
slug.ts ──→ utils.ts, registry.ts
fs.ts ──→ utils.ts
```

**No circular dependencies.** `tmuxWindowExists` lives in `utils.ts` to break the
`worktree → tmux → worktree` cycle.

---

## File contents

### `constants.ts`

All env vars, status arrays, message type constants, prompt templates, regex
patterns, and numeric limits.

---

### `utils.ts`

Pure utility functions with no side-agents-specific imports.

- `nowIso()`
- `sleep(ms)`
- `stringifyError(err)`
- `shellQuote(value)`
- `truncateWithEllipsis(text, maxChars)`
- `stripTerminalNoise(text)`
- `splitLines(text)`
- `normalizeWaitStates(input?)`
- `tailLines(text, count)`
- `run(command, args, options?)` → `CommandResult`
- `runOrThrow(command, args, options?)` → `CommandResult`
- `tmuxWindowExists(windowId)` — moved here to avoid circular deps

`CommandResult` type defined here (used by `tmux.ts`, `worktree.ts`, `slug.ts`).

---

### `fs.ts`

Filesystem helpers. Imports `utils.ts`.

- `fileExists(path)`
- `ensureDir(path)`
- `readJsonFile<T>(path)`
- `atomicWrite(path, content)`
- `withFileLock<T>(lockPath, fn)`

---

### `slug.ts`

Slug generation + worktree slot/orphan lock types.

Types: `WorktreeSlot`, `OrphanWorktreeLock`, `OrphanWorkloadLockScan`.

- `sanitizeSlug(raw)`
- `slugFromTask(task)`
- `generateSlug(ctx, task)` → `{ slug, warning? }`
- `deduplicateSlug(slug, existing)`
- `existingAgentIds(registry, repoRoot)`
- `listWorktreeSlots(repoRoot)` → `WorktreeSlot[]`
- `parseOptionalPid(value)`
- `isPidAlive(pid?)`

Imports: `utils.ts`, `registry.ts` (for `ExtensionContext`, `RegistryFile` types).

---

### `worktree.ts`

Worktree lifecycle management. Imports `utils.ts` (for `tmuxWindowExists`,
`runOrThrow`, `run`, `fileExists`, etc.) and `slug.ts` (for `WorktreeSlot`).

- `writeWorktreeLock(worktreePath, payload)`
- `updateWorktreeLock(worktreePath, patch)`
- `cleanupWorktreeLockBestEffort(worktreePath?)`
- `listRegisteredWorktrees(repoRoot)` → `Set<string>`
- `scanOrphanWorktreeLocks(repoRoot, registry)` → `OrphanWorktreeLockScan`
- `reclaimOrphanWorktreeLocks(locks)` → `{ removed, failed }`
- `syncParallelAgentPiFiles(parentRepoRoot, worktreePath)`
- `allocateWorktree(options)` → `AllocateWorktreeResult`

---

### `prompt.ts`

Prompt building and backlog sanitization. Imports `utils.ts` and `registry.ts`
(for `AgentRecord`, `getStateRoot`).

- `normalizeGeneratedSummary(raw)`
- `summarizeTask(task)`
- `buildKickoffPrompt(ctx, task, includeSummary)` → `{ prompt, warning? }`
- `appendKickoffPromptToBacklog(stateRoot, record, prompt, loggedAt?)`
- `resolveBacklogPathForRecord(stateRoot, record)`
- `isBacklogSeparatorLine(line)`
- `collectRecentBacklogLines(lines, minimumLines)`
- `selectBacklogTailLines(text, minimumLines)`
- `sanitizeBacklogLines(lines)`

---

### `tmux.ts`

Tmux operations. Imports `utils.ts`.

- `ensureTmuxReady()`
- `getCurrentTmuxSession()` → `string`
- `createTmuxWindow(tmuxSession, name)` → `{ windowId, windowIndex }`
- `tmuxPipePaneToFile(windowId, logPath)`
- `tmuxSendLine(windowId, line)`
- `tmuxInterrupt(windowId)`
- `tmuxSendPrompt(windowId, prompt)`
- `tmuxCaptureVisible(windowId)` → `string[]`
- `buildLaunchScript(params)` → `string`

---

### `registry.ts`

Agent types, registry file helpers, and status helpers. Imports `fs.ts`.

Types: `AgentStatus`, `AgentRecord`, `RegistryFile`, `AllocateWorktreeResult`,
`StartAgentParams`, `StartAgentResult`, `PrepareRuntimeDirResult`, `ExitMarker`,
`RefreshRuntimeResult`.

- `emptyRegistry()` → `RegistryFile`
- `loadRegistry(stateRoot)` → `RegistryFile`
- `saveRegistry(stateRoot, registry)`
- `mutateRegistry(stateRoot, mutator)` → `RegistryFile`
- `isTerminalStatus(status)` → `boolean`
- `setRecordStatus(stateRoot, record, nextStatus)` → `boolean`
- `getStateRoot(ctx)` → `string`
- `getMetaDir(stateRoot)` → `string`
- `getRegistryPath(stateRoot)` → `string`
- `getRuntimeDir(stateRoot, agentId)` → `string`
- `prepareFreshRuntimeDir(stateRoot, agentId)` → `PrepareRuntimeDirResult`

---

### `agent.ts`

Agent lifecycle, status helpers, and rendering types. Imports `registry.ts`,
`tmux.ts`, `fs.ts`, `slug.ts`, `worktree.ts`, `prompt.ts`.

Types: `StartAgentParams`, `StartAgentResult`, `AgentStatusSnapshot`,
`StatusTransitionNotice`, `RefreshRuntimeResult`.

- `statusShort(status)` → `string`
- `statusColorRole(status)` → `"warning" | "muted" | "accent" | "error"`
- `normalizeAgentId(raw)` → `string`
- `parseAgentCommandArgs(raw)` → `{ task, model? }`
- `splitModelPatternAndThinking(raw)` → `{ pattern, thinking? }`
- `withThinking(modelSpec, thinking?)` → `string`
- `resolveModelSpecForChild(ctx, requested?)` → `{ modelSpec?, warning? }`
- `refreshOneAgentRuntime(stateRoot, record)` → `RefreshRuntimeResult`
- `refreshAgent(stateRoot, agentId)` → `AgentRecord | undefined`
- `refreshAllAgents(stateRoot)` → `RegistryFile`
- `getBacklogTail(record, lines?)` → `string[]`
- `startAgent(pi, ctx, params)` → `StartAgentResult`
- `sendToAgent(stateRoot, agentId, prompt)` → `{ ok, message }`
- `waitForAny(stateRoot, ids, signal?, waitStatesInput?)` → `Record`
- `setChildRuntimeStatus(ctx, nextStatus)`
- `ensureChildSessionLinked(pi, ctx)`
- `isChildRuntime()` → `boolean`
- `renderInfoMessage(pi, ctx, title, lines)`
- `collectStatusTransitions(stateRoot, agents)` → `StatusTransitionNotice[]`
- `formatStatusWord(status, theme?)` → `string`
- `formatLabelPrefix(prefix, theme?)` → `string`
- `formatStatusTransitionMessage(transition, theme?)` → `string`
- `emitStatusTransitions(pi, ctx, transitions)`
- `emitKickoffPromptMessage(pi, started)`
- `renderStatusLine(pi, ctx, options?)`
- `ensureStatusPoller(pi, ctx)`

Module-level mutable state (`statusPollTimer`, `statusPollContext`,
`statusPollApi`, `statusPollInFlight`, `statusSnapshotsByStateRoot`,
`lastRenderedStatusLine`) lives here.

---

### `extension.ts`

Extension registration only. Imports `agent.ts`.

- `sideAgentsExtension(pi)` — registers all commands, tools, and event
  handlers; contains no business logic.

---

### `index.ts`

Re-exports the default export only:

```ts
import sideAgentsExtension from "./extension.js";
export default sideAgentsExtension;
```

---

## Import path convention

All internal imports use the `.js` extension, even though files are `.ts`:

```ts
// e.g. in agent.ts:
import { mutateRegistry } from "./registry.js";
import { tmuxSendPrompt } from "./tmux.js";
```

---

## Build / compile note

TypeScript compiles `.ts` to `.js`. At runtime the `.js` files exist
next to the `.ts` files, so the `.js` import paths resolve correctly.
