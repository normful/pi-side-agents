# side-agents refactor: file layout

## Dependency graph

```
extension.ts
  └── agent.ts
        ├── tmux.ts ───────────────────────────────────────┐
        ├── fs.ts ──────────────────────────────────────────┤
        ├── slug.ts ────────────────────────────────────────┤
        ├── worktree.ts ────────────────────────────────────┤
        │     └── slug.ts ──────────────────────────────────┤
        ├── prompt.ts ──────────────────────────────────────┤
        │     └── registry.ts ──────────────────────────────┤
        │           └── fs.ts ──────────────────────────────┤
        └── registry.ts ────────────────────────────────────┤
              └── fs.ts ────────────────────────────────────┤
                                              utils.ts ─────┘

prompt.ts ──→ registry.ts
slug.ts ──→ utils.ts, registry.ts
fs.ts ──→ utils.ts
```

**No circular dependencies.** `tmuxWindowExists` lives in `utils.ts` to break the
`worktree → tmux → worktree` cycle. `getStateRoot` lives in `registry.ts`.

---

## File contents

### `constants.ts`

All env vars, status arrays, message type constants, prompt templates, regex
patterns, and numeric limits.

---

### `utils.ts`

Pure utility functions. **No internal project imports** (only Node built-ins).
Imports `ALL_AGENT_STATUSES`, `DEFAULT_WAIT_STATES` from `constants.ts`.

- `nowIso()`
- `sleep(ms)`
- `stringifyError(err)`
- `shellQuote(value)`
- `truncateWithEllipsis(text, maxChars)`
- `stripTerminalNoise(text)`
- `splitLines(text)`
- `isBacklogSeparatorLine(line)`
- `normalizeWaitStates(input?)` → `{ values: AgentStatus[], error?: string }`
- `tailLines(text, count)`
- `run(command, args, options?)` → `CommandResult`
- `runOrThrow(command, args, options?)` → `CommandResult`
- `tmuxWindowExists(windowId)` — lives here to avoid circular deps

`CommandResult` type defined here (imported by `tmux.ts`, `worktree.ts`, `slug.ts`,
`registry.ts`).

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

Slug generation + worktree slot/orphan lock types. Imports `utils.ts` (for
`CommandResult`, `run`, `runOrThrow`) and `registry.ts` (for `ExtensionContext`,
`RegistryFile` types).

Types: `WorktreeSlot`, `OrphanWorktreeLock`, `OrphanWorktreeLockScan`.

- `sanitizeSlug(raw)`
- `slugFromTask(task)`
- `generateSlug(ctx, task)` → `{ slug, warning? }`
- `deduplicateSlug(slug, existing)`
- `existingAgentIds(registry, repoRoot)`
- `listWorktreeSlots(repoRoot)` → `WorktreeSlot[]`
- `parseOptionalPid(value)`
- `isPidAlive(pid?)`

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
- `resolveBacklogPathForRecord(stateRoot, record)`
- `appendKickoffPromptToBacklog(stateRoot, record, prompt, loggedAt?)`
- `buildKickoffPrompt(ctx, task, includeSummary)` → `{ prompt, warning? }`
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

> **Dead code deleted:** `tmuxCaptureTail` was defined in `index.ts` but never
> called. It is not included in any module.

---

### `registry.ts`

Agent types, registry file helpers, status helpers, and path utilities. Imports
`fs.ts`. **`getStateRoot` lives here.** Imports `CommandResult` from `utils.ts`
for internal use.

Types: `AgentStatus`, `AgentRecord`, `RegistryFile`, `StartAgentParams`,
`StartAgentResult`, `AllocateWorktreeResult`, `PrepareRuntimeDirResult`,
`ExitMarker`. (Re-exported from `utils.ts`: `CommandResult`.)

- `emptyRegistry()` → `RegistryFile`
- `loadRegistry(stateRoot)` → `RegistryFile`
- `saveRegistry(stateRoot, registry)`
- `mutateRegistry(stateRoot, mutator)` → `RegistryFile`
- `isTerminalStatus(status)` → `boolean`
- `setRecordStatus(stateRoot, record, nextStatus)` → `boolean`
- **`getStateRoot(ctx)`** → `string` **(moved from index.ts)**
- `getMetaDir(stateRoot)` → `string`
- `getRegistryPath(stateRoot)` → `string`
- `getRuntimeDir(stateRoot, agentId)` → `string`
- `getRuntimeArchiveBaseDir(stateRoot, agentId)` → `string`
- `runtimeArchiveStamp()` → `string`
- `prepareFreshRuntimeDir(stateRoot, agentId)` → `PrepareRuntimeDirResult`

---

### `agent.ts`

Agent lifecycle, status helpers, and rendering. Imports `registry.ts`, `tmux.ts`,
`fs.ts`, `slug.ts`, `worktree.ts`, `prompt.ts`. Re-imports `StartAgentParams`,
`StartAgentResult` from `registry.ts`.

Types: `AgentStatusSnapshot`, `StatusTransitionNotice`, `RefreshRuntimeResult`.

**Display/type helpers:**

- `summarizeOrphanLock(lock)` → `string`
- `statusShort(status)` → `string`
- `statusColorRole(status)` → `"warning" | "muted" | "accent" | "error"`

**Command / tool argument parsing:**

