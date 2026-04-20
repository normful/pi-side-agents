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

describe("slugFromTask (tail-first sliding window, min 4 words)", () => {
	test("empty task falls back to 'agent'", () => {
		expect(slugFromTask("")).toBe("agent");
		expect(slugFromTask("a the of for")).toBe("agent"); // all stop words
	});

	test("two meaningful words — falls back to 2-word window", () => {
		expect(slugFromTask("fix bug")).toBe("fix-bug"); // size 2 fallback
		expect(slugFromTask("the login bug")).toBe("login-bug"); // size 2 tail
	});

	test("three meaningful words — 3-word window", () => {
		expect(slugFromTask("implement dark mode")).toBe("implement-dark-mode"); // size 3
		expect(slugFromTask("add dark mode")).toBe("add-dark-mode"); // size 3
		expect(slugFromTask("fix auth bug")).toBe("fix-auth-bug"); // size 3
	});

	test("four meaningful words — 4-word window (only one possible)", () => {
		// "write tests for login page" → meaningful: ["write", "tests", "login", "page"]
		// Only one 4-word window: "write-tests-login-page"
		expect(slugFromTask("write tests for login page")).toBe(
			"write-tests-login-page",
		);
	});

	test("more than four words — 4-word tail preferred", () => {
		// "implement dark mode toggle for settings page"
		// meaningful: ["implement", "dark", "mode", "toggle", "settings", "page"]
		// 4-word tail windows (tail→head):
		// start=2: "mode-toggle-settings-page"
		// start=1: "dark-mode-toggle-settings"
		// start=0: "implement-dark-mode-toggle"
		// Preferred: "mode-toggle-settings-page"
		expect(
			slugFromTask("implement dark mode toggle for settings page"),
		).toBe("mode-toggle-settings-page");
	});

	test("three words — 3-word window", () => {
		// "clean up codebase" → meaningful: ["clean", "up", "codebase"]
		// Only 3 words — 3-word window: "clean-up-codebase"
		expect(slugFromTask("clean up codebase")).toBe("clean-up-codebase");
	});

	test("stop words filtered out before windowing", () => {
		// "add dark mode to settings" → meaningful: ["add", "dark", "mode", "settings"]
		// 4-word: "add-dark-mode-settings"
		expect(slugFromTask("add dark mode to settings")).toBe(
			"add-dark-mode-settings",
		);
	});

	test("punctuation stripped correctly", () => {
		// "fix auth bug!" → meaningful: ["fix", "auth", "bug"]
		// 3-word: "fix-auth-bug"
		expect(slugFromTask("fix auth bug!")).toBe("fix-auth-bug");
		// "write tests: login page" → meaningful: ["write", "tests", "login", "page"]
		// 4-word: "write-tests-login-page"
		expect(slugFromTask("write tests: login page")).toBe(
			"write-tests-login-page",
		);
		// "implement 'dark mode' for settings" → meaningful: ["implement", "dark", "mode", "settings"]
		// 4-word: "implement-dark-mode-settings" ("for" is a stop word)
		expect(slugFromTask("implement 'dark mode' for settings")).toBe(
			"implement-dark-mode-settings",
		);
	});
});

