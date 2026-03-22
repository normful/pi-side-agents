import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { basename, join } from "node:path";
import { promises as fs } from "node:fs";
import {
	ensureTmuxReady,
	getCurrentTmuxSession,
	createTmuxWindow,
	tmuxPipePaneToFile,
	tmuxSendLine,
	tmuxInterrupt,
	tmuxSendPrompt,
	tmuxCaptureVisible,
	buildLaunchScript,
} from "./tmux.js";
import { ensureDir, fileExists, readJsonFile, atomicWrite } from "./fs.js";
import { run, sleep, stringifyError, tmuxWindowExists } from "./utils.js";
import {
	loadRegistry,
	mutateRegistry,
	setRecordStatus,
	isTerminalStatus,
	prepareFreshRuntimeDir,
	getStateRoot,
	getMetaDir,
	getRuntimeDir,
	type AgentRecord,
	type AgentStatus,
	type StartAgentParams,
	type StartAgentResult,
	type ExitMarker,
} from "./registry.js";
import {
	sanitizeSlug,
	slugFromTask,
	deduplicateSlug,
	existingAgentIds,
	listWorktreeSlots,
} from "./slug.js";
import {
	allocateWorktree,
	updateWorktreeLock,
	cleanupWorktreeLockBestEffort,
} from "./worktree.js";
import {
	appendKickoffPromptToBacklog,
	buildKickoffPrompt,
	sanitizeBacklogLines,
	collectRecentBacklogLines,
	selectBacklogTailLines,
	summarizeTask,
} from "./prompt.js";

const ENV_AGENT_ID = "PI_SIDE_AGENT_ID";
const ENV_PARENT_SESSION = "PI_SIDE_PARENT_SESSION";
const STATUS_KEY = "side-agents";
const CHILD_LINK_ENTRY_TYPE = "side-agent-link";
const STATUS_UPDATE_MESSAGE_TYPE = "side-agent-status";
const PROMPT_UPDATE_MESSAGE_TYPE = "side-agent-prompt";

export type AgentStatusSnapshot = {
	status: AgentStatus;
	tmuxWindowIndex?: number;
};

export type StatusTransitionNotice = {
	id: string;
	fromStatus: AgentStatus;
	toStatus: AgentStatus;
	tmuxWindowIndex?: number;
};

type RefreshRuntimeResult = {
	removeFromRegistry: boolean;
};

// Module-level mutable state
let statusPollTimer: ReturnType<typeof setInterval> | undefined;
let statusPollContext: ExtensionContext | undefined;
let statusPollApi: ExtensionAPI | undefined;
let statusPollInFlight = false;
const statusSnapshotsByStateRoot = new Map<
	string,
	Map<string, AgentStatusSnapshot>
>();
let lastRenderedStatusLine: string | undefined;

const THINKING_LEVELS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

// Display/type helpers

export function statusShort(status: AgentStatus): string {
	switch (status) {
		case "allocating_worktree":
			return "alloc";
		case "spawning_tmux":
			return "tmux";
		case "running":
			return "run";
		case "waiting_user":
			return "wait";
		case "done":
			return "done";
		case "failed":
			return "fail";
		case "crashed":
			return "crash";
	}
}

export function statusColorRole(
	status: AgentStatus,
): "warning" | "muted" | "accent" | "error" {
	switch (status) {
		case "allocating_worktree":
		case "spawning_tmux":
			return "warning";
		case "running":
		case "done":
			return "muted";
		case "waiting_user":
			return "accent";
		case "failed":
		case "crashed":
			return "error";
	}
}

// Command / tool argument parsing

export function parseAgentCommandArgs(raw: string): {
	task: string;
	model?: string;
} {
	let rest = raw;
	let model: string | undefined;

	const modelMatch = rest.match(/(?:^|\s)-model\s+(\S+)/);
	if (modelMatch) {
		model = modelMatch[1];
		rest = rest.replace(modelMatch[0], " ");
	}

	return {
		task: rest.trim(),
		model,
	};
}

