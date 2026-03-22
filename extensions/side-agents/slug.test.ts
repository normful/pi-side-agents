import { describe, expect, test } from "bun:test";
import {
	sanitizeSlug,
	slugFromTask,
	deduplicateSlug,
	parseOptionalPid,
	isPidAlive,
	summarizeOrphanLock,
	type OrphanWorktreeLock,
} from "./slug.js";

describe("sanitizeSlug", () => {
	test("converts to lowercase", () => {
		expect(sanitizeSlug("HELLO")).toBe("hello");
		expect(sanitizeSlug("HeLLo")).toBe("hello");
	});

	test("replaces non-alphanumeric with hyphens", () => {
		expect(sanitizeSlug("hello world")).toBe("hello-world");
		expect(sanitizeSlug("fix_auth_leak")).toBe("fix-auth-leak");
	});

	test("removes leading/trailing hyphens", () => {
		expect(sanitizeSlug("  hello  ")).toBe("hello");
		expect(sanitizeSlug("---hello---")).toBe("hello");
	});

	test("limits to 3 segments", () => {
		expect(sanitizeSlug("one two three four five")).toBe("one-two-three");
	});

	test("handles empty input", () => {
		expect(sanitizeSlug("")).toBe("");
		expect(sanitizeSlug("   ")).toBe("");
	});

	test("removes empty segments", () => {
		expect(sanitizeSlug("hello__world")).toBe("hello-world");
	});
});

describe("slugFromTask", () => {
	test("extracts meaningful words", () => {
		expect(slugFromTask("Fix authentication bug")).toBe("fix-authentication-bug");
	});

	test("filters stop words", () => {
		expect(slugFromTask("the quick brown fox")).toBe("quick-brown-fox");
	});

	test("limits to 3 words", () => {
		expect(slugFromTask("one two three four five")).toBe("one-two-three");
	});

	test("handles non-alphanumeric characters", () => {
		expect(slugFromTask("Fix bug: auth failure")).toBe("fix-bug-auth");
	});

	test("returns 'agent' for empty/stop-word-only input", () => {
		expect(slugFromTask("the a an")).toBe("agent");
		expect(slugFromTask("")).toBe("agent");
	});
});

describe("deduplicateSlug", () => {
	test("returns slug if not in existing", () => {
		const existing = new Set(["other", "values"]);
		expect(deduplicateSlug("new-slug", existing)).toBe("new-slug");
	});

	test("appends -2 if slug exists", () => {
		const existing = new Set(["my-slug", "other"]);
		expect(deduplicateSlug("my-slug", existing)).toBe("my-slug-2");
	});

	test("appends correct number for multiple conflicts", () => {
		const existing = new Set(["my-slug", "my-slug-2", "my-slug-3"]);
		expect(deduplicateSlug("my-slug", existing)).toBe("my-slug-4");
	});

	test("handles existing with -2 but not base", () => {
		const existing = new Set(["my-slug-2"]);
		expect(deduplicateSlug("my-slug", existing)).toBe("my-slug");
	});
});

describe("parseOptionalPid", () => {
	test("parses positive integers", () => {
		expect(parseOptionalPid(123)).toBe(123);
	});

	test("parses string numbers", () => {
		expect(parseOptionalPid("456")).toBe(456);
	});

	test("rejects zero", () => {
		expect(parseOptionalPid(0)).toBeUndefined();
		expect(parseOptionalPid("0")).toBeUndefined();
	});

	test("rejects negative numbers", () => {
		expect(parseOptionalPid(-1)).toBeUndefined();
	});

	test("rejects non-numeric strings", () => {
		expect(parseOptionalPid("abc")).toBeUndefined();
		expect(parseOptionalPid("12.34")).toBeUndefined();
	});

	test("rejects non-numeric types", () => {
		expect(parseOptionalPid(null)).toBeUndefined();
		expect(parseOptionalPid(undefined)).toBeUndefined();
		expect(parseOptionalPid({})).toBeUndefined();
	});
});

describe("isPidAlive", () => {
	test("returns false for undefined", () => {
		expect(isPidAlive(undefined)).toBe(false);
	});

	test("returns true for current process (EPERM)", () => {
		// process.kill(process.pid, 0) throws EPERM on some systems
		// or succeeds on others, either way we return true
		expect(isPidAlive(process.pid)).toBe(true);
	});

	test("returns false for non-existent PID", () => {
		expect(isPidAlive(999999999)).toBe(false);
	});
});

describe("summarizeOrphanLock", () => {
	test("returns path only if no details", () => {
		const lock: OrphanWorktreeLock = {
			worktreePath: "/path/to/worktree",
			lockPath: "/path/to/worktree/.pi/active.lock",
			blockers: [],
		};
		expect(summarizeOrphanLock(lock)).toBe("/path/to/worktree");
	});

	test("includes agent ID if present", () => {
		const lock: OrphanWorktreeLock = {
			worktreePath: "/path/to/worktree",
			lockPath: "/path/to/worktree/.pi/active.lock",
			lockAgentId: "my-agent",
			blockers: [],
		};
		expect(summarizeOrphanLock(lock)).toBe(
			"/path/to/worktree (agent:my-agent)",
		);
	});

	test("includes multiple details", () => {
		const lock: OrphanWorktreeLock = {
			worktreePath: "/path/to/worktree",
			lockPath: "/path/to/worktree/.pi/active.lock",
			lockAgentId: "my-agent",
			lockPid: 12345,
			lockTmuxWindowId: "@window.1",
			blockers: [],
		};
		const result = summarizeOrphanLock(lock);
		expect(result).toContain("my-agent");
		expect(result).toContain("12345");
		expect(result).toContain("@window.1");
	});
});
