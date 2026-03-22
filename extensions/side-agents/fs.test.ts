import { describe, expect, test, afterAll } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	fileExists,
	ensureDir,
	readJsonFile,
	atomicWrite,
	withFileLock,
} from "./fs.js";

describe("fileExists", () => {
	test("returns true for existing file", async () => {
		const dir = await setupTestDir("fileExists");
		const filePath = join(dir, "test.txt");
		await writeFile(filePath, "hello");
		expect(await fileExists(filePath)).toBe(true);
	});

	test("returns false for non-existing file", async () => {
		const dir = await setupTestDir("fileExists");
		const filePath = join(dir, "nonexistent.txt");
		expect(await fileExists(filePath)).toBe(false);
	});

	test("returns true for existing directory", async () => {
		const dir = await setupTestDir("fileExists");
		expect(await fileExists(dir)).toBe(true);
	});
});

describe("ensureDir", () => {
	test("creates directory recursively", async () => {
		const dir = await setupTestDir("ensureDir");
		const nestedPath = join(dir, "a", "b", "c");
		await ensureDir(nestedPath);
		expect(await fileExists(nestedPath)).toBe(true);
	});

	test("succeeds for existing directory", async () => {
		const dir = await setupTestDir("ensureDir");
		await ensureDir(dir);
		await ensureDir(dir); // Should not throw
		expect(await fileExists(dir)).toBe(true);
	});
});

describe("readJsonFile", () => {
	test("reads valid JSON file", async () => {
		const dir = await setupTestDir("readJsonFile");
		const filePath = join(dir, "data.json");
		await writeFile(filePath, JSON.stringify({ key: "value", num: 42 }));
		const result = await readJsonFile<{ key: string; num: number }>(filePath);
		expect(result).toEqual({ key: "value", num: 42 });
	});

	test("returns undefined for non-existing file", async () => {
		const dir = await setupTestDir("readJsonFile");
		const filePath = join(dir, "nonexistent.json");
		expect(await readJsonFile(filePath)).toBeUndefined();
	});

	test("returns undefined for invalid JSON", async () => {
		const dir = await setupTestDir("readJsonFile");
		const filePath = join(dir, "invalid.json");
		await writeFile(filePath, "{ invalid json }");
		expect(await readJsonFile(filePath)).toBeUndefined();
	});
});

describe("atomicWrite", () => {
	test("writes content atomically", async () => {
		const dir = await setupTestDir("atomicWrite");
		const filePath = join(dir, "atomic.txt");
		await atomicWrite(filePath, "test content");
		const content = await readFile(filePath, "utf8");
		expect(content).toBe("test content");
	});

	test("creates parent directories if needed", async () => {
		const dir = await setupTestDir("atomicWrite");
		const filePath = join(dir, "nested", "path", "file.txt");
		await atomicWrite(filePath, "nested content");
		const content = await readFile(filePath, "utf8");
		expect(content).toBe("nested content");
	});

	test("overwrites existing file", async () => {
		const dir = await setupTestDir("atomicWrite");
		const filePath = join(dir, "overwrite.txt");
		await writeFile(filePath, "original");
		await atomicWrite(filePath, "updated");
		const content = await readFile(filePath, "utf8");
		expect(content).toBe("updated");
	});
});

describe("withFileLock", () => {
	test("acquires lock and executes function", async () => {
		const dir = await setupTestDir("withFileLock");
		const lockPath = join(dir, "test.lock");
		let executed = false;
		const result = await withFileLock(lockPath, async () => {
			executed = true;
			return 42;
		});
		expect(result).toBe(42);
		expect(executed).toBe(true);
	});

	test("lock file is removed after execution", async () => {
		const dir = await setupTestDir("withFileLock");
		const lockPath = join(dir, "cleanup.lock");
		await withFileLock(lockPath, async () => {});
		expect(await fileExists(lockPath)).toBe(false);
	});

	test("lock file is removed even on error", async () => {
		const dir = await setupTestDir("withFileLock");
		const lockPath = join(dir, "error.lock");
		try {
			await withFileLock(lockPath, async () => {
				throw new Error("test error");
			});
		} catch {
			// Expected
		}
		expect(await fileExists(lockPath)).toBe(false);
	});

	test("writes PID to lock file", async () => {
		const dir = await setupTestDir("withFileLock");
		const lockPath = join(dir, "pid.lock");
		await withFileLock(lockPath, async () => {
			const content = await readFile(lockPath, "utf8");
			const data = JSON.parse(content.trim());
			expect(typeof data.pid).toBe("number");
			expect(data.pid).toBe(process.pid);
		});
	});
});

// Helper to create and return a unique test directory
const testBaseDir = join(process.env["TMPDIR"] || "/tmp", "side-agents-test");
let testCounter = 0;

async function setupTestDir(suite: string): Promise<string> {
	const dir = join(testBaseDir, suite, String(++testCounter));
	await mkdir(dir, { recursive: true });
	return dir;
}

// Cleanup after all tests
afterAll(async () => {
	try {
		await rm(testBaseDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});