describe("slugFromTaskWithExisting — collision avoidance", () => {
	test("no collision — behaves like slugFromTask", () => {
		const existing = new Set<string>();
		expect(
			slugFromTaskWithExisting("write tests for login page", existing),
		).toBe("write-tests-login-page");
	});

	test("collision — slides to next unique window of same size", () => {
		const existing = new Set<string>(["write-tests-login-page"]);
		// "write tests for login page"
		// 4-word windows: only "write-tests-login-page" (collide)
		// → fall to 3-word: "tests-login-page" (unique!) — checked before "write-tests-login"
		expect(
			slugFromTaskWithExisting("write tests for login page", existing),
		).toBe("tests-login-page");
	});

	test("size-4 collision — slides to next unique 4-word, then size-3", () => {
		const existing = new Set<string>(["implement-dark-mode-settings"]);
		// "implement dark mode for settings"
		// 4-word: "implement-dark-mode-settings" (collide) — no other 4-word windows
		// → fall to 3-word: "dark-mode-settings" (unique!)
		expect(
			slugFromTaskWithExisting("implement dark mode for settings", existing),
		).toBe("dark-mode-settings");
	});

	test("all windows collide — slides to next smaller size before dedup", () => {
		const existing = new Set<string>([
			"write-tests-login-page",
			"tests-login-page",
			"tests-login",
			"write-tests-login",
			"login-page",
			"write-tests",
			"page",
			"login",
			"tests",
			"write",
		]);
		// All size 4, 3, 2, 1 collide → dedup on best candidate: "write-tests-login-page" + -2
		expect(
			slugFromTaskWithExisting("write tests for login page", existing),
		).toBe("write-tests-login-page-2");
	});

	test("numeric dedup only when every candidate collides", () => {
		const existing = new Set<string>([
			"write-tests-login-page",
			"tests-login-page",
			"tests-login",
			"write-tests-login",
			"login-page",
			"write-tests",
			"page",
			"login",
			"tests",
			"write",
			"write-tests-login-page-2",
		]);
		// Every candidate collides. Dedup applies to the best candidate:
		// "write-tests-login-page" (first in priority order, 4-word).
		expect(
			slugFromTaskWithExisting("write tests for login page", existing),
		).toBe("write-tests-login-page-3");
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

		// Tail-first uses 4-word windows (or falls back to 3-word when < 4 words)
		expect(slugFromTask("write tests for login page")).toBe(
			"write-tests-login-page",
		);
		expect(slugFromTask("write tests for signup page")).toBe(
			"write-tests-signup-page",
		);
		// "for" is a stop word, so "write tests for dashboard" → ["write", "tests", "dashboard"]
		// Only 3 words → 3-word window: "write-tests-dashboard"
		expect(slugFromTask("write tests for dashboard")).toBe(
			"write-tests-dashboard",
		);
	});

	test("verb-heavy prompts — dedup via shared Set", () => {
		// Caller must add each result to the shared Set for cross-call dedup.
		const shared = new Set<string>();

		let slug = slugFromTaskWithExisting(
			"add dark mode to settings page",
			shared,
		);
		expect(slug).toBe("dark-mode-settings-page");
		shared.add(slug); // ← caller responsibility

		slug = slugFromTaskWithExisting("add light mode to settings page", shared);
		// "dark-mode-settings-page" collides → "light-mode-settings-page" (next 4-word tail)
		expect(slug).toBe("light-mode-settings-page");
		shared.add(slug);

		slug = slugFromTaskWithExisting(
			"add theme toggle to settings page",
			shared,
		);
		// "dark-mode-settings-page" and "light-mode-settings-page" collide
		// 4-word: "theme-toggle-settings-page" → unique (tail-most available)
		expect(slug).toBe("theme-toggle-settings-page");
	});

	test("three words — 3-word window", () => {
		// "clean up codebase" → meaningful: ["clean", "up", "codebase"]
		// 3-word: "clean-up-codebase"
		expect(slugFromTask("clean up codebase")).toBe("clean-up-codebase");
	});

	test("mixed — shared Set drives cross-task differentiation", () => {
		// Caller must add each result to the shared Set for cross-call dedup.
		const shared = new Set<string>();

		let slug = slugFromTaskWithExisting(
			"implement rate limiting for API endpoints",
			shared,
		);
		// "implement rate limiting for API endpoints" → ["implement", "rate", "limiting", "api", "endpoints"]
		// 4-word tail: "rate-limiting-api-endpoints"
		expect(slug).toBe("rate-limiting-api-endpoints");
		shared.add(slug);

		slug = slugFromTaskWithExisting(
			"implement retry logic for API endpoints",
			shared,
		);
		// "implement retry logic for API endpoints" → ["implement", "retry", "logic", "api", "endpoints"]
		// 4-word tail: "retry-logic-api-endpoints"
		expect(slug).toBe("retry-logic-api-endpoints");
	});
});

describe("slugFromTask edge cases", () => {
	test("numeric characters preserved", () => {
		// "fix bug in v2 API" → meaningful: ["fix", "bug", "v2", "api"]
		// 4-word: "fix-bug-v2-api"
		expect(slugFromTask("fix bug in v2 API")).toBe("fix-bug-v2-api");
		// "add support for node20" → meaningful: ["add", "support", "node20"]
		// 3-word: "add-support-node20"
		expect(slugFromTask("add support for node20")).toBe("add-support-node20");
	});

	test("camelCase treated as one word", () => {
		// "fix loginPage bug" → meaningful: ["fix", "loginpage", "bug"]
		// 3-word: "fix-loginpage-bug"
		expect(slugFromTask("fix loginPage bug")).toBe("fix-loginpage-bug");
	});

	test("mixed case normalized", () => {
		// "Fix AUTH Bug" → meaningful: ["fix", "auth", "bug"]
		// 3-word: "fix-auth-bug"
		expect(slugFromTask("Fix AUTH Bug")).toBe("fix-auth-bug");
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
