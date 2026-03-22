import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { nowIso, stringifyError, type CommandResult } from "./utils.js";

export async function fileExists(path: string): Promise<boolean> {
	try {
		await fs.stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function ensureDir(path: string): Promise<void> {
	await fs.mkdir(path, { recursive: true });
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
	try {
		const raw = await fs.readFile(path, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

export async function atomicWrite(path: string, content: string): Promise<void> {
	await ensureDir(dirname(path));
	const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
	await fs.writeFile(tmp, content, "utf8");
	await fs.rename(tmp, path);
}

export async function withFileLock<T>(
	lockPath: string,
	fn: () => Promise<T>,
): Promise<T> {
	await ensureDir(dirname(lockPath));

	const started = Date.now();
	while (true) {
		try {
			const handle = await fs.open(lockPath, "wx");
			try {
				await handle.writeFile(
					// biome-ignore lint/style/useTemplate: ignored using `--suppress`
					JSON.stringify({ pid: process.pid, createdAt: nowIso() }) + "\n",
					"utf8",
				);
			} catch {
				// best effort
			}

			try {
				return await fn();
			} finally {
				await handle.close().catch(() => {});
				await fs.unlink(lockPath).catch(() => {});
			}
			// biome-ignore lint/suspicious/noExplicitAny: ignored using `--suppress`
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;

			try {
				const st = await fs.stat(lockPath);
				const ageMs = Date.now() - st.mtimeMs;
				if (ageMs > 30_000) {
					await fs.unlink(lockPath).catch(() => {});
					continue;
				}
				// Check if the lock holder is still alive (stale lock after crash/reboot)
				if (ageMs > 2_000) {
					try {
						const raw = await fs.readFile(lockPath, "utf8");
						const data = JSON.parse(raw);
						if (typeof data.pid === "number") {
							try {
								process.kill(data.pid, 0); // signal 0 = existence check
							} catch {
								// PID doesn't exist → stale lock
								await fs.unlink(lockPath).catch(() => {});
								continue;
							}
						}
					} catch {
						// If we can't read/parse the lock, fall through to normal timeout
					}
				}
			} catch {
				// ignore
			}

			if (Date.now() - started > 10_000) {
				throw new Error(`Timed out waiting for lock ${lockPath}`);
			}
			// Use dynamic import for utils sleep
			await new Promise((r) => setTimeout(r, 40 + Math.random() * 80));
		}
	}
}
