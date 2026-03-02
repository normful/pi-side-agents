# pi-parallel-agents

**Code in sprints** (using agents *asynchronously*), **not in a marathon** (*synchronous* task-by-task flow).

Instead of waiting for one backlog item to finish before starting the next, spin tasks out into single-use child agents as soon as they occur to you. Each child runs in its own **tmux window** and **git worktree**, so you can keep shipping in parallel while maintaining isolation. Each child is a one-off and lives and dies with its short topic branch and tmux window - no "teams of long-running agents messaging each other" or "role-based subagents" complexity. The workflow is unified, simple, and deterministic.

This extension automates the complete tmux/worktree/merge lifecycle for you. The parallel agents can also be spawned and controlled by an agent to autonomously orchestrate its own flock of subagents.

**Warning:** You will be building a lot more, which means you may be running out of your context windows, and have to take better care of your wellbeing between the sprints. Also, for the community's sake, please do not be maxing out your Claude subscriptions with Pi - use a Codex model (or APIs) for this by default.

## What it does

- Adds `/agent [-model ...] <task>` to spawn a background child Pi agent.
- Adds `/agents` to inspect current agents and clean up stale state.
- Shows active-agent summary with tmux window numbers in the statusline.
- Includes `agent-setup` skill to scaffold project-specific lifecycle scripts.
- Tracks runtime state in `.pi/parallel-agents/registry.json`.
- Exposes orchestration tools for parent agents:
  - `agent-start`
  - `agent-check`
  - `agent-wait-any`
  - `agent-send`

## Quick start

1. **Run setup once** in your project: `/skill:agent-setup`
   - If you want to change the setup later, or are upgrading this skill and want to get new setup goodies, just re-run the skill with a short prompt.
2. **Spawn asynchronous work items at any point** during your work:
   - `/agent wait, why is weirdMethod doing something-weird?`
   - `/agent -model gpt-5.3-codex add regression tests for auth`
  - Just keep firing up more and more. As a rule of thumb, start all new work via `/agent`. But you can also use this only for e.g. ad hoc side questions.
3. **Check progress and attend** to the baby agents:
   - Check statusline for which agents (id by branch and tmux window) are waiting for you.
   - `/agents` to get a detailed overview of what's being done right now.
   - Steer the waiting children, work with them as normal Pi instances.  Just switch your tmux window.
4. If an agent is done, review its work and once happy, confirm by **LGTM, merge**.
   - Recommended: Write `commit your work when done` in your `AGENTS.md`. (You can always tell the agent to amend.)
   - Quickest way to review: ctrl+z, `git show`, `fg` to go back to the baby agent's Pi.
   - Your main worktree should be in a clean state at this point, do not work in main tree and parallel agents in parallel.
   - You can also tell your Pi to open GitHub PRs instead of merging locally, if that's what you prefer.
5. The agent will merge its work to your main repo. **Just type `/quit` and forget.**
   - Old worktrees are kept around and reused + updated by new agents.
   - Old branches are auto-pruned during reuse by a new agent.
   - You can pause your work on a topic - if you `/quit` before work is merged, the branch will stay around.

## Requirements

- `tmux`
- Git repository (worktrees enabled)
- Pi configured/authenticated

## Development

Run tests:

```bash
npm run test:unit
npm run test:integration
```

## Docs

- Architecture: `docs/architecture.md`
- Recovery/runbooks: `docs/recovery.md`
- Implementation notes: `docs/todo.md`
