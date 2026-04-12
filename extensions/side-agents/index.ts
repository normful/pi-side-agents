import { basename } from "node:path";
import { existsSync } from "node:fs";
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
import { json, run, stringifyError } from "./utils.js";
import {
	reclaimOrphanWorktreeLocks,
	scanOrphanWorktreeLocks,
} from "./worktree.js";

// Track which tools have been dynamically registered
const registeredSideAgentTools = new Set<string>();

function resolveGitRoot(cwd: string): string {
	const result = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
	if (result.ok) {
		const root = result.stdout.trim();
		if (root.length > 0) return root;
	}
	return cwd;
}

function registerSideAgentTools(pi: ExtensionAPI): void {
	if (registeredSideAgentTools.has("agent-start")) {
		return; // already registered
	}

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
					"Kebab-case identifier. Avoid generic prefixes (task, feat, fix, feature). Be specific and descriptive (e.g. refresh-oauth-tokens, dashboard-load-optimization)",
			}),
			model: Type.Optional(
				Type.String({ description: "Model as provider/modelId (optional)" }),
			),
			safe: Type.Optional(
				Type.Boolean({
					description:
						"Run with CCO filesystem sandbox (default: true). Set false for unsandboxed execution.",
				}),
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
					...(params.safe !== undefined ? { safe: params.safe } : {}),
				});
				return {
					content: [
						{
							type: "text",
							text: json({
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
							}),
						},
					],
					details: undefined,
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: json({ ok: false, error: stringifyError(err) }),
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
					content: [{ type: "text", text: json(payload) }],
					details: undefined,
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: json({ ok: false, error: stringifyError(err) }),
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
					content: [{ type: "text", text: json(payload) }],
					details: undefined,
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: json({ ok: false, error: stringifyError(err) }),
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
			"Send text to a background agent's tmux pane. For immediate interruption or forced commands, prefix prompt with: '!' to interrupt first, '/' for slash commands (e.g. '/quit' to terminate)",
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
					content: [{ type: "text", text: json(payload) }],
					details: undefined,
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: json({ ok: false, error: stringifyError(err) }),
						},
					],
					details: undefined,
				};
			}
		},
	});

	registeredSideAgentTools.add("agent-start");
	registeredSideAgentTools.add("agent-check");
	registeredSideAgentTools.add("agent-wait-any");
	registeredSideAgentTools.add("agent-send");
}

export default function sideAgentsExtension(pi: ExtensionAPI) {
	// Auto-register side-agent tools if the autoload trigger file exists
	if (existsSync("/tmp/autoload-pi-side-agent-tools")) {
		registerSideAgentTools(pi);
	}
	pi.registerCommand("safe-agent", {
		description:
			"Spawn a sandboxed child agent (uses CCO): /safe-agent [-model <provider/id>] <task>",
		handler: async (args, ctx) => {
			const parsed = parseAgentCommandArgs(args);
			if (!parsed.task) {
				ctx.hasUI &&
					ctx.ui.notify("Usage: /safe-agent [-model <provider/id>] <task>", "error");
				return;
			}

			try {
				ctx.hasUI && ctx.ui.notify("Starting sandboxed side-agent…", "info");
				const started = await startAgent(pi, ctx, {
					task: parsed.task,
					...(parsed.model ? { model: parsed.model } : {}),
					includeSummary: true,
					safe: true,
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
				renderInfoMessage(pi, ctx, "side-agent started (sandboxed)", lines);
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

	pi.registerCommand("unsafe-agent", {
		description:
			"Spawn an unsandboxed child agent (runs Pi directly): /unsafe-agent [-model <provider/id>] <task>",
		handler: async (args, ctx) => {
			const parsed = parseAgentCommandArgs(args);
			if (!parsed.task) {
				ctx.hasUI &&
					ctx.ui.notify("Usage: /unsafe-agent [-model <provider/id>] <task>", "error");
				return;
			}

			try {
				ctx.hasUI && ctx.ui.notify("Starting unsandboxed side-agent…", "info");
				const started = await startAgent(pi, ctx, {
					task: parsed.task,
					...(parsed.model ? { model: parsed.model } : {}),
					includeSummary: true,
					safe: false,
				});

				const lines = [
					`id: ${started.id}`,
					`tmux window: ${started.tmuxWindowId} (#${started.tmuxWindowIndex})`,
					`worktree: ${started.worktreePath}`,
					`branch: ${started.branch}`,
					`WARNING: Agent is running unsandboxed (no CCO)`,
				];
				for (const warning of started.warnings) {
					lines.push(`warning: ${warning}`);
				}
				lines.push("", "prompt:");
				for (const line of started.prompt.split(/\r?\n/)) {
					lines.push(`  ${line}`);
				}
				renderInfoMessage(pi, ctx, "side-agent started (unsandboxed)", lines);
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

	pi.registerCommand("load-side-agents-tools", {
		description:
			"Register side-agent tools (agent-start, agent-check, agent-wait-any, agent-send)",
		handler: async (_args, ctx) => {
			if (registeredSideAgentTools.has("agent-start")) {
				ctx.hasUI && ctx.ui.notify("Side-agent tools already loaded.", "info");
				return;
			}
			registerSideAgentTools(pi);
			ctx.hasUI && ctx.ui.notify("Side-agent tools registered.", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
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

