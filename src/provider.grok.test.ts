import { describe, expect, it } from "vitest";

import {
  isPlausibleGrokResult,
  normalizeCategory,
  normalizeConfidence,
  normalizeGrokOutput,
  normalizeOutcome,
  normalizeRisk,
  normalizeSeverity,
  tryParseGrokStdout,
  unwrapGrokEnvelope,
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
});
