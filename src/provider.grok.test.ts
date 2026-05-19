import { describe, expect, it } from "vitest";

import {
  GROK_READ_ONLY_DISALLOWED_TOOLS,
  isPlausibleGrokResult,
  normalizeCategory,
  normalizeConfidence,
  normalizeGrokOutput,
  normalizeOutcome,
  normalizeRisk,
  normalizeSeverity,
  tryParseGrokStdout,
  unwrapGrokEnvelope,
  grokEnvelopeText,
  extractJson,
  extractLastJson,
} from "./provider.js";

describe("grok provider — normalization (the reliability layer)", () => {
  describe("normalizeCategory", () => {
    it("passes through exact allowed categories", () => {
      expect(normalizeCategory("concurrency")).toBe("concurrency");
      expect(normalizeCategory("maintainability")).toBe("maintainability");
      expect(normalizeCategory("bug")).toBe("bug");
    });

    it("is case-insensitive for exact matches", () => {
      expect(normalizeCategory("Concurrency")).toBe("concurrency");
      expect(normalizeCategory("DATA-LOSS")).toBe("data-loss");
    });

    it("maps common LLM aliases for concurrency (the most frequent hallucination class)", () => {
      expect(normalizeCategory("race condition")).toBe("concurrency");
      expect(normalizeCategory("spawn context")).toBe("concurrency");
      expect(normalizeCategory("ProcessPoolExecutor without spawn")).toBe("concurrency");
      expect(normalizeCategory("multiprocessing issue")).toBe("concurrency");
    });

    it("maps performance, security, data, gap, and contract aliases", () => {
      expect(normalizeCategory("bottleneck")).toBe("performance");
      expect(normalizeCategory("sql injection")).toBe("security");
      expect(normalizeCategory("data corruption")).toBe("data-loss");
      expect(normalizeCategory("missing test coverage")).toBe("test-gap");
      expect(normalizeCategory("docstring is wrong")).toBe("docs-gap");
      expect(normalizeCategory("api contract mismatch")).toBe("api-contract");
    });

    it("uses keyword rules for descriptive phrases the model invents", () => {
      expect(normalizeCategory("Unsafe parallel conversion using fork")).toBe("concurrency");
      expect(normalizeCategory("High latency in hot path")).toBe("performance");
      expect(normalizeCategory("Auth bypass in admin endpoint")).toBe("security");
      expect(normalizeCategory("Schema violation on TradeTick")).toBe("api-contract");
    });

    it("falls back safely to maintainability for unknown phrases", () => {
      expect(normalizeCategory("some completely novel made-up category")).toBe("maintainability");
      expect(normalizeCategory("")).toBe("maintainability");
    });
  });

  describe("normalizeSeverity / Confidence / Risk / Outcome", () => {
    it("normalizes severity synonyms", () => {
      expect(normalizeSeverity("severe")).toBe("critical");
      expect(normalizeSeverity("med")).toBe("medium");
      expect(normalizeSeverity("minor")).toBe("low");
      expect(normalizeSeverity("unknown-word")).toBe("medium");
    });

    it("normalizes confidence", () => {
      expect(normalizeConfidence("certain")).toBe("high");
      expect(normalizeConfidence("guess")).toBe("low");
      expect(normalizeConfidence("med")).toBe("medium");
    });

    it("normalizes risk", () => {
      expect(normalizeRisk("dangerous")).toBe("high");
      expect(normalizeRisk("safe")).toBe("low");
    });

    it("normalizes revalidate outcomes", () => {
      expect(normalizeOutcome("resolved")).toBe("fixed");
      expect(normalizeOutcome("false positive")).toBe("false-positive");
      expect(normalizeOutcome("not a bug")).toBe("false-positive");
      expect(normalizeOutcome("unknown")).toBe("uncertain");
    });
  });

  describe("normalizeGrokOutput (full object)", () => {
    it("normalizes findings and preserves originalCategory when changed", () => {
      const input = {
        findings: [
          {
            title: "Bad spawn",
            category: "race condition",
            severity: "high",
            confidence: "high",
            evidence: [],
            reasoning: "",
            reproduction: null,
            recommendation: "",
            whyTestsDoNotAlreadyCoverThis: "",
            suggestedRegressionTest: "",
            minimumFixScope: "",
          },
          {
            title: "Docs",
            category: "docstring",
            severity: "low",
            confidence: "medium",
            evidence: [],
            reasoning: "",
            reproduction: null,
            recommendation: "",
            whyTestsDoNotAlreadyCoverThis: "",
            suggestedRegressionTest: "",
            minimumFixScope: "",
          },
        ],
        inspected: { files: [], symbols: [], notes: [] },
      };

      const out = normalizeGrokOutput(input) as any;

      expect(out.findings[0].category).toBe("concurrency");
      expect(out.findings[0].originalCategory).toBe("race condition");

      expect(out.findings[1].category).toBe("docs-gap");
      expect(out.findings[1].originalCategory).toBe("docstring");
    });

    it("normalizes top-level risk and outcome fields", () => {
      const fixInput = {
        risk: "dangerous",
        steps: [],
        findingIds: [],
        plannedFiles: [],
        summary: "",
        validationCommands: [],
      };
      expect((normalizeGrokOutput(fixInput) as any).risk).toBe("high");

      const revalInput = { outcome: "resolved", reasoning: "", commands: [] };
      expect((normalizeGrokOutput(revalInput) as any).outcome).toBe("fixed");
    });
  });
});

