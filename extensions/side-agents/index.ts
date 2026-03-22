import { basename } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	agentCheckPayload,
	ensureChildSessionLinked,
	ensureStatusPoller,
	formatLabelPrefix,
	formatStatusWord,
	parseAgentCommandArgs,
	renderInfoMessage,
	renderStatusLine,
	sendToAgent,
	setChildRuntimeStatus,
	setStatusPollContext,
	startAgent,
	summarizeTask,
	waitForAny,
} from "./agent.js";
import { getStateRoot, mutateRegistry } from "./registry.js";
import { summarizeOrphanLock } from "./slug.js";
import { run, stringifyError } from "./utils.js";
import {
	reclaimOrphanWorktreeLocks,
	scanOrphanWorktreeLocks,
} from "./worktree.js";

function resolveGitRoot(cwd: string): string {
	const result = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
	if (result.ok) {
		const root = result.stdout.trim();
		if (root.length > 0) return root;
	}
	return cwd;
}

export default function sideAgentsExtension(pi: ExtensionAPI) {
	pi.registerCommand("agent", {
		description:
			"Spawn a background child agent in its own tmux window/worktree: /agent [-model <provider/id>] <task>",
		handler: async (args, ctx) => {
			const parsed = parseAgentCommandArgs(args);
			if (!parsed.task) {
				ctx.hasUI &&
					ctx.ui.notify("Usage: /agent [-model <provider/id>] <task>", "error");
				return;
			}

			try {
				ctx.hasUI && ctx.ui.notify("Starting side-agent…", "info");
				const started = await startAgent(pi, ctx, {
					task: parsed.task,
					...(parsed.model ? { model: parsed.model } : {}),
					includeSummary: true,
				});

				const lines = [
					`id: ${started.id}`,
					`tmux window: ${started.tmuxWindowId} (#${started.tmuxWindowIndex})`,
					`worktree: ${started.worktreePath}`,
					`branch: ${started.branch}`,
				];
				for (const warning of started.warnings) {
					lines.push(`warning: ${warning}`);
				}
				lines.push("", "prompt:");
				for (const line of started.prompt.split(/\r?\n/)) {
					lines.push(`  ${line}`);
				}
				renderInfoMessage(pi, ctx, "side-agent started", lines);
				await renderStatusLine(pi, ctx).catch(() => {});
			} catch (err) {
				ctx.hasUI &&
					ctx.ui.notify(
						`Failed to start agent: ${stringifyError(err)}`,
						"error",
					);
			}
		},
	});

	pi.registerCommand("agents", {
		description: "List tracked side agents",
		handler: async (_args, ctx) => {
			const stateRoot = getStateRoot(ctx);
			const repoRoot = resolveGitRoot(stateRoot);
			let registry = await (async () => {
				const { refreshAllAgents } = await import("./agent.js");
				return refreshAllAgents(stateRoot);
			})();
			const records = Object.values(registry.agents).sort((a, b) =>
				a.id.localeCompare(b.id),
			);
			let orphanLocks = await scanOrphanWorktreeLocks(repoRoot, registry);

			if (
				records.length === 0 &&
				orphanLocks.reclaimable.length === 0 &&
				orphanLocks.blocked.length === 0
			) {
				ctx.hasUI && ctx.ui.notify("No tracked side agents yet.", "info");
				return;
			}

			const lines: string[] = [];
			const failedIds: string[] = [];

			if (records.length === 0) {
				lines.push("(no tracked agents)");
			} else {
				const theme = ctx.hasUI ? ctx.ui.theme : undefined;
				for (const [index, record] of records.entries()) {
					const win =
						record.tmuxWindowIndex !== undefined
							? `#${record.tmuxWindowIndex}`
							: "-";
					const worktreeName = record.worktreePath
						? basename(record.worktreePath) || record.worktreePath
						: "-";
					const statusWord = formatStatusWord(record.status, theme);
					const winPrefix = formatLabelPrefix("win:", theme);
					const worktreePrefix = formatLabelPrefix("worktree:", theme);
					const taskPrefix = formatLabelPrefix("task:", theme);
					lines.push(
						`${record.id}  ${statusWord}  ${winPrefix}${win}  ${worktreePrefix}${worktreeName}`,
					);
					lines.push(`  ${taskPrefix} ${summarizeTask(record.task)}`);
					if (record.error) lines.push(`  error: ${record.error}`);
					if (record.status === "failed" || record.status === "crashed") {
						failedIds.push(record.id);
					}
					if (index < records.length - 1) {
						lines.push("");
					}
				}
			}

			if (
				orphanLocks.reclaimable.length > 0 ||
				orphanLocks.blocked.length > 0
			) {
				if (lines.length > 0) lines.push("");
				lines.push("orphan worktree locks:");
				for (const lock of orphanLocks.reclaimable) {
					lines.push(`  reclaimable: ${summarizeOrphanLock(lock)}`);
				}
				for (const lock of orphanLocks.blocked) {
					lines.push(
						`  blocked: ${summarizeOrphanLock(lock)} (${lock.blockers.join("; ")})`,
					);
				}
			}

			renderInfoMessage(pi, ctx, "side-agents", lines);

			if (failedIds.length > 0 && ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Clean up failed agents?",
					`Remove ${failedIds.length} failed/crashed agent(s) from registry: ${failedIds.join(", ")}`,
				);
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
			}

			orphanLocks = await scanOrphanWorktreeLocks(repoRoot, registry);

			if (orphanLocks.reclaimable.length > 0 && ctx.hasUI) {
				const preview = orphanLocks.reclaimable
					.slice(0, 6)
					.map((lock) => `- ${summarizeOrphanLock(lock)}`);
				if (orphanLocks.reclaimable.length > preview.length) {
					preview.push(
						`- ... and ${orphanLocks.reclaimable.length - preview.length} more`,
					);
				}

				const confirmed = await ctx.ui.confirm(
					"Reclaim orphan worktree locks?",
					[
						`Remove ${orphanLocks.reclaimable.length} orphan worktree lock(s)?`,
						"Only lock files with no tracked registry agent and no live pid/tmux signal are included.",
						"",
						...preview,
					].join("\n"),
				);
				if (confirmed) {
					const reclaimed = await reclaimOrphanWorktreeLocks(
						orphanLocks.reclaimable,
					);
					if (reclaimed.failed.length === 0) {
						ctx.ui.notify(
							`Reclaimed ${reclaimed.removed.length} orphan worktree lock(s).`,
							"info",
						);
					} else {
						ctx.ui.notify(
							`Reclaimed ${reclaimed.removed.length} orphan lock(s); failed ${reclaimed.failed.length}.`,
							"warning",
						);
					}
				}
			}

			if (orphanLocks.blocked.length > 0 && ctx.hasUI) {
				ctx.ui.notify(
					`Found ${orphanLocks.blocked.length} orphan lock(s) that look live; leaving them untouched.`,
					"warning",
				);
			}
		},
	});

	pi.registerTool({
		name: "agent-start",
		label: "Agent Start",
		description:
			"Start a background coding AI agent. The agent yields (waiting_user) when completes or it needs input. Returns agent metadata including id, tmuxWindowId, worktreePath, and branch. The agent's work is committed to a branch in its git worktree",
		parameters: Type.Object({
			description: Type.String({
				description:
					"Task description LLM prompt for child agent. Include necessary context, constraints, and expected outcome. Can reference files using @ syntax",
			}),
			branchHint: Type.String({
				description:
					"Short kebab-case branch slug, max 3 words (e.g. fix-auth-leak)",
			}),
			model: Type.Optional(
				Type.String({ description: "Model as provider/modelId (optional)" }),
			),
		}),
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<unknown>> {
			try {
				const started = await startAgent(pi, ctx, {
					task: params.description,
					branchHint: params.branchHint,
					...(params.model ? { model: params.model } : {}),
					includeSummary: false,
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									ok: true,
									id: started.id,
									task:
										params.description.length > 200
											? `${params.description.slice(0, 200)}...`
											: params.description,
									tmuxWindowId: started.tmuxWindowId,
									tmuxWindowIndex: started.tmuxWindowIndex,
									worktreePath: started.worktreePath,
									branch: started.branch,
									warnings: started.warnings,
								},
								null,
								2,
							),
						},
					],
					details: undefined,
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ ok: false, error: stringifyError(err) },
								null,
								2,
							),
						},
					],
					details: undefined,
				};
			}
		},
	});

	pi.registerTool({
		name: "agent-check",
		label: "Agent Check",
		description:
			"Check background agent's current status and retrieve recent output",
		parameters: Type.Object({
			id: Type.String({ description: "Agent id returned by agent-start" }),
		}),
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<unknown>> {
			try {
				const payload = await agentCheckPayload(getStateRoot(ctx), params.id);
				return {
					content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
					details: undefined,
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ ok: false, error: stringifyError(err) },
								null,
								2,
							),
						},
					],
					details: undefined,
				};
			}
		},
	});

	pi.registerTool({
		name: "agent-wait-any",
		label: "Agent Wait Any",
		description:
			"Block and wait for any background agent to reach a terminal or yielding state. Use after agent-start or agent-send. Returns error if agent ids are unknown or already deleted",
		parameters: Type.Object({
			ids: Type.Array(Type.String({ description: "Agent id" }), {
				description: "Agent ids to wait for",
			}),
		}),
		async execute(
			_toolCallId,
			params,
			signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<unknown>> {
			try {
				const payload = await waitForAny(getStateRoot(ctx), params.ids, signal);
				return {
					content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
					details: undefined,
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ ok: false, error: stringifyError(err) },
								null,
								2,
							),
						},
					],
					details: undefined,
				};
			}
		},
	});

	pi.registerTool({
		name: "agent-send",
		label: "Agent Send",
		description:
			"Send text to a background agent's tmux pane. For immediate interruption or forced commands, prefix prompt with: '!' to interrupt first, '/' for slash commands (e.g. '/quit' to terminate). IMPORTANT: Always append newline character to end of prompt",
		parameters: Type.Object({
			id: Type.String({ description: "Agent id returned by agent-start" }),
			prompt: Type.String({
				description: "",
			}),
		}),
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<unknown>> {
			try {
				const payload = await sendToAgent(
					getStateRoot(ctx),
					params.id,
					params.prompt,
				);
				return {
					content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
					details: undefined,
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ ok: false, error: stringifyError(err) },
								null,
								2,
							),
						},
					],
					details: undefined,
				};
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await ensureChildSessionLinked(pi, ctx).catch(() => {});
		ensureStatusPoller(pi, ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await ensureChildSessionLinked(pi, ctx).catch(() => {});
		ensureStatusPoller(pi, ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		await setChildRuntimeStatus(ctx, "running").catch(() => {});
	});

	pi.on("agent_end", async (_event, ctx) => {
		await setChildRuntimeStatus(ctx, "waiting_user").catch(() => {});
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		setStatusPollContext(pi, ctx);
		await renderStatusLine(pi, ctx, { emitTransitions: false }).catch(() => {});
	});
}