export function splitModelPatternAndThinking(raw: string): {
	pattern: string;
	thinking?: string;
} {
	const trimmed = raw.trim();
	const colon = trimmed.lastIndexOf(":");
	if (colon <= 0 || colon === trimmed.length - 1) return { pattern: trimmed };

	const suffix = trimmed.slice(colon + 1);
	if (!THINKING_LEVELS.has(suffix)) return { pattern: trimmed };

	return {
		pattern: trimmed.slice(0, colon),
		thinking: suffix,
	};
}

export function withThinking(modelSpec: string, thinking?: string): string {
	return thinking ? `${modelSpec}:${thinking}` : modelSpec;
}

export function normalizeAgentId(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const firstToken = trimmed.split(/\s+/, 1)[0];
	return firstToken ?? "";
}

// LLM-based slug generation

async function generateSlug(
	ctx: ExtensionContext,
	task: string,
): Promise<{ slug: string; warning?: string }> {
	if (!ctx.model) {
		return {
			slug: slugFromTask(task),
			warning:
				"No model available for slug generation; used heuristic fallback.",
		};
	}

	try {
		const { complete } = await import("@mariozechner/pi-ai");
		const userMessage = {
			role: "user" as const,
			content: [
				{
					type: "text" as const,
					text: task,
				},
			],
			timestamp: Date.now(),
		};

		const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
		const response = await complete(
			ctx.model,
			{
				systemPrompt:
					"Generate a 2-3 word kebab-case slug summarizing the given task. Reply with ONLY the slug, nothing else. Examples: fix-auth-leak, add-retry-logic, update-readme",
				messages: [userMessage],
			},
			{ apiKey, maxTokens: 30 },
		);

		const raw = response.content
			.filter(
				(block): block is { type: "text"; text: string } =>
					block.type === "text",
			)
			.map((block) => block.text)
			.join("")
			.trim();

		const slug = sanitizeSlug(raw);
		if (slug) return { slug };

		return {
			slug: slugFromTask(task),
			warning: "LLM returned empty slug; used heuristic fallback.",
		};
	} catch (err) {
		return {
			slug: slugFromTask(task),
			warning: `Slug generation failed: ${stringifyError(err)}. Used heuristic fallback.`,
		};
	}
}

export async function resolveModelSpecForChild(
	ctx: ExtensionContext,
	requested?: string,
): Promise<{ modelSpec?: string; warning?: string }> {
	const currentModelSpec = ctx.model
		? `${ctx.model.provider}/${ctx.model.id}`
		: undefined;
	if (!requested || requested.trim().length === 0) {
		return { modelSpec: currentModelSpec };
	}

	const trimmed = requested.trim();
	if (trimmed.includes("/")) {
		return { modelSpec: trimmed };
	}

	const { pattern, thinking } = splitModelPatternAndThinking(trimmed);

	if (ctx.model && pattern === ctx.model.id) {
		return {
			modelSpec: withThinking(
				`${ctx.model.provider}/${ctx.model.id}`,
				thinking,
			),
		};
	}

	try {
		const available = (await ctx.modelRegistry.getAvailable()) as Array<{
			provider: string;
			id: string;
		}>;
		const exact = available.filter((model) => model.id === pattern);

		if (exact.length === 1) {
			const match = exact[0];
			return {
				modelSpec: withThinking(`${match.provider}/${match.id}`, thinking),
			};
		}

		if (exact.length > 1) {
			if (ctx.model) {
				const preferred = exact.find(
					(model) => model.provider === ctx.model?.provider,
				);
				if (preferred) {
					return {
						modelSpec: withThinking(
							`${preferred.provider}/${preferred.id}`,
							thinking,
						),
					};
				}
			}

			const providers = [
				...new Set(exact.map((model) => model.provider)),
			].sort();
			return {
				modelSpec: trimmed,
				warning: `Model '${pattern}' matches multiple providers (${providers.join(", ")}); child was started with raw pattern '${trimmed}'. Use provider/model to force a specific provider.`,
			};
		}
	} catch {
		// Best effort only; keep raw model pattern.
	}

	return { modelSpec: trimmed };
}

