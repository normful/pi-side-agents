import { describe, expect, test } from "bun:test";
import {
	isBacklogSeparatorLine,
	normalizeWaitStates,
	nowIso,
	run,
	runOrThrow,
	shellQuote,
	sleep,
	splitLines,
	stringifyError,
	stripTerminalNoise,
	tailLines,
	tmuxWindowExists,
	truncateWithEllipsis,
} from "./utils.js";

describe("nowIso", () => {
	test("returns ISO 8601 timestamp", () => {
		const result = nowIso();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
	});
});

describe("sleep", () => {
	test("resolves after specified milliseconds", async () => {
		const start = Date.now();
		await sleep(50);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(45);
		expect(elapsed).toBeLessThan(150);
	});
});

describe("stringifyError", () => {
	test("returns Error.message for Error instances", () => {
		const err = new Error("test error");
		expect(stringifyError(err)).toBe("test error");
	});

	test("returns stringified value for non-Error", () => {
		expect(stringifyError("plain string")).toBe("plain string");
		expect(stringifyError(123)).toBe("123");
		expect(stringifyError(null)).toBe("null");
	});
});

describe("shellQuote", () => {
	test("wraps value in single quotes", () => {
		expect(shellQuote("hello")).toBe("'hello'");
	});

	test("escapes single quotes", () => {
		expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
	});

	test("handles empty string", () => {
		expect(shellQuote("")).toBe("''");
	});
});

describe("truncateWithEllipsis", () => {
	test("returns unchanged string if shorter than maxChars", () => {
		expect(truncateWithEllipsis("hello", 10)).toBe("hello");
	});

	test("returns unchanged string if equal to maxChars", () => {
		expect(truncateWithEllipsis("hello", 5)).toBe("hello");
	});

	test("truncates with ellipsis if longer than maxChars", () => {
		// Note: slice takes maxChars-1 chars, then adds ellipsis
		expect(truncateWithEllipsis("hello world", 8)).toBe("hello w…");
	});

	test("returns empty string for maxChars <= 0", () => {
		expect(truncateWithEllipsis("hello", 0)).toBe("");
		expect(truncateWithEllipsis("hello", -1)).toBe("");
	});

	test("returns ellipsis for maxChars === 1", () => {
		expect(truncateWithEllipsis("hello", 1)).toBe("…");
	});

	test("returns ellipsis for maxChars === 2", () => {
		// maxChars=2: text.slice(0,1) + "…" = "h…"
		expect(truncateWithEllipsis("hello", 2)).toBe("h…");
	});
});

describe("stripTerminalNoise", () => {
	test("removes ANSI CSI escape sequences", () => {
		expect(stripTerminalNoise("\x1b[31mmessage\x1b[0m")).toBe("message");
	});

	test("removes ANSI OSC escape sequences", () => {
		expect(stripTerminalNoise("\x1b]0;title\x1b\\")).toBe("");
	});

	test("removes carriage returns", () => {
		expect(stripTerminalNoise("line1\r\nline2")).toBe("line1\nline2");
	});

	test("removes control characters", () => {
		expect(stripTerminalNoise("hello\x00world")).toBe("helloworld");
	});
});

