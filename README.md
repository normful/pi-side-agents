# pi-side-agents

A fork of <https://github.com/pasky/pi-side-agents> with various improvements:
- Split extension code from 1 gigantic file into several smaller files with unit tests.
- Changes to minimize context token usage when launching pi:
    - Dynamic tool registration
    - Concise tool descriptions

## Usage

- Launch tmux
- Launch pi in tmux (i.e. start the parent agent)
- (ONCE PER REPO) Run in parent agent: `/skill:agent-setup` to scaffold project-specific lifecycle scripts (worktree initialization and merge process)
- Run in parent agent: `/load-side-agents-tools`. It registers these tools used by parent agents: `agent-start`, `agent-check`, `agent-wait-any`, `agent-send`
- Run in parent agent `/agent [-model ...] <task>` to spawn a child agent. It will create a new tmux window in the existing tmux session, create a new git worktree and branch.

Later, do one or more of:
- Switch to the other tmux windows and steer the pi sessions manually.
- Run in parent agent: `/agents` to inspect current agents and clean up stale state.
- Ask parent agent to use one of `agent-check`, `agent-wait-any`, `agent-send` to manage the child agents.

Also see further instructions and details in original upstream repo: <https://github.com/pasky/pi-side-agents>