// Runtime refresh

async function refreshOneAgentRuntime(
	stateRoot: string,
	record: AgentRecord,
): Promise<RefreshRuntimeResult> {
	if (record.status === "done") {
		await cleanupWorktreeLockBestEffort(record.worktreePath);
		return { removeFromRegistry: true };
	}

	if (record.exitFile && (await fileExists(record.exitFile))) {
		const exit = (await readJsonFile<ExitMarker>(record.exitFile)) ?? {};
		if (typeof exit.exitCode === "number") {
			record.exitCode = exit.exitCode;
			record.finishedAt =
				exit.finishedAt ?? record.finishedAt ?? new Date().toISOString();
			const changed = await setRecordStatus(
				stateRoot,
				record,
				exit.exitCode === 0 ? "done" : "failed",
			);
			if (!changed) {
				record.updatedAt = new Date().toISOString();
			}
			await cleanupWorktreeLockBestEffort(record.worktreePath);
			if (exit.exitCode === 0) {
				return { removeFromRegistry: true };
			}
			return { removeFromRegistry: false };
		}
	}

	if (!record.tmuxWindowId) {
		return { removeFromRegistry: false };
	}

	const live = tmuxWindowExists(record.tmuxWindowId);
	if (live) {
		if (
			record.status === "allocating_worktree" ||
			record.status === "spawning_tmux"
		) {
			await setRecordStatus(stateRoot, record, "running");
		}
		return { removeFromRegistry: false };
	}

	if (!isTerminalStatus(record.status)) {
		record.finishedAt = record.finishedAt ?? new Date().toISOString();
		await setRecordStatus(stateRoot, record, "crashed");
		if (!record.error) {
			record.error =
				"tmux window disappeared before an exit marker was recorded";
		}
		await cleanupWorktreeLockBestEffort(record.worktreePath);
	}

	return { removeFromRegistry: false };
}

export async function refreshAgent(
	stateRoot: string,
	agentId: string,
): Promise<AgentRecord | undefined> {
	let snapshot: AgentRecord | undefined;
	await mutateRegistry(stateRoot, async (registry) => {
		const record = registry.agents[agentId];
		if (!record) return;
		const refreshed = await refreshOneAgentRuntime(stateRoot, record);
		if (refreshed.removeFromRegistry) {
			delete registry.agents[agentId];
			return;
		}
		snapshot = JSON.parse(JSON.stringify(record)) as AgentRecord;
	});
	return snapshot;
}

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

export async function getBacklogTail(
	record: AgentRecord,
	lines = 10,
): Promise<string[]> {
	// Prefer the visible tmux pane
	if (record.tmuxWindowId && tmuxWindowExists(record.tmuxWindowId)) {
		const visible = tmuxCaptureVisible(record.tmuxWindowId);
		const result = sanitizeBacklogLines(
			collectRecentBacklogLines(visible, lines),
		);
		if (result.length > 0) return result;
	}

	// Fall back to the backlog log file
	if (record.logPath && (await fileExists(record.logPath))) {
		try {
			const raw = await fs.readFile(record.logPath, "utf8");
			const tailed = sanitizeBacklogLines(selectBacklogTailLines(raw, lines));
			if (tailed.length > 0) return tailed;
		} catch {
			// fall through
		}
	}

	return [];
}

// Agent lifecycle

