import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import type {
	ExtensionContext,
	SessionEntry,
} from "@mariozechner/pi-coding-agent";
import {
	convertToLlm,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";
import { ensureDir } from "./fs.js";
import { type AgentRecord, getRuntimeDir } from "./registry.js";
import {
	isBacklogSeparatorLine,
	splitLines,
	stripTerminalNoise,
	truncateWithEllipsis,
} from "./utils.js";

const PROMPT_LOG_PREFIX = "[side-agent][prompt]";
const TASK_PREVIEW_MAX_CHARS = 220;
const BACKLOG_LINE_MAX_CHARS = 240;
const BACKLOG_TOTAL_MAX_CHARS = 2400;
const SUMMARY_MAX_LINES = 10;
const SUMMARY_MAX_CHARS = 700;
const SUMMARY_NONE_RE =
	/^(?:none|n\/a|no relevant context(?: from parent session)?\.?|unrelated)\s*$/i;
const SUMMARY_SYSTEM_PROMPT = `You are writing a minimal handoff summary for a background coding agent.

Use the parent conversation only as context. Include only details that are directly relevant to the child task.

If the parent conversation is unrelated to the child task, output exactly:
NONE

Preferred content (but only when relevant):
- objective/constraints already established
- decisions already made
- key files/components to inspect
- risks/caveats`;
const PLAIN_GIT_INSTRUCTIONS = `ALWAYS run git commands with these env vars and config (git doesn't read $HOME files).
  Example: instead of 'git commit', run 'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME="AI" GIT_AUTHOR_EMAIL="none" GIT_COMMITTER_NAME="AI" GIT_COMMITTER_EMAIL="none" git -c core.excludesFile=/dev/null commit'.
 Same for other git commands.`;

export function normalizeGeneratedSummary(raw: string): string {
	const cleaned = stripTerminalNoise(raw).trim();
	if (!cleaned) return "";

	const fenced = cleaned.match(/^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```$/i);
	const unfenced = (fenced?.[1] ?? cleaned).trim();
	if (!unfenced) return "";
	if (SUMMARY_NONE_RE.test(unfenced)) return "";

	const compactLines: string[] = [];
	let previousBlank = false;
	for (const rawLine of unfenced.replace(/\r\n?/g, "\n").split("\n")) {
		const line = rawLine.trimEnd();
		const blank = line.trim().length === 0;
		if (blank) {
			if (previousBlank) continue;
			previousBlank = true;
		} else {
			previousBlank = false;
		}
		compactLines.push(line);
		if (compactLines.length >= SUMMARY_MAX_LINES) break;
	}

	const summary = compactLines.join("\n").trim();
	if (!summary || SUMMARY_NONE_RE.test(summary)) return "";
	return truncateWithEllipsis(summary, SUMMARY_MAX_CHARS);
}

export function summarizeTask(task: string): string {
	const collapsed = stripTerminalNoise(task).replace(/\s+/g, " ").trim();
	return truncateWithEllipsis(collapsed, TASK_PREVIEW_MAX_CHARS);
}

export function resolveBacklogPathForRecord(
	stateRoot: string,
	record: AgentRecord,
): string {
	if (record.logPath) return record.logPath;
	if (record.runtimeDir) return join(record.runtimeDir, "backlog.log");
	return join(getRuntimeDir(stateRoot, record.id), "backlog.log");
}

export async function appendKickoffPromptToBacklog(
	stateRoot: string,
	record: AgentRecord,
	prompt: string,
	loggedAt = new Date().toISOString(),
): Promise<void> {
	const backlogPath = resolveBacklogPathForRecord(stateRoot, record);
	const promptLines = prompt.replace(/\r\n?/g, "\n").split("\n");
	const body = promptLines
		.map((line) => `${PROMPT_LOG_PREFIX} ${loggedAt} ${record.id}: ${line}`)
		.join("\n");
	const payload =
		`${PROMPT_LOG_PREFIX} ${loggedAt} ${record.id}: kickoff prompt begin\n` +
		`${body}\n` +
		`${PROMPT_LOG_PREFIX} ${loggedAt} ${record.id}: kickoff prompt end\n`;

	try {
		await ensureDir(
			basename(backlogPath)
				? backlogPath.slice(0, backlogPath.lastIndexOf("/"))
				: backlogPath,
		);
		await fs.appendFile(backlogPath, payload, "utf8");
		record.logPath = record.logPath ?? backlogPath;
		record.runtimeDir =
			record.runtimeDir ??
			(basename(backlogPath)
				? backlogPath.slice(0, backlogPath.lastIndexOf("/"))
				: backlogPath);
	} catch {
		// Best effort only; prompt logging must not block agent startup.
	}
}

export async function buildKickoffPrompt(
	ctx: ExtensionContext,
	task: string,
	includeSummary: boolean,
): Promise<{ prompt: string; warning?: string }> {
	const parentSession = ctx.sessionManager.getSessionFile();
	const sessionSuffix = parentSession
		? `\n\nParent Pi session: ${parentSession}`
		: "";
	if (!includeSummary || !ctx.model) {
		return { prompt: task + sessionSuffix };
	}

	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter(
			(entry): entry is SessionEntry & { type: "message" } =>
				entry.type === "message",
		)
		.map((entry) => entry.message);

	if (messages.length === 0) {
		return { prompt: task };
	}

	try {
		const llmMessages = convertToLlm(messages);
		const conversationText = serializeConversation(llmMessages);
		const userMessage: Message = {
			role: "user",
			content: [
				{
					type: "text",
					text: `## Parent conversation\n\n${conversationText}\n\n## Child task\n\n${task}`,
				},
			],
			timestamp: Date.now(),
		};

		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(
			ctx.model.provider,
		);
		const response = await complete(
			ctx.model,
			{ systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
			apiKey ? { apiKey } : {},
		);

		const summary = normalizeGeneratedSummary(
			response.content
				.filter(
					(block): block is { type: "text"; text: string } =>
						block.type === "text",
				)
				.map((block) => block.text)
				.join("\n"),
		);

		if (!summary) {
			return { prompt: task + sessionSuffix };
		}

		const prompt = [
			task,
			"",
			"## Parent session",
			parentSession ? `- ${parentSession}` : "- (unknown)",
			"",
			"## Relevant parent context",
			summary,
			"",
			"## Git Usage",
			PLAIN_GIT_INSTRUCTIONS,
		].join("\n");

		return { prompt };
	} catch (err) {
		return {
			prompt: task + sessionSuffix,
			warning: `Failed to generate context summary: ${err instanceof Error ? err.message : String(err)}. Started child with raw task only.`,
		};
	}
}