describe("grok provider — structural plausibility and stdout extraction", () => {
  it("isPlausibleGrokResult accepts review, fix, and revalidate shapes (review now requires inspected)", () => {
    expect(isPlausibleGrokResult({ findings: [], inspected: {} })).toBe(true);
    expect(isPlausibleGrokResult({ findings: [1, 2], inspected: { files: [] } })).toBe(true);
    expect(isPlausibleGrokResult({ summary: "x", steps: [] })).toBe(true);
    expect(isPlausibleGrokResult({ outcome: "fixed", reasoning: "" })).toBe(true);
    expect(isPlausibleGrokResult({ foo: "bar" })).toBe(false);
    expect(isPlausibleGrokResult({ findings: [] })).toBe(false); // missing inspected
    expect(isPlausibleGrokResult(null)).toBe(false);
  });

  it("unwrapGrokEnvelope extracts the inner text from the common CLI envelope", () => {
    const envelope = JSON.stringify({ text: 'some reasoning {"findings":[]}' });
    expect(unwrapGrokEnvelope(envelope)).toContain("findings");
    expect(unwrapGrokEnvelope("plain text")).toBe("plain text");
  });

  it("tryParseGrokStdout succeeds on clean JSON and on common LLM-flawed cases via jsonrepair", () => {
    const clean = '{"findings":[],"inspected":{"files":[]}}';
    expect(tryParseGrokStdout(clean)).toBeTruthy();

    // Slightly broken (missing quote, trailing comma) — jsonrepair should rescue it
    const messy = '{"findings": [{"title": "x", "category": "bug" }],}';
    const parsed = tryParseGrokStdout(messy) as any;
    expect(parsed).toBeTruthy();
    expect(parsed.findings[0].title).toBe("x");
  });

  describe("hybrid extraction helpers (grokEnvelopeText + extract*Json + selection)", () => {
    it("grokEnvelopeText pulls from common envelope keys and OpenAI-style choices", () => {
      expect(grokEnvelopeText({ text: "hello {json}" })).toBe("hello {json}");
      expect(grokEnvelopeText({ response: "r" })).toBe("r");
      expect(grokEnvelopeText({ content: "c" })).toBe("c");
      expect(grokEnvelopeText({ output: "o" })).toBe("o");
      expect(grokEnvelopeText({ choices: [{ message: { content: "ch" } }] })).toBe("ch");
      expect(grokEnvelopeText("plain string")).toBe("plain string");
      expect(grokEnvelopeText({ foo: 1 })).toBeNull();
    });

    it("extractJson recovers from direct JSON, fences, and interleaved reasoning", () => {
      expect(extractJson('{"findings":[]}')).toEqual({ findings: [] });
      expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
      const interleaved = 'thinking... {"early": "frag"} then the real {"findings":[1]} end';
      expect(extractJson(interleaved)).toEqual({ early: "frag" }); // first object (documented behaviour)
    });

    it("extractLastJson recovers the final balanced object (the typical authoritative result)", () => {
      const interleaved = 'thinking... {"early": "frag"} then the real {"findings":[42]} end';
      expect(extractLastJson(interleaved)).toEqual({ findings: [42] });
      expect(extractLastJson('{"only":true}')).toEqual({ only: true });
    });

    it("selection inside tryParseGrokStdout favours the last plausible object (addresses earlier-fragment fragility)", () => {
      // When the model's `text` envelope contains both an early plausible object (e.g. CoT example
      // or prompt fragment) and the real authoritative result later, the "last plausible wins"
      // preference (via extractLastJson + reverse scan for isPlausibleGrokResult) must pick the later one.
      // This directly exercises the fix for the "first-brace JSON extraction latches on earlier fragments" pattern.
      const earlyPlausible = { findings: [], inspected: { files: [], symbols: [], notes: [] } };
      const latePlausible = {
        findings: [
          {
            title: "real result after CoT",
            category: "bug",
            severity: "low",
            confidence: "high",
            evidence: [],
            reasoning: "r",
            reproduction: null,
            recommendation: "rec",
            whyTestsDoNotAlreadyCoverThis: "w",
            suggestedRegressionTest: "s",
            minimumFixScope: "m",
          },
        ],
        inspected: { files: [], symbols: [], notes: [] },
      };
      const prose = `Some CoT reasoning here with example ${JSON.stringify(earlyPlausible)} then the actual output ${JSON.stringify(latePlausible)}`;
      const result = tryParseGrokStdout(prose) as any;
      expect(result).toBeTruthy();
      // Must have selected the *late* object (distinguished by its unique title) via extractLastJson + plausible preference
      expect(result.findings?.[0]?.title).toBe("real result after CoT");
    });

    it("brace scanner inside extract*Json is string/escape-aware", () => {
      const withEscapes = 'prefix {"s":"a\\"b{c"} suffix {"good":true}';
      expect(extractJson(withEscapes)).toEqual({ s: 'a"b{c' });
      expect(extractLastJson(withEscapes)).toEqual({ good: true });
    });

    // --- Additional coverage for 3-pass selection (rootKeys + last-candidate fallbacks) ---
    it("tryParse selection falls back to last rootKey-bearing object when no candidates are plausible", () => {
      const early = { foo: 1, findings: "not-an-array" };
      const lateWithSummary = { summary: "fix plan for the thing", steps: [] };
      const prose = `CoT ${JSON.stringify(early)} result ${JSON.stringify(lateWithSummary)}`;
      const result = tryParseGrokStdout(prose) as any;
      expect(result.summary).toBe("fix plan for the thing");
    });

    it("tryParse selection returns the overall last candidate when none have plausible shape or root keys", () => {
      const first = { random: "a" };
      const second = { other: "b" };
      const prose = `text ${JSON.stringify(first)} more ${JSON.stringify(second)}`;
      const result = tryParseGrokStdout(prose) as any;
      expect(result).toEqual({ other: "b" });
    });

    // --- Edge cases for the three pure extraction helpers (grokEnvelopeText, extract*, tryParse envelope) ---
    it("grokEnvelopeText handles missing keys, arrays, non-objects, and key priority", () => {
      expect(grokEnvelopeText({ text: "t", response: "r" })).toBe("t"); // first key wins
      expect(grokEnvelopeText({ choices: [] })).toBeNull();
      expect(grokEnvelopeText({ choices: [{}] })).toBeNull();
      expect(grokEnvelopeText({ choices: [{ message: {} }] })).toBeNull();
      expect(grokEnvelopeText(42)).toBeNull();
      expect(grokEnvelopeText(["a"])).toBeNull();
    });

    it("extractJson and extractLastJson return null cleanly for no braces, unbalanced, and bad fences", () => {
      expect(extractJson("no json here at all")).toBeNull();
      expect(extractLastJson("no json here at all")).toBeNull();
      expect(extractJson("{ unbalanced")).toBeNull();
      expect(extractLastJson("unbalanced {")).toBeNull();
      expect(extractJson('```json\n{"bad"}\n```')).toBeNull(); // fence inner fails parse, falls through
      expect(extractLastJson('```json\n{"bad"}\n```')).toBeNull();
    });

    it("extract*Json fast-path handles top-level arrays and primitives", () => {
      expect(extractJson('[{"a":1}]')).toEqual([{ a: 1 }]);
      // Direct JSON.parse passthrough on the fast path (even for primitives / non-objects)
      expect(extractLastJson('42')).toBe(42);
    });

    it("tryParseGrokStdout on a valid outer envelope object returns the envelope (step-1 short-circuit)", () => {
      const env = { text: 'reasoning {"findings": []}' };
      const result = tryParseGrokStdout(JSON.stringify(env));
      expect(result).toEqual(env); // current design: direct JSON wins, selection only on prose
    });

    // --- Regression test for the read-only security boundary (verifies the constant used by --disallowed-tools) ---
    it("GROK_READ_ONLY_DISALLOWED_TOOLS contains exactly the three documented dangerous tools", () => {
      expect(GROK_READ_ONLY_DISALLOWED_TOOLS).toBe("search_replace,run_terminal_cmd,Agent");
      const tools = GROK_READ_ONLY_DISALLOWED_TOOLS.split(",");
      expect(tools).toEqual(["search_replace", "run_terminal_cmd", "Agent"]);
    });
  });
});