export async function startAgent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: StartAgentParams,
): Promise<StartAgentResult> {
	ensureTmuxReady();

	const stateRoot = getStateRoot(ctx);
	const repoRoot = (() => {
		const result = run("git", [
			"-C",
			stateRoot,
			"rev-parse",
			"--show-toplevel",
		]);
		if (result.ok) {
			const root = result.stdout.trim();
			if (root.length > 0) return root;
		}
		return stateRoot;
	})();
	const parentSessionId = ctx.sessionManager.getSessionFile();
	const now = new Date().toISOString();

	let agentId = "";
	let spawnedWindowId: string | undefined;
	let allocatedWorktreePath: string | undefined;
	let allocatedBranch: string | undefined;
	let aggregatedWarnings: string[] = [];

	try {
		await ensureDir(getMetaDir(stateRoot));

		let slug: string;
		if (params.branchHint) {
			slug = sanitizeSlug(params.branchHint);
			if (!slug) slug = slugFromTask(params.task);
		} else {
			const generated = await generateSlug(ctx, params.task);
			slug = generated.slug;
			if (generated.warning) aggregatedWarnings.push(generated.warning);
		}

		await mutateRegistry(stateRoot, async (registry) => {
			const existing = existingAgentIds(registry, repoRoot);
			agentId = deduplicateSlug(slug, existing);
			registry.agents[agentId] = {
				id: agentId,
				parentSessionId,
				task: params.task,
				model: params.model,
				status: "allocating_worktree",
				startedAt: now,
				updatedAt: now,
			};
		});

		const worktree = await allocateWorktree({
			repoRoot,
			stateRoot,
			agentId,
			parentSessionId,
		});
		allocatedWorktreePath = worktree.worktreePath;
		allocatedBranch = worktree.branch;
		aggregatedWarnings = [...worktree.warnings];

		const runtimePrep = await prepareFreshRuntimeDir(stateRoot, agentId);
		const runtimeDir = runtimePrep.runtimeDir;
		if (runtimePrep.archivedRuntimeDir) {
			aggregatedWarnings.push(
				`Archived existing runtime dir for ${agentId}: ${runtimePrep.archivedRuntimeDir}`,
			);
		}
		if (runtimePrep.warning) {
			aggregatedWarnings.push(runtimePrep.warning);
		}

		const promptPath = join(runtimeDir, "kickoff.md");
		const logPath = join(runtimeDir, "backlog.log");
		const exitFile = join(runtimeDir, "exit.json");
		const launchScriptPath = join(runtimeDir, "launch.sh");
		await atomicWrite(logPath, "");

		await mutateRegistry(stateRoot, async (registry) => {
			const record = registry.agents[agentId];
			if (!record) return;
			record.worktreePath = worktree.worktreePath;
			record.branch = worktree.branch;
			record.runtimeDir = runtimeDir;
			record.promptPath = promptPath;
			record.logPath = logPath;
			record.exitFile = exitFile;
			await setRecordStatus(stateRoot, record, "spawning_tmux");
			record.warnings = [...(record.warnings ?? []), ...worktree.warnings];
		});

		const kickoff = await buildKickoffPrompt(
			ctx,
			params.task,
			params.includeSummary,
		);
		if (kickoff.warning) aggregatedWarnings.push(kickoff.warning);

		// biome-ignore lint/style/useTemplate: ignored using `--suppress`
		await atomicWrite(promptPath, kickoff.prompt + "\n");
		try {
			await mutateRegistry(stateRoot, async (registry) => {
				const record = registry.agents[agentId];
				if (!record) return;
				await appendKickoffPromptToBacklog(stateRoot, record, kickoff.prompt);
			});
		} catch {
			await appendKickoffPromptToBacklog(
				stateRoot,
				{
					id: agentId,
					task: params.task,
					status: "spawning_tmux",
					startedAt: now,
					updatedAt: new Date().toISOString(),
					runtimeDir,
					logPath,
				},
				kickoff.prompt,
			);
		}

		const resolvedModel = await resolveModelSpecForChild(ctx, params.model);
		const modelSpec = resolvedModel.modelSpec;
		if (resolvedModel.warning) aggregatedWarnings.push(resolvedModel.warning);

		const tmuxSession = getCurrentTmuxSession();
		const { windowId, windowIndex } = createTmuxWindow(
			tmuxSession,
			`agent-${agentId}`,
		);
		spawnedWindowId = windowId;

		await updateWorktreeLock(worktree.worktreePath, {
			tmuxWindowId: windowId,
			tmuxWindowIndex: windowIndex,
		});

		const launchScript = buildLaunchScript({
			agentId,
			parentSessionId,
			parentRepoRoot: repoRoot,
			stateRoot,
			worktreePath: worktree.worktreePath,
			tmuxWindowId: windowId,
			promptPath,
			exitFile,
			modelSpec,
			runtimeDir,
		});
		await atomicWrite(launchScriptPath, launchScript);
		await fs.chmod(launchScriptPath, 0o755);

		tmuxPipePaneToFile(windowId, logPath);
		tmuxSendLine(windowId, `cd ${JSON.stringify(worktree.worktreePath)}`);
		tmuxSendLine(windowId, `bash ${JSON.stringify(launchScriptPath)}`);

		await mutateRegistry(stateRoot, async (registry) => {
			const record = registry.agents[agentId];
			if (!record) return;
			record.tmuxSession = tmuxSession;
			record.tmuxWindowId = windowId;
			record.tmuxWindowIndex = windowIndex;
			record.worktreePath = worktree.worktreePath;
			record.branch = worktree.branch;
			record.runtimeDir = runtimeDir;
			record.promptPath = promptPath;
			record.logPath = logPath;
			record.exitFile = exitFile;
			record.model = modelSpec;
			await setRecordStatus(stateRoot, record, "running");
			record.warnings = [...(record.warnings ?? []), ...aggregatedWarnings];
		});

		const started: StartAgentResult = {
			id: agentId,
			tmuxWindowId: windowId,
			tmuxWindowIndex: windowIndex,
			worktreePath: worktree.worktreePath,
			branch: worktree.branch,
			warnings: aggregatedWarnings,
			prompt: kickoff.prompt,
		};
		emitKickoffPromptMessage(pi, started);

		return started;
	} catch (err) {
		if (spawnedWindowId) {
			run("tmux", ["kill-window", "-t", spawnedWindowId]);
		}

		if (agentId) {
			await mutateRegistry(stateRoot, async (registry) => {
				const record = registry.agents[agentId];
				if (!record) return;
				record.error = stringifyError(err);
				record.finishedAt = now;
				const changed = await setRecordStatus(stateRoot, record, "failed");
				if (!changed) {
					record.updatedAt = new Date().toISOString();
				}
				if (allocatedWorktreePath) record.worktreePath = allocatedWorktreePath;
				if (allocatedBranch) record.branch = allocatedBranch;
				record.warnings = [...(record.warnings ?? []), ...aggregatedWarnings];
			});
		}

		throw err;
	}
}