describe("splitLines", () => {
	test("splits on newlines", () => {
		expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
	});

	test("handles CRLF", () => {
		expect(splitLines("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
	});

	test("removes trailing empty line from single newline", () => {
		expect(splitLines("a\n")).toEqual(["a"]);
	});

	test("handles empty string", () => {
		expect(splitLines("")).toEqual([]);
	});

	test("handles only newlines", () => {
		// "\n\n".split() gives ["", "", ""], filter removes trailing empty
		expect(splitLines("\n\n")).toEqual(["", ""]);
	});
});

describe("isBacklogSeparatorLine", () => {
	test("returns true for lines with 5+ dashes", () => {
		expect(isBacklogSeparatorLine("-----")).toBe(true);
		expect(isBacklogSeparatorLine("-------")).toBe(true);
	});

	test("returns true for lines with 5+ other separator characters", () => {
		// Note: ─ (U+2500) and — (U+2014) are included in the regex
		// ═ (U+2550) is NOT included - different character
		expect(isBacklogSeparatorLine("─────")).toBe(true); // U+2500
		expect(isBacklogSeparatorLine("_____")).toBe(true); // U+005F
		expect(isBacklogSeparatorLine("═════")).toBe(false); // U+2550 - not in pattern
	});

	test("returns false for shorter separator lines", () => {
		expect(isBacklogSeparatorLine("----")).toBe(false);
	});

	test("returns false for text content", () => {
		expect(isBacklogSeparatorLine("hello")).toBe(false);
		expect(isBacklogSeparatorLine("text---more")).toBe(false);
	});
});

describe("normalizeWaitStates", () => {
	test("returns DEFAULT_WAIT_STATES when input is empty", () => {
		const result = normalizeWaitStates();
		expect(result.values).toEqual(["waiting_user", "failed", "crashed"]);
	});

	test("returns DEFAULT_WAIT_STATES when input is empty array", () => {
		const result = normalizeWaitStates([]);
		expect(result.values).toEqual(["waiting_user", "failed", "crashed"]);
	});

	test("returns DEFAULT_WAIT_STATES when all values are empty", () => {
		const result = normalizeWaitStates(["", "  "]);
		expect(result.values).toEqual(["waiting_user", "failed", "crashed"]);
	});

	test("accepts valid status values", () => {
		const result = normalizeWaitStates(["waiting_user", "done"]);
		expect(result.values).toEqual(["waiting_user", "done"]);
	});

	test("deduplicates values", () => {
		const result = normalizeWaitStates([
			"waiting_user",
			"waiting_user",
			"failed",
		]);
		expect(result.values).toEqual(["waiting_user", "failed"]);
	});

	test("trims whitespace", () => {
		const result = normalizeWaitStates(["  waiting_user  ", "failed"]);
		expect(result.values).toEqual(["waiting_user", "failed"]);
	});

	test("returns error for unknown status values", () => {
		const result = normalizeWaitStates(["unknown_status"]);
		expect(result.error).toContain("Unknown status value(s): unknown_status");
	});

	test("returns empty values array when invalid", () => {
		const result = normalizeWaitStates(["invalid"]);
		expect(result.values).toEqual([]);
	});
});

describe("tailLines", () => {
	test("returns last n lines", () => {
		expect(tailLines("a\nb\nc\nd\ne", 3)).toEqual(["c", "d", "e"]);
	});

	test("returns all lines if count exceeds total", () => {
		expect(tailLines("a\nb\nc", 10)).toEqual(["a", "b", "c"]);
	});

	test("handles single line", () => {
		expect(tailLines("only", 5)).toEqual(["only"]);
	});

	test("handles empty string", () => {
		expect(tailLines("", 5)).toEqual([]);
	});
});

describe("run", () => {
	test("returns successful result for valid command", () => {
		const result = run("echo", ["hello"]);
		expect(result.ok).toBe(true);
		expect(result.stdout.trim()).toBe("hello");
		expect(result.stderr).toBe("");
	});

	test("returns failed result for invalid command", () => {
		const result = run("nonexistent-command-xyz", []);
		expect(result.ok).toBe(false);
		expect(result.error).toBeDefined();
	});

	test("captures stderr", () => {
		const result = run("sh", ["-c", "echo error >&2"]);
		expect(result.stderr.trim()).toBe("error");
	});

	test("passes input via stdin", () => {
		const result = run("cat", [], { input: "test input" });
		expect(result.stdout.trim()).toBe("test input");
	});

	test("respects cwd option", () => {
		const result = run("pwd", [], { cwd: "/tmp" });
		expect(result.ok).toBe(true);
		// On macOS /tmp is symlinked to /private/tmp
		expect(result.stdout.trim()).toMatch(/^\/(?:private\/)?tmp$/);
	});
});

describe("runOrThrow", () => {
	test("returns result for successful command", () => {
		const result = runOrThrow("echo", ["hello"]);
		expect(result.ok).toBe(true);
	});

	test("throws for failed command", () => {
		expect(() => runOrThrow("false", [])).toThrow();
	});
});

describe("tmuxWindowExists", () => {
	test("returns false for invalid window id", () => {
		// Note: This test assumes tmux is available
		const result = tmuxWindowExists("@invalid-window-id-12345");
		expect(result).toBe(false);
	});
});