- `normalizeAgentId(raw)` → `string`
- `parseAgentCommandArgs(raw)` → `{ task, model? }`
- `splitModelPatternAndThinking(raw)` → `{ pattern, thinking? }`
- `withThinking(modelSpec, thinking?)` → `string`
- `resolveModelSpecForChild(ctx, requested?)` → `{ modelSpec?, warning? }`

**Runtime refresh:**

- `refreshOneAgentRuntime(stateRoot, record)` → `RefreshRuntimeResult`
- `refreshAgent(stateRoot, agentId)` → `AgentRecord | undefined`
- `refreshAllAgents(stateRoot)` → `RegistryFile`
- `getBacklogTail(record, lines?)` → `string[]`

**Agent lifecycle:**

- `startAgent(pi, ctx, params)` → `StartAgentResult`
- `sendToAgent(stateRoot, agentId, prompt)` → `{ ok, message }`
- `waitForAny(stateRoot, ids, signal?, waitStatesInput?)` → `Record`
- `setChildRuntimeStatus(ctx, nextStatus)`
- `ensureChildSessionLinked(pi, ctx)`
- `isChildRuntime()` → `boolean`

**Child-session rendering:**

- `renderInfoMessage(pi, ctx, title, lines)`
- `collectStatusTransitions(stateRoot, agents)` → `StatusTransitionNotice[]`
- `formatStatusWord(status, theme?)` → `string`
- `formatLabelPrefix(prefix, theme?)` → `string`
- `formatStatusTransitionMessage(transition, theme?)` → `string`
- `emitStatusTransitions(pi, ctx, transitions)`
- `emitKickoffPromptMessage(pi, started)`
- `renderStatusLine(pi, ctx, options?)`
- `ensureStatusPoller(pi, ctx)`

**Theme foreground type** (used by `formatStatusWord`, `formatLabelPrefix`,
`formatStatusTransitionMessage`):

```ts
type ThemeForeground = {
  fg: (role: "warning" | "muted" | "accent" | "error", text: string) => string;
};
```

**Behavioral invariants:**

- The `agent-start` tool handler truncates `params.description` to 200 chars
  with ellipsis. The returned `task` field therefore obeys this bound.

Module-level mutable state (`statusPollTimer`, `statusPollContext`,
`statusPollApi`, `statusPollInFlight`, `statusSnapshotsByStateRoot`,
`lastRenderedStatusLine`) lives here.

---

### `extension.ts`

Extension registration only. Imports `agent.ts`.

- `sideAgentsExtension(pi)` — registers all commands, tools, and event handlers;
  contains no business logic.

---

### `index.ts`

Re-exports the default export only:

```ts
import sideAgentsExtension from "./extension.js";
export default sideAgentsExtension;
```

---

## Test migration strategy

### Integration tests (`tests/integration/side-agents.integration.test.mjs`)

The integration tests import the extension source via a shim file written by
`createHarness` to `repo/.pi/extensions/side-agents.ts`:

```ts
// repo/.pi/extensions/side-agents.ts  (written by createHarness)
export { default } from "../../../extensions/side-agents/index.ts";
```

After the refactor, `index.ts` re-exports from `extension.js` as planned. The
shim and all paths through it continue to work without modification. No
integration test changes are needed.

If the `EXTENSION_SOURCE` constant is ever updated, point it at
`extensions/side-agents/extension.ts` instead — both paths are equivalent.

All test assertions (registry shapes, tmux window IDs, worktree paths, backlog
content, session JSONL tool-result payloads) are behavioral and unchanged.

### Unit tests (`tests/unit/tool-contract.test.mjs`)

**Phase 1 — During refactor**: Tests use standalone JS re-implementations with
no TS imports at all. No changes needed.

**Phase 2 — Post-refactor** (follow-up cleanup): Create
`tests/unit/helpers.mjs` that imports and re-exports the pure, side-effect-free
functions from the refactored modules' compiled `.js` output:

```js
// tests/unit/helpers.mjs
import { isTerminalStatus } from "../extensions/side-agents/registry.js";
import { normalizeWaitStates } from "../extensions/side-agents/utils.js";
import { sanitizeSlug, slugFromTask, deduplicateSlug } from "../extensions/side-agents/slug.js";
import { collectStatusTransitions } from "../extensions/side-agents/agent.js";
import { sanitizeBacklogLines, selectBacklogTailLines } from "../extensions/side-agents/prompt.js";
import { summarizeTask } from "../extensions/side-agents/prompt.js";
import { cleanupWorktreeLockBestEffort } from "../extensions/side-agents/worktree.js";
// ... re-export everything inline helpers currently cover
export { isTerminalStatus, normalizeWaitStates, sanitizeSlug, slugFromTask, deduplicateSlug, collectStatusTransitions, sanitizeBacklogLines, selectBacklogTailLines, summarizeTask, cleanupWorktreeLockBestEffort, /* etc. */ };
```

Migrate the unit tests' inline re-implementations → `helpers.mjs` imports as a
post-refactor follow-up. The `waitForAnyFirstPass` helper (reads a real temp
registry JSON) works unchanged — it operates on file-system state, not module
internals.

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

TypeScript compiles `.ts` to `.js`. At runtime the `.js` files exist next to the
`.ts` files, so the `.js` import paths resolve correctly.