export async function sendToAgent(
	stateRoot: string,
	agentId: string,
	prompt: string,
): Promise<{ ok: boolean; message: string }> {
	const normalizedId = normalizeAgentId(agentId);
	if (!normalizedId) {
		return { ok: false, message: "No agent id was provided" };
	}

	const record = await refreshAgent(stateRoot, normalizedId);
	if (!record) {
		return { ok: false, message: `Unknown agent id: ${normalizedId}` };
	}
	if (!record.tmuxWindowId) {
		return {
			ok: false,
			message: `Agent ${normalizedId} has no tmux window id recorded`,
		};
	}
	if (!tmuxWindowExists(record.tmuxWindowId)) {
		return {
			ok: false,
			message: `Agent ${normalizedId} tmux window is not active`,
		};
	}

	let payload = prompt;
	if (payload.startsWith("!")) {
		tmuxInterrupt(record.tmuxWindowId);
		payload = payload.slice(1).trimStart();
		if (payload.length > 0) {
			await sleep(300);
		}
	}
	if (payload.length > 0) {
		tmuxSendPrompt(record.tmuxWindowId, payload);
	}

	await mutateRegistry(stateRoot, async (registry) => {
		const current = registry.agents[normalizedId];
		if (!current) return;
		if (!isTerminalStatus(current.status)) {
			const changed = await setRecordStatus(stateRoot, current, "running");
			if (!changed) {
				current.updatedAt = new Date().toISOString();
			}
		}
	});

	return { ok: true, message: `Sent prompt to ${normalizedId}` };
}

