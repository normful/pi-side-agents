import { describe, expect, test } from "bun:test";
import {
	collectRecentBacklogLines,
	normalizeGeneratedSummary,
	sanitizeBacklogLines,
	selectBacklogTailLines,
	summarizeTask,
} from "./prompt.js";

describe("normalizeGeneratedSummary", () => {
	test("strips ANSI codes", () => {
		const raw = "\x1b[31mError message\x1b[0m";
		expect(normalizeGeneratedSummary(raw)).toBe("Error message");
	});

	test("extracts fenced code block content", () => {
		const raw = "```markdown\nSummary content\n```";
		expect(normalizeGeneratedSummary(raw)).toBe("Summary content");
	});

	test("handles unfenced content", () => {
		expect(normalizeGeneratedSummary("Simple summary")).toBe("Simple summary");
	});

	test("returns empty for NONE responses", () => {
		expect(normalizeGeneratedSummary("NONE")).toBe("");
		expect(normalizeGeneratedSummary("none")).toBe("");
		expect(normalizeGeneratedSummary("N/A")).toBe("");
		expect(normalizeGeneratedSummary("unrelated")).toBe("");
	});

	test("collapses multiple blank lines", () => {
		const raw = "Line 1\n\n\n\nLine 2\n\n\nLine 3";
		const result = normalizeGeneratedSummary(raw);
		// Should only have single blank lines
		expect(result).toContain("Line 1");
		expect(result).toContain("Line 2");
	});

	test("limits to MAX_LINES", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join(
			"\n",
		);
		const result = normalizeGeneratedSummary(lines);
		const resultLines = result.split("\n");
		expect(resultLines.length).toBeLessThanOrEqual(10);
	});

	test("truncates to MAX_CHARS", () => {
		const longText = "a".repeat(1000);
		const result = normalizeGeneratedSummary(longText);
		expect(result.length).toBeLessThanOrEqual(700);
	});
});

describe("summarizeTask", () => {
	test("collapses whitespace", () => {
		expect(summarizeTask("hello    world")).toBe("hello world");
	});

	test("strips ANSI codes", () => {
		expect(summarizeTask("\x1b[32mgreen text\x1b[0m normal")).toBe(
			"green text normal",
		);
	});

	test("truncates to TASK_PREVIEW_MAX_CHARS", () => {
		const longTask = "a".repeat(300);
		expect(summarizeTask(longTask).length).toBeLessThanOrEqual(220);
	});

	test("ends with ellipsis if truncated", () => {
		const longTask = "a".repeat(300);
		expect(summarizeTask(longTask)).toContain("…");
	});

	test("returns unchanged short task", () => {
		expect(summarizeTask("Fix the bug")).toBe("Fix the bug");
	});
});

describe("sanitizeBacklogLines", () => {
	test("removes empty lines", () => {
		const lines = ["line1", "", "line2"];
		const result = sanitizeBacklogLines(lines);
		expect(result).toEqual(["line1", "line2"]);
	});

	test("removes separator lines", () => {
		const lines = ["line1", "-----", "line2"];
		const result = sanitizeBacklogLines(lines);
		expect(result).toEqual(["line1", "line2"]);
	});

	test("strips ANSI codes", () => {
		const lines = ["\x1b[31mred\x1b[0m line"];
		const result = sanitizeBacklogLines(lines);
		expect(result).toEqual(["red line"]);
	});

	test("truncates long lines to BACKLOG_LINE_MAX_CHARS", () => {
		const lines = ["a".repeat(500)];
		const result = sanitizeBacklogLines(lines);
		expect(result[0]!.length).toBeLessThanOrEqual(240);
	});

	test("limits total characters to BACKLOG_TOTAL_MAX_CHARS", () => {
		const lines = Array.from(
			{ length: 50 },
			(_, i) => `Line ${i}: ${"x".repeat(100)}`,
		);
		const result = sanitizeBacklogLines(lines);
		const totalLength = result.reduce((sum, line) => sum + line.length, 0);
		expect(totalLength).toBeLessThanOrEqual(2400);
	});

	test("handles empty input", () => {
		expect(sanitizeBacklogLines([])).toEqual([]);
	});
});

describe("selectBacklogTailLines", () => {
	test("returns last n lines", () => {
		const text = "a\nb\nc\nd\ne";
		const result = selectBacklogTailLines(text, 3);
		expect(result).toEqual(["c", "d", "e"]);
	});

	test("handles CRLF", () => {
		const text = "a\r\nb\r\nc";
		const result = selectBacklogTailLines(text, 2);
		expect(result).toEqual(["b", "c"]);
	});
});

describe("collectRecentBacklogLines", () => {
	test("returns last n non-empty lines", () => {
		const lines = ["a", "", "b", "", "c", "", "d", "e"];
		const result = collectRecentBacklogLines(lines, 3);
		expect(result).toEqual(["c", "d", "e"]);
	});

	test("skips separator lines", () => {
		const lines = ["a", "-----", "b", "c"];
		const result = collectRecentBacklogLines(lines, 2);
		expect(result).toEqual(["b", "c"]);
	});

	test("returns empty for 0 minimum", () => {
		const lines = ["a", "b", "c"];
		const result = collectRecentBacklogLines(lines, 0);
		expect(result).toEqual([]);
	});

	test("returns original lines (ANSI codes not stripped for comparison)", () => {
		// collectRecentBacklogLines preserves original lines
		const lines = ["a", "\x1b[31mb\x1b[0m", "c"];
		const result = collectRecentBacklogLines(lines, 2);
		// Returns original lines, not stripped ones
		expect(result.length).toBe(2);
		expect(result[1]).toBe("c");
	});
});
