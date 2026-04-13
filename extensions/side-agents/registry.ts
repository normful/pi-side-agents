import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import {
	atomicWrite,
	ensureDir,
	fileExists,
	readJsonFile,
	withFileLock,
} from "./fs.js";
import { gitRunOpts, nowIso, run, stringifyError } from "./utils.js";

export const REGISTRY_VERSION = 1;
const ENV_STATE_ROOT = "PI_SIDE_AGENTS_ROOT";
const ENV_AGENT_ID = "PI_SIDE_AGENT_ID";

export type AgentStatus =
	| "allocating_worktree"
	| "spawning_tmux"
	| "running"
	| "waiting_user"
	| "done"
	| "failed"
	| "crashed";

export type AgentRecord = {
	id: string;
	parentSessionId?: string;
	childSessionId?: string;
	tmuxSession?: string;
	tmuxWindowId?: string;
	tmuxWindowIndex?: number;
	worktreePath?: string;
	branch?: string;
	model?: string;
	task: string;
	status: AgentStatus;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
	runtimeDir?: string;
	logPath?: string;
	promptPath?: string;
	exitFile?: string;
	exitCode?: number;
	error?: string;
	warnings?: string[];
	disableSandbox?: boolean; // false = use CCO sandbox (default), true = run Pi directly
};

export type RegistryFile = {
	version: 1;
	agents: Record<string, AgentRecord>;
};

export type StartAgentParams = {
	task: string;
	branchHint?: string;
	model?: string;
	includeSummary: boolean;
	disableSandbox?: boolean; // false = use CCO sandbox (default), true = run Pi directly
};

export type StartAgentResult = {
	id: string;
	tmuxWindowId: string;
	tmuxWindowIndex: number;
	worktreePath: string;
	branch: string;
	warnings: string[];
	prompt: string;
	disableSandbox: boolean;
};

export type PrepareRuntimeDirResult = {
	runtimeDir: string;
	archivedRuntimeDir?: string;
	warning?: string;
};

export type ExitMarker = {
	exitCode?: number;
	finishedAt?: string;
};

function resolveGitRoot(cwd: string): string {
	const result = run(
		"git",
		["-C", cwd, "rev-parse", "--show-toplevel"],
		gitRunOpts,
	);
	if (result.ok) {
		const root = result.stdout.trim();
		if (root.length > 0) return resolve(root);
	}
	return resolve(cwd);
}

export function getStateRoot(ctx: { cwd: string }): string {
	const fromEnv = process.env[ENV_STATE_ROOT];
	if (fromEnv) return resolve(fromEnv);
	return resolveGitRoot(ctx.cwd);
}

export function getMetaDir(stateRoot: string): string {
	return join(stateRoot, ".pi", "side-agents");
}

export function getRegistryPath(stateRoot: string): string {
	return join(getMetaDir(stateRoot), "registry.json");
}

export function getRegistryLockPath(stateRoot: string): string {
	return join(getMetaDir(stateRoot), "registry.lock");
}

export function getRuntimeDir(stateRoot: string, agentId: string): string {
	return join(getMetaDir(stateRoot), "runtime", agentId);
}

export function getRuntimeArchiveBaseDir(
	stateRoot: string,
	agentId: string,
): string {
	return join(getMetaDir(stateRoot), "runtime-archive", agentId);
}

export function runtimeArchiveStamp(): string {
	return nowIso().replace(/[:.]/g, "-");
}

export function emptyRegistry(): RegistryFile {
	return {
		version: REGISTRY_VERSION,
		agents: {},
	};
}

export async function loadRegistry(stateRoot: string): Promise<RegistryFile> {
	const registryPath = getRegistryPath(stateRoot);
	const parsed = await readJsonFile<RegistryFile>(registryPath);
	if (!parsed || typeof parsed !== "object") return emptyRegistry();
	if (
		parsed.version !== REGISTRY_VERSION ||
		typeof parsed.agents !== "object" ||
		parsed.agents === null
	) {
		return emptyRegistry();
	}
	return parsed;
}

export async function saveRegistry(
	stateRoot: string,
	registry: RegistryFile,
): Promise<void> {
	const registryPath = getRegistryPath(stateRoot);
	// biome-ignore lint/style/useTemplate: ignored using `--suppress`
	await atomicWrite(registryPath, JSON.stringify(registry, null, 2) + "\n");
}

export async function mutateRegistry(
	stateRoot: string,
	mutator: (registry: RegistryFile) => Promise<void> | void,
): Promise<RegistryFile> {
	const lockPath = getRegistryLockPath(stateRoot);
	return withFileLock(lockPath, async () => {
		const registry = await loadRegistry(stateRoot);
		const before = JSON.stringify(registry);
		await mutator(registry);
		const after = JSON.stringify(registry);
		if (after !== before) {
			await saveRegistry(stateRoot, registry);
		}
		return registry;
	});
}

export function isTerminalStatus(status: AgentStatus): boolean {
	return status === "done" || status === "failed" || status === "crashed";
}

export async function setRecordStatus(
	_stateRoot: string,
	record: AgentRecord,
	nextStatus: AgentStatus,
): Promise<boolean> {
	const previousStatus = record.status;
	if (previousStatus === nextStatus) return false;

	record.status = nextStatus;
	record.updatedAt = nowIso();
	return true;
}

export async function prepareFreshRuntimeDir(
	stateRoot: string,
	agentId: string,
): Promise<PrepareRuntimeDirResult> {
	const runtimeDir = getRuntimeDir(stateRoot, agentId);
	if (!(await fileExists(runtimeDir))) {
		await ensureDir(runtimeDir);
		return { runtimeDir };
	}

	const archiveBaseDir = getRuntimeArchiveBaseDir(stateRoot, agentId);
	const archiveDir = join(
		archiveBaseDir,
		`${runtimeArchiveStamp()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
	);

	try {
		await ensureDir(archiveBaseDir);
		await fs.rename(runtimeDir, archiveDir);
		await ensureDir(runtimeDir);
		return {
			runtimeDir,
			archivedRuntimeDir: archiveDir,
		};
	} catch (archiveErr) {
		const archiveErrMessage = stringifyError(archiveErr);
		try {
			await fs.rm(runtimeDir, { recursive: true, force: true });
			await ensureDir(runtimeDir);
		} catch (cleanupErr) {
			throw new Error(
				`Failed to prepare runtime dir ${runtimeDir}: archive failed (${archiveErrMessage}); cleanup failed (${stringifyError(cleanupErr)})`,
			);
		}

		return {
			runtimeDir,
			warning: `Failed to archive existing runtime dir for ${agentId}: ${archiveErrMessage}. Removed stale runtime directory instead.`,
		};
	}
}

export function isChildRuntime(): boolean {
	return Boolean(process.env[ENV_AGENT_ID]);
}