export async function waitForAny(
	stateRoot: string,
	ids: string[],
	signal?: AbortSignal,
	waitStatesInput?: string[],
): Promise<Record<string, unknown>> {
	const { normalizeWaitStates } = await import("./utils.js");
	const uniqueIds = [
		...new Set(ids.map((id) => normalizeAgentId(id)).filter(Boolean)),
	];
	if (uniqueIds.length === 0) {
		return { ok: false, error: "No agent ids were provided" };
	}

	const waitStates = normalizeWaitStates(waitStatesInput);
	if (waitStates.error) {
		return { ok: false, error: waitStates.error };
	}
	const waitStateSet = new Set<AgentStatus>(waitStates.values);

	let firstPass = true;
	const knownIds = new Set<string>();

	while (true) {
		if (signal?.aborted) {
			return { ok: false, error: "agent-wait-any aborted" };
		}

		const unknownOnFirstPass: string[] = [];

		for (const id of uniqueIds) {
			const checked = await agentCheckPayload(stateRoot, id);
			const ok = checked.ok === true;
			if (!ok) {
				if (knownIds.has(id)) {
					return {
						ok: true,
						agent: { id, status: "done" },
						backlog: [],
					};
				}
				if (firstPass) unknownOnFirstPass.push(id);
				continue;
			}

			knownIds.add(id);
			// biome-ignore lint/suspicious/noExplicitAny: ignored using `--suppress`
			const status = (checked.agent as any)?.status as AgentStatus | undefined;
			if (!status) continue;
			if (waitStateSet.has(status)) {
				return checked;
			}
		}

		if (firstPass && unknownOnFirstPass.length > 0) {
			return {
				ok: false,
				error: `Unknown agent id(s): ${unknownOnFirstPass.join(", ")}`,
			};
		}

		firstPass = false;
		await sleep(1000);
	}
}

export async function setChildRuntimeStatus(
	ctx: ExtensionContext,
	nextStatus: AgentStatus,
): Promise<void> {
	const agentId = process.env[ENV_AGENT_ID];
	if (!agentId) return;

	const stateRoot = getStateRoot(ctx);
	await mutateRegistry(stateRoot, async (registry) => {
		const record = registry.agents[agentId];
		if (!record) return;
		if (isTerminalStatus(record.status)) return;

		const changed = await setRecordStatus(stateRoot, record, nextStatus);
		if (!changed) {
			record.updatedAt = new Date().toISOString();
		}
	});
}

