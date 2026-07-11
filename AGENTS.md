# AGENTS quick context

- Package: `pi-side-agents` (Pi extension + skill for parallel child-agent orchestration).
- Core code: `extensions/side-agents.ts`; setup skill: `skills/agent-setup/SKILL.md`.
- Public contract to preserve: `/agent`, `/agents`, tools `sideagent-start`, `sideagent-check`, `sideagent-wait-any`, `sideagent-send`.
- Runtime assumptions: `tmux` + git worktrees; shared registry at `.pi/side-agents/registry.json`.
- Validation: `bun test` (unit tests only).
- Always commit completed work before reporting the task done.
