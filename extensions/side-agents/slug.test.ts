import { describe, expect, test } from "bun:test";
import {
	deduplicateSlug,
	isPidAlive,
	type OrphanWorktreeLock,
	parseOptionalPid,
	sanitizeSlug,
	slugFromTask,
	slugFromTaskLegacy,
	slugFromTaskWithExisting,
	summarizeOrphanLock,
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

describe("slugFromTask (tail-first sliding window)", () => {
	test("empty task falls back to 'agent'", () => {
		expect(slugFromTask("")).toBe("agent");
		expect(slugFromTask("a the of for")).toBe("agent"); // all stop words
	});

	test("single meaningful word — uses 2-word window (preferred)", () => {
		expect(slugFromTask("fix bug")).toBe("fix-bug"); // 2-word window
		expect(slugFromTask("the login bug")).toBe("login-bug"); // 2-word tail
	});

	test("exactly two meaningful words — 2-word window", () => {
		expect(slugFromTask("implement dark mode")).toBe("dark-mode");
		expect(slugFromTask("add dark mode")).toBe("dark-mode");
		expect(slugFromTask("fix auth bug")).toBe("auth-bug");
	});

	test("exactly four words — 2-word tail preferred", () => {
		// "write tests for login page" → meaningful: ["write", "tests", "login", "page"]
		// 2-word tail windows (tail→head): "login-page", "tests-login", "write-tests"
		// Preferred: "login-page"
		expect(slugFromTask("write tests for login page")).toBe("login-page");
	});

	test("more than four words — 2-word tail preferred", () => {
		// "implement dark mode toggle for settings page"
		// meaningful: ["implement", "dark", "mode", "toggle", "settings", "page"]
		// 2-word tail windows (tail→head): "settings-page", "toggle-settings", "mode-toggle", "dark-mode", "implement-dark"
		// Preferred: "settings-page"
		expect(slugFromTask("implement dark mode toggle for settings page")).toBe(
			"settings-page",
		);
	});

	test("three words — 2-word tail preferred over 3-word", () => {
		// "fix auth bug" → meaningful: ["fix", "auth", "bug"]
		// 2-word tail: "auth-bug"
		// 3-word: "fix-auth-bug"
		// 2-word preferred
		expect(slugFromTask("fix auth bug")).toBe("auth-bug");
	});

	test("three words — 2-word tail preferred", () => {
		// "dark mode toggle" → meaningful: ["dark", "mode", "toggle"]
		// 2-word tail: "mode-toggle" (preferred)
		expect(slugFromTask("add dark mode toggle")).toBe("mode-toggle");
	});

	test("stop words filtered out before windowing", () => {
		// "dark mode to settings" → meaningful: ["dark", "mode", "settings"]
		// 2-word tail: "mode-settings"
		expect(slugFromTask("add dark mode to settings")).toBe("mode-settings");
	});

	test("punctuation stripped correctly", () => {
		expect(slugFromTask("fix auth bug!")).toBe("auth-bug");
		expect(slugFromTask("write tests: login page")).toBe("login-page");
		// "dark mode for settings" → meaningful: ["dark", "mode", "settings"]
		// 2-word windows: "mode-settings" (tail), "dark-mode" → tail wins
		expect(slugFromTask("implement 'dark mode' for settings")).toBe(
			"mode-settings",
		);
	});
});

describe("slugFromTaskWithExisting — collision avoidance", () => {
	test("no collision — behaves like slugFromTask", () => {
		const existing = new Set<string>();
		expect(
			slugFromTaskWithExisting("write tests for login page", existing),
		).toBe("login-page");
	});

	test("collision — slides to next unique tail window of same size", () => {
		const existing = new Set<string>(["login-page"]);
		// "write tests for login page"
		// 2-word windows (tail→head): "login-page" (collide), "tests-login", "write-tests"
		// First unique: "tests-login"
		expect(
			slugFromTaskWithExisting("write tests for login page", existing),
		).toBe("tests-login");
	});

	test("size-2 collision — slides to next unique size-2 window", () => {
		const existing = new Set<string>(["login-page", "tests-login"]);
		// "write tests for login page"
		// 2-word (tail→head): "login-page" (collide), "tests-login" (collide), "write-tests" (unique!)
		// → "write-tests" returned (no dedup needed, next candidate is unique)
		expect(
			slugFromTaskWithExisting("write tests for login page", existing),
		).toBe("write-tests");
	});

	test("all windows collide — falls back to size-1 then numeric dedup", () => {
		const existing = new Set<string>([
			"login-page",
			"tests-login",
			"write-tests",
			"tests-login-page",
			"write-tests-login",
			"page",
			"login",
		]);
		// All size 2, 3, 1 collide → numeric dedup on best remaining candidate
		// "tests" is first unique size-1 window
		expect(
			slugFromTaskWithExisting("write tests for login page", existing),
		).toBe("tests");
	});

	test("numeric dedup only when every candidate collides", () => {
		const existing = new Set<string>([
			"login-page",
			"tests-login",
			"write-tests",
			"tests-login-page",
			"write-tests-login",
			"page",
			"login",
			"tests",
			"write",
		]);
		// Every candidate collides. Dedup applies to the best candidate:
		// "login-page" (first in priority order, tail-most 2-word).
		expect(
			slugFromTaskWithExisting("write tests for login page", existing),
		).toBe("login-page-2");
	});
});

describe("comparison: legacy vs tail-first", () => {
	test("verbs that dominate the head now fall away", () => {
		// These all produce the same head-first slug in legacy
		expect(slugFromTaskLegacy("write tests for login page")).toBe(
			"write-tests-login",
		);
		expect(slugFromTaskLegacy("write tests for signup page")).toBe(
			"write-tests-signup",
		);
		expect(slugFromTaskLegacy("write tests for dashboard")).toBe(
			"write-tests-dashboard",
		);

		// Tail-first diverges on the distinctive noun
		expect(slugFromTask("write tests for login page")).toBe("login-page");
		expect(slugFromTask("write tests for signup page")).toBe("signup-page");
		expect(slugFromTask("write tests for dashboard")).toBe("tests-dashboard");
	});

	test("verb-heavy prompts — dedup via shared Set", () => {
		// Caller must add each result to the shared Set for cross-call dedup.
		const shared = new Set<string>();

		let slug = slugFromTaskWithExisting(
			"add dark mode to settings page",
			shared,
		);
		expect(slug).toBe("settings-page");
		shared.add(slug); // ← caller responsibility

		slug = slugFromTaskWithExisting("add light mode to settings page", shared);
		// "settings-page" collides → "mode-settings" (next tail 2-word)
		expect(slug).toBe("mode-settings");
		shared.add(slug);

		slug = slugFromTaskWithExisting(
			"add theme toggle to settings page",
			shared,
		);
		// "settings-page" and "mode-settings" collide
		// 2-word: "toggle-settings" → unique
		expect(slug).toBe("toggle-settings");
	});

	test("tasks with no clear object — 2-word from tail still wins", () => {
		// "clean up codebase" → meaningful: ["clean", "up", "codebase"]
		// 2-word tail: "up-codebase"
		expect(slugFromTask("clean up codebase")).toBe("up-codebase");
	});

	test("mixed — shared Set drives cross-task differentiation", () => {
		// Caller must add each result to the shared Set for cross-call dedup.
		const shared = new Set<string>();

		let slug = slugFromTaskWithExisting(
			"implement rate limiting for API endpoints",
			shared,
		);
		expect(slug).toBe("api-endpoints");
		shared.add(slug);

		slug = slugFromTaskWithExisting(
			"implement retry logic for API endpoints",
			shared,
		);
		// "api-endpoints" collides → "logic-api" (next 2-word tail)
		expect(slug).toBe("logic-api");
	});
});

describe("slugFromTask edge cases", () => {
	test("numeric characters preserved", () => {
		// "fix bug in v2 API" → meaningful: ["fix", "bug", "v2", "api"]
		// 2-word tail: "v2-api"
		expect(slugFromTask("fix bug in v2 API")).toBe("v2-api");
		// "add node20 support" → meaningful: ["add", "node20", "support"]
		// 2-word tail: "support-node20"
		expect(slugFromTask("add support for node20")).toBe("support-node20");
	});

	test("camelCase treated as one word", () => {
		// "fix loginPage bug" → meaningful: ["fix", "loginpage", "bug"]
		// 2-word tail: "loginpage-bug"
		expect(slugFromTask("fix loginPage bug")).toBe("loginpage-bug");
	});

	test("mixed case normalized", () => {
		expect(slugFromTask("Fix AUTH Bug")).toBe("auth-bug");
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