export async function ensureChildSessionLinked(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	const agentId = process.env[ENV_AGENT_ID];
	if (!agentId) return;

	const stateRoot = getStateRoot(ctx);
	const childSession = ctx.sessionManager.getSessionFile();
	const parentSession = process.env[ENV_PARENT_SESSION];

	await mutateRegistry(stateRoot, async (registry) => {
		const existing = registry.agents[agentId];
		if (!existing) {
			registry.agents[agentId] = {
				id: agentId,
				parentSessionId: parentSession,
				childSessionId: childSession,
				task: "(child session linked without parent registry record)",
				status: "running",
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			return;
		}

		existing.childSessionId = childSession;
		existing.parentSessionId = existing.parentSessionId ?? parentSession;
		let statusChanged = false;
		if (!isTerminalStatus(existing.status)) {
			statusChanged = await setRecordStatus(stateRoot, existing, "running");
		}
		if (!statusChanged) {
			existing.updatedAt = new Date().toISOString();
		}
	});

	const lockPath = join(ctx.cwd, ".pi", "active.lock");
	if (await fileExists(lockPath)) {
		const lock = (await readJsonFile<Record<string, unknown>>(lockPath)) ?? {};
		lock.sessionId = childSession;
		lock.agentId = agentId;
		// biome-ignore lint/style/useTemplate: ignored using `--suppress`
		await atomicWrite(lockPath, JSON.stringify(lock, null, 2) + "\n");
	}

	const hasLinkEntry = ctx.sessionManager.getEntries().some((entry) => {
		if (entry.type !== "custom") return false;
		const customEntry = entry as { customType?: string };
		return customEntry.customType === CHILD_LINK_ENTRY_TYPE;
	});

	if (!hasLinkEntry) {
		pi.appendEntry(CHILD_LINK_ENTRY_TYPE, {
			agentId,
			parentSession,
			linkedAt: Date.now(),
		});
	}
}

export { isChildRuntime } from "./registry.js";

// Child-session rendering

export function renderInfoMessage(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	title: string,
	lines: string[],
): void {
	const content = [title, "", ...lines].join("\n");
	if (ctx.hasUI) {
		pi.sendMessage({
			customType: "side-agents-report",
			content,
			display: true,
		});
	} else {
		console.log(content);
	}
}

export function collectStatusTransitions(
	stateRoot: string,
	agents: AgentRecord[],
): StatusTransitionNotice[] {
	const previous = statusSnapshotsByStateRoot.get(stateRoot);
	const next = new Map<string, AgentStatusSnapshot>();
	const transitions: StatusTransitionNotice[] = [];

	for (const record of agents) {
		const currentSnapshot: AgentStatusSnapshot = {
			status: record.status,
			tmuxWindowIndex: record.tmuxWindowIndex,
		};
		next.set(record.id, currentSnapshot);

		const previousSnapshot = previous?.get(record.id);
		if (!previousSnapshot || previousSnapshot.status === record.status)
			continue;
		transitions.push({
			id: record.id,
			fromStatus: previousSnapshot.status,
			toStatus: record.status,
			tmuxWindowIndex:
				record.tmuxWindowIndex ?? previousSnapshot.tmuxWindowIndex,
		});
	}

	if (previous) {
		for (const [agentId, previousSnapshot] of previous.entries()) {
			if (next.has(agentId)) continue;
			if (isTerminalStatus(previousSnapshot.status)) continue;
			transitions.push({
				id: agentId,
				fromStatus: previousSnapshot.status,
				toStatus: "done",
				tmuxWindowIndex: previousSnapshot.tmuxWindowIndex,
			});
		}
	}

	statusSnapshotsByStateRoot.set(stateRoot, next);
	if (!previous) return [];
	return transitions.sort((a, b) => a.id.localeCompare(b.id));
}

type ThemeForeground = {
	fg: (role: "warning" | "muted" | "accent" | "error", text: string) => string;
};

export function formatStatusWord(
	status: AgentStatus,
	theme?: ThemeForeground,
): string {
	if (!theme) return status;
	return theme.fg(statusColorRole(status), status);
}

export function formatLabelPrefix(
	prefix: string,
	theme?: ThemeForeground,
): string {
	if (!theme) return prefix;
	return theme.fg("muted", prefix);
}

export function formatStatusTransitionMessage(
	transition: StatusTransitionNotice,
	theme?: ThemeForeground,
): string {
	const win =
		transition.tmuxWindowIndex !== undefined
			? ` (tmux #${transition.tmuxWindowIndex})`
			: "";
	const from = formatStatusWord(transition.fromStatus, theme);
	const to = formatStatusWord(transition.toStatus, theme);
	return `side-agent ${transition.id}: ${from} -> ${to}${win}`;
}

export function emitStatusTransitions(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	transitions: StatusTransitionNotice[],
): void {
	if (isChildRuntime()) return;

	for (const transition of transitions) {
		const message = formatStatusTransitionMessage(
			transition,
			ctx.hasUI ? ctx.ui.theme : undefined,
		);
		pi.sendMessage(
			{
				customType: STATUS_UPDATE_MESSAGE_TYPE,
				content: message,
				display: true,
				details: {
					agentId: transition.id,
					fromStatus: transition.fromStatus,
					toStatus: transition.toStatus,
					tmuxWindowIndex: transition.tmuxWindowIndex,
					emittedAt: Date.now(),
				},
			},
			{
				triggerTurn: false,
				deliverAs: "followUp",
			},
		);

		if (
			ctx.hasUI &&
			(transition.toStatus === "failed" || transition.toStatus === "crashed")
		) {
			ctx.ui.notify(message, "error");
		}
	}
}

export function emitKickoffPromptMessage(
	pi: ExtensionAPI,
	started: StartAgentResult,
): void {
	const win =
		started.tmuxWindowIndex !== undefined
			? ` (tmux #${started.tmuxWindowIndex})`
			: "";
	const content = `side-agent ${started.id}: kickoff prompt${win}\n\n${started.prompt}`;
	pi.sendMessage(
		{
			customType: PROMPT_UPDATE_MESSAGE_TYPE,
			content,
			display: false,
			details: {
				agentId: started.id,
				tmuxWindowId: started.tmuxWindowId,
				tmuxWindowIndex: started.tmuxWindowIndex,
				worktreePath: started.worktreePath,
				branch: started.branch,
				prompt: started.prompt,
				emittedAt: Date.now(),
			},
		},
		{ triggerTurn: false },
	);
}

export async function renderStatusLine(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options?: { emitTransitions?: boolean },
): Promise<void> {
	if (!ctx.hasUI) return;

	const stateRoot = getStateRoot(ctx);
	const refreshed = await refreshAllAgents(stateRoot);
	const agents = Object.values(refreshed.agents).sort((a, b) =>
		a.id.localeCompare(b.id),
	);

	if (options?.emitTransitions ?? true) {
		const transitions = collectStatusTransitions(stateRoot, agents);
		if (transitions.length > 0) {
			emitStatusTransitions(pi, ctx, transitions);
		}
	} else if (!statusSnapshotsByStateRoot.has(stateRoot)) {
		collectStatusTransitions(stateRoot, agents);
	}

	const selfId = process.env[ENV_AGENT_ID];
	const visible = selfId ? agents.filter((r) => r.id !== selfId) : agents;

	if (visible.length === 0) {
		if (lastRenderedStatusLine !== undefined) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			lastRenderedStatusLine = undefined;
		}
		return;
	}

	const theme = ctx.ui.theme;
	const line = visible
		.map((record) => {
			const win =
				record.tmuxWindowIndex !== undefined
					? `@${record.tmuxWindowIndex}`
					: "";
			const entry = `${record.id}:${statusShort(record.status)}${win}`;
			return theme.fg(statusColorRole(record.status), entry);
		})
		.join(" ");

	if (line === lastRenderedStatusLine) return;
	ctx.ui.setStatus(STATUS_KEY, line);
	lastRenderedStatusLine = line;
}