function collectRecentBacklogLines(
	lines: string[],
	minimumLines: number,
): string[] {
	if (minimumLines <= 0) return [];

	const selected: string[] = [];
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const cleaned = stripTerminalNoise(lines[i]).trimEnd();
		if (cleaned.length === 0) continue;
		if (isBacklogSeparatorLine(cleaned)) continue;
		selected.push(lines[i]);
		if (selected.length >= minimumLines) break;
	}

	return selected.reverse();
}

export function selectBacklogTailLines(
	text: string,
	minimumLines: number,
): string[] {
	return collectRecentBacklogLines(splitLines(text), minimumLines);
}

export function sanitizeBacklogLines(lines: string[]): string[] {
	const out: string[] = [];
	let remaining = BACKLOG_TOTAL_MAX_CHARS;

	for (const raw of lines) {
		if (remaining <= 0) break;
		const cleaned = stripTerminalNoise(raw).trimEnd();
		if (cleaned.length === 0) continue;
		if (isBacklogSeparatorLine(cleaned)) continue;

		const line = truncateWithEllipsis(cleaned, BACKLOG_LINE_MAX_CHARS);
		if (line.length <= remaining) {
			out.push(line);
			remaining -= line.length + 1;
			continue;
		}

		out.push(truncateWithEllipsis(line, remaining));
		remaining = 0;
		break;
	}

	return out;
}

export { collectRecentBacklogLines };