export function ensureStatusPoller(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	statusPollContext = ctx;
	statusPollApi = pi;
	if (!ctx.hasUI) return;

	if (!statusPollTimer) {
		statusPollTimer = setInterval(() => {
			if (statusPollInFlight || !statusPollContext || !statusPollApi) return;
			statusPollInFlight = true;
			void renderStatusLine(statusPollApi, statusPollContext)
				.catch(() => {})
				.finally(() => {
					statusPollInFlight = false;
				});
		}, 2500);
		statusPollTimer.unref();
	}

	void renderStatusLine(pi, ctx).catch(() => {});
}

// Helper function for agent-check tool
export async function agentCheckPayload(
	stateRoot: string,
	agentId: string,
): Promise<Record<string, unknown>> {
	const normalizedId = normalizeAgentId(agentId);
	if (!normalizedId) {
		return {
			ok: false,
			error: "No agent id was provided",
		};
	}

	const record = await refreshAgent(stateRoot, normalizedId);
	if (!record) {
		return {
			ok: false,
			error: `Unknown agent id: ${normalizedId}`,
		};
	}

	const backlog = await getBacklogTail(record, 10);

	return {
		ok: true,
		agent: {
			id: record.id,
			status: record.status,
			tmuxWindowId: record.tmuxWindowId,
			tmuxWindowIndex: record.tmuxWindowIndex,
			worktreePath: record.worktreePath,
			branch: record.branch,
			task: summarizeTask(record.task),
			startedAt: record.startedAt,
			finishedAt: record.finishedAt,
			exitCode: record.exitCode,
			error: record.error,
			warnings: record.warnings ?? [],
		},
		backlog,
	};
}
