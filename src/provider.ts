import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonrepair } from "jsonrepair";
import { runCommandArgs } from "./exec.js";
import { ClawpatchError } from "./errors.js";
import {
  agentMapJsonSchema,
  fixPlanJsonSchema,
  providerJsonSchema,
  reviewJsonSchema,
  revalidateJsonSchema,
} from "./provider-schema.js";
import { extractJson, parseCodexJson, safeProviderPreview } from "./provider-json.js";
import {
  AgentMapOutput,
  FixPlanOutput,
  ReviewOutput,
  RevalidateOutput,
  agentMapOutputSchema,
  findingCategories,
  fixPlanOutputSchema,
  reviewOutputSchema,
  revalidateOutputSchema,
  type ReasoningEffort,
} from "./types.js";

export { extractJson } from "./provider-json.js";

export type ProviderOptions = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  skipGitRepoCheck: boolean;
};
export type Provider = {
  name: string;
  check(root: string): Promise<string>;
  map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput>;
  review(root: string, prompt: string, options: ProviderOptions): Promise<ReviewOutput>;
  fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput>;
  revalidate(root: string, prompt: string, options: ProviderOptions): Promise<RevalidateOutput>;
};

export function providerByName(name: string): Provider {
  if (name === "codex") {
    return codexProvider;
  }
  if (name === "opencode") {
    return opencodeProvider;
  }
  if (name === "acpx") {
    return acpxProvider;
  }
  if (name === "grok") {
    return grokProvider;
  }
  if (name === "pi") {
    return piProvider;
  }
  if (name === "mock") {
    return mockProvider;
  }
  if (name === "mock-fail") {
    return mockFailProvider;
  }
  throw new ClawpatchError(`unsupported provider: ${name}`, 2, "unsupported-provider");
}

const codexProvider: Provider = {
  name: "codex",
  async check(root: string): Promise<string> {
    const result = await runCommandArgs("codex", ["--version"], root);
    if (result.exitCode !== 0) {
      throw new ClawpatchError("codex CLI not available", 4, "provider-auth");
    }
    return result.stdout.trim();
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runCodexJson(root, prompt, options, agentMapJsonSchema);
    return agentMapOutputSchema.parse(output);
  },
  async review(root: string, prompt: string, options: ProviderOptions): Promise<ReviewOutput> {
    const output = await runCodexJson(root, prompt, options, reviewJsonSchema);
    return reviewOutputSchema.parse(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runCodexJson(root, prompt, options, fixPlanJsonSchema, "workspace-write");
    return fixPlanOutputSchema.parse(output);
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runCodexJson(root, prompt, options, revalidateJsonSchema);
    return revalidateOutputSchema.parse(output);
  },
};

const opencodeProvider: Provider = {
  name: "opencode",
  async check(root: string): Promise<string> {
    const result = await runCommandArgs("opencode", ["--version"], root);
    if (result.exitCode !== 0) {
      throw new ClawpatchError("opencode CLI not available", 4, "provider-auth");
    }
    return result.stdout.trim();
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, agentMapJsonSchema, true);
    return agentMapOutputSchema.parse(output);
  },
  async review(root: string, prompt: string, options: ProviderOptions): Promise<ReviewOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, reviewJsonSchema, true);
    return reviewOutputSchema.parse(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, fixPlanJsonSchema, false);
    return fixPlanOutputSchema.parse(output);
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, revalidateJsonSchema, true);
    return revalidateOutputSchema.parse(output);
  },
};

const ACPX_TESTED_VERSIONS = "^0.8.0";
const ACPX_DEFAULT_TIMEOUT_MS = 180_000;

const acpxProvider: Provider = {
  name: "acpx",
  async check(root: string): Promise<string> {
    const result = await runCommandArgs("acpx", ["--version"], root);
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        "acpx CLI not available. Install: npm install -g acpx@latest",
        4,
        "provider-auth",
      );
    }
    const version = result.stdout.trim();
    return `${version} (tested against ${ACPX_TESTED_VERSIONS})`;
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runAcpxJson(root, prompt, options.model, agentMapJsonSchema, "read");
    return agentMapOutputSchema.parse(output);
  },
  async review(root: string, prompt: string, options: ProviderOptions): Promise<ReviewOutput> {
    const output = await runAcpxJson(root, prompt, options.model, reviewJsonSchema, "read");
    return reviewOutputSchema.parse(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runAcpxJson(root, prompt, options.model, fixPlanJsonSchema, "approve");
    return fixPlanOutputSchema.parse(output);
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runAcpxJson(root, prompt, options.model, revalidateJsonSchema, "read");
    return revalidateOutputSchema.parse(output);
  },
};

const grokProvider: Provider = {
  name: "grok",
  async check(root: string): Promise<string> {
    const result = await runCommandArgs("grok", ["--version"], root);
    if (result.exitCode !== 0) {
      throw new ClawpatchError("grok CLI not available", 4, "provider-auth");
    }
    return result.stdout.trim();
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runGrokJson(root, prompt, options.model, agentMapJsonSchema, true);
    return agentMapOutputSchema.parse(output);
  },
  async review(root: string, prompt: string, options: ProviderOptions): Promise<ReviewOutput> {
    const output = await runGrokJson(root, prompt, options.model, reviewJsonSchema, true);
    return reviewOutputSchema.parse(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runGrokJson(root, prompt, options.model, fixPlanJsonSchema, false);
    return fixPlanOutputSchema.parse(output);
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runGrokJson(root, prompt, options.model, revalidateJsonSchema, true);
    return revalidateOutputSchema.parse(output);
  },
};

export const GROK_READ_ONLY_DISALLOWED_TOOLS = "search_replace,run_terminal_cmd,Agent";

const PI_DEFAULT_TIMEOUT_MS = 180_000;

const piProvider: Provider = {
  name: "pi",
  async check(root: string): Promise<string> {
    const result = await runCommandArgs("pi", ["--version"], root);
    if (result.exitCode !== 0) {
      throw new ClawpatchError("pi CLI not available", 4, "provider-auth");
    }
    return result.stdout.trim() || result.stderr.trim();
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runPiJson(root, prompt, options, agentMapJsonSchema, true);
    return agentMapOutputSchema.parse(output);
  },
  async review(root: string, prompt: string, options: ProviderOptions): Promise<ReviewOutput> {
    const output = await runPiJson(root, prompt, options, reviewJsonSchema, true);
    return reviewOutputSchema.parse(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runPiJson(root, prompt, options, fixPlanJsonSchema, false);
    return fixPlanOutputSchema.parse(output);
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runPiJson(root, prompt, options, revalidateJsonSchema, true);
    return revalidateOutputSchema.parse(output);
  },
};

async function runPiJson(
  root: string,
  prompt: string,
  options: ProviderOptions,
  schema: object,
  readOnly: boolean,
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-pi-"));
  const promptPath = join(dir, "prompt.txt");
  await writeFile(promptPath, piPrompt(prompt, schema, readOnly), "utf8");

  try {
    const args = [
      "-p",
      "--no-session",
      "--no-context-files",
      "--no-skills",
      "--no-extensions",
      "--no-prompt-templates",
      "--no-themes",
      `@${promptPath}`,
      "Follow the attached clawpatch prompt. Return only the requested JSON object.",
    ];
    if (options.model !== null) {
      args.push("--model", options.model);
    }
    if (options.reasoningEffort !== null) {
      args.push("--thinking", piThinkingLevel(options.reasoningEffort));
    }
    if (readOnly) {
      args.push("--tools", "read");
    }
    const result = await runCommandArgs("pi", args, root, undefined, {
      trimOutput: false,
      timeoutMs: piTimeoutMs(),
    });
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        piFailureMessage(result.stdout, result.stderr),
        providerExitCode(result.stderr),
        "provider-failure",
      );
    }
    const text = result.stdout.trim();
    if (text.length === 0) {
      throw new ClawpatchError("pi provider produced no output", 8, "malformed-output");
    }
    const parsed = extractJson(text);
    if (parsed === null) {
      throw new ClawpatchError(
        `pi provider produced unparsable JSON (output preview: ${safeProviderPreview(text)})`,
        8,
        "malformed-output",
      );
    }
    return parsed;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function piPrompt(prompt: string, schema: object, readOnly: boolean): string {
  const promptBody = readOnly
    ? "READ-ONLY REVIEW MODE.\n" +
      "Do not modify, create, or delete any files.\n" +
      "Do not run shell commands.\n\n" +
      prompt
    : prompt;
  return `${promptBody}\n\nProvider output schema:\n${JSON.stringify(schema, null, 2)}\n\nReturn only one JSON object matching the schema.`;
}

function piFailureMessage(stdout: string, stderr: string): string {
  if (stderr.trim().length > 0) {
    return `pi provider failed: ${safeProviderPreview(stderr)}`;
  }
  const preview = safeProviderPreview(stdout);
  return preview.length === 0
    ? "pi provider failed"
    : `pi provider failed (output preview: ${preview})`;
}

function piThinkingLevel(reasoningEffort: ReasoningEffort): string {
  return reasoningEffort === "none" ? "off" : reasoningEffort;
}

function piTimeoutMs(): number {
  const raw =
    process.env["CLAWPATCH_PI_TIMEOUT_MS"] ?? process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
  if (raw === undefined) {
    return PI_DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PI_DEFAULT_TIMEOUT_MS;
}

const mockProvider: Provider = {
  name: "mock",
  async check(): Promise<string> {
    return "mock";
  },
  async map(_root: string, prompt: string): Promise<AgentMapOutput> {
    const paths = [...prompt.matchAll(/"([^"]*agent\/[^"]+\.[^"]+)"/gu)]
      .map((match) => match[1]?.trim())
      .filter((path): path is string => path !== undefined && path.length > 0);
    const owned = [...new Set(paths.filter((path) => !/test|spec/u.test(path)))].slice(0, 6);
    const tests = paths.filter((path) => /test|spec/u.test(path)).slice(0, 3);
    return {
      features:
        owned.length === 0
          ? []
          : [
              {
                title: "Agent mapped package agent",
                summary: "Mock agent mapper grouped otherwise unmapped agent files.",
                kind: "library",
                confidence: "medium",
                entrypoints: [{ path: owned[0]!, symbol: null, route: null, command: null }],
                ownedFiles: owned.map((path) => ({ path, reason: "agent mapper owned file" })),
                contextFiles: tests.map((path) => ({ path, reason: "agent mapper nearby test" })),
                tests: tests.map((path) => ({ path, command: "touch SHOULD_NOT_RUN_AGENT_MAP" })),
                tags: ["agent-mapped"],
                trustBoundaries: [],
                reason: "Mock provider detected the agent/ source group.",
              },
            ],
      notes: ["mock agent map"],
    };
  },
  async review(_root: string, prompt: string): Promise<ReviewOutput> {
    if (!prompt.includes("TODO_BUG") && !prompt.includes("BUG:")) {
      return { findings: [], inspected: { files: [], symbols: [], notes: ["mock clean"] } };
    }
    const evidencePath = prompt.includes("BAD_EVIDENCE")
      ? "src/not-included.ts"
      : (firstPromptFileWith(prompt, "TODO_BUG") ?? "src/index.ts");
    if (prompt.includes("DESLOPIFY_LATE")) {
      return {
        findings: [
          {
            title: "General bug first",
            category: "bug",
            severity: "medium",
            confidence: "high",
            evidence: [
              {
                path: evidencePath,
                startLine: null,
                endLine: null,
                symbol: null,
                quote: "TODO_BUG",
              },
            ],
            reasoning: "Mock provider found an explicit bug marker.",
            reproduction: null,
            recommendation: "Replace marker with real handling.",
            whyTestsDoNotAlreadyCoverThis:
              "Mock fixtures do not encode this marker as intended behavior.",
            suggestedRegressionTest: "Add a focused test that fails when TODO_BUG is present.",
            minimumFixScope: "Replace the marker in the owning feature file.",
          },
          {
            title: "Late simplification finding",
            category: "maintainability",
            severity: "low",
            confidence: "high",
            evidence: [
              {
                path: evidencePath,
                startLine: null,
                endLine: null,
                symbol: null,
                quote: "DESLOPIFY_LATE",
              },
            ],
            reasoning: "Mock provider returned a simplification finding after a general finding.",
            reproduction: null,
            recommendation: "Keep the deslopify finding after mode filtering.",
            whyTestsDoNotAlreadyCoverThis:
              "Mock fixtures need to prove filtering occurs before the finding cap.",
            suggestedRegressionTest: null,
            minimumFixScope: "Filter before capping.",
          },
        ],
        inspected: { files: [evidencePath], symbols: [], notes: ["mock mixed findings"] },
      };
    }
    return {
      findings: [
        {
          title: "Marker bug found",
          category: "bug",
          severity: "medium",
          confidence: "high",
          evidence: [
            {
              path: evidencePath,
              startLine: null,
              endLine: null,
              symbol: null,
              quote: "TODO_BUG",
            },
          ],
          reasoning: "Mock provider found an explicit bug marker.",
          reproduction: null,
          recommendation: "Replace marker with real handling.",
          whyTestsDoNotAlreadyCoverThis:
            "Mock fixtures do not encode this marker as intended behavior.",
          suggestedRegressionTest: "Add a focused test that fails when TODO_BUG is present.",
          minimumFixScope: "Replace the marker in the owning feature file.",
        },
      ],
      inspected: { files: [evidencePath], symbols: [], notes: ["mock finding"] },
    };
  },
  async fix(): Promise<FixPlanOutput> {
    return {
      summary: "mock fix plan",
      findingIds: [],
      plannedFiles: [],
      risk: "low",
      steps: ["mock"],
      validationCommands: ["touch SHOULD_NOT_RUN_PROVIDER_COMMANDS"],
    };
  },
  async revalidate(_root: string, prompt: string): Promise<RevalidateOutput> {
    if (prompt.includes("REVALIDATE_FIXED")) {
      return { outcome: "fixed", reasoning: "mock fixed outcome", commands: ["mock fixed"] };
    }
    if (prompt.includes("REVALIDATE_OPEN")) {
      return { outcome: "open", reasoning: "mock open outcome", commands: ["mock open"] };
    }
    if (prompt.includes("REVALIDATE_FALSE_POSITIVE")) {
      return {
        outcome: "false-positive",
        reasoning: "mock false-positive outcome",
        commands: ["mock false-positive"],
      };
    }
    return { outcome: "uncertain", reasoning: "mock provider cannot inspect fixes", commands: [] };
  },
};

function firstPromptFileWith(prompt: string, marker: string): string | null {
  const blocks = prompt.split(/^--- /gmu).slice(1);
  for (const block of blocks) {
    const newline = block.indexOf("\n");
    if (newline === -1) {
      continue;
    }
    const path = block.slice(0, newline).trim();
    const contents = block.slice(newline + 1);
    if (path.length > 0 && contents.includes(marker)) {
      return path;
    }
  }
  return null;
}

const mockFailProvider: Provider = {
  name: "mock-fail",
  async check(): Promise<string> {
    return "mock-fail";
  },
  async map(): Promise<AgentMapOutput> {
    throw new ClawpatchError("mock map failure", 1, "mock-failure");
  },
  async review(): Promise<ReviewOutput> {
    throw new ClawpatchError("mock review failure", 1, "mock-failure");
  },
  async fix(): Promise<FixPlanOutput> {
    throw new ClawpatchError("mock fix failure", 1, "mock-failure");
  },
  async revalidate(): Promise<RevalidateOutput> {
    throw new ClawpatchError("mock revalidate failure", 1, "mock-failure");
  },
};

async function runCodexJson(
  root: string,
  prompt: string,
  options: ProviderOptions,
  schema: object,
  sandbox = "read-only",
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-codex-"));
  const schemaPath = join(dir, "schema.json");
  const outputPath = join(dir, "output.json");
  await writeFile(schemaPath, JSON.stringify(schema), "utf8");
  try {
    const args = [
      "exec",
      "--cd",
      root,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
    ];
    addCodexSandboxArgs(args, sandbox);
    addCodexModelArgs(args, options);
    args.push("-");
    const result = await runCommandArgs("codex", args, root, prompt);
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        codexFailureMessage(result.stdout, result.stderr),
        providerExitCode(result.stderr),
        "provider-failure",
      );
    }
    const raw = await readFile(outputPath, "utf8").catch(() => "");
    if (raw.trim().length === 0) {
      throw new ClawpatchError("codex provider produced no JSON output", 8, "malformed-output");
    }
    return parseCodexJson(raw);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function codexFailureMessage(stdout: string, stderr: string): string {
  const output = stderr || stdout;
  const scopeAdvice = /api\.responses\.write|insufficient permissions|missing scopes/iu.test(output)
    ? "\nCodex/OpenAI auth is missing Responses API write access (`api.responses.write`). Check the active credentials, organization/project role, and restricted key scopes."
    : "";
  return `codex provider failed: ${output}${scopeAdvice}`;
}

function addCodexSandboxArgs(args: string[], sandbox: string): void {
  const override = process.env["CLAWPATCH_CODEX_SANDBOX"]?.trim();
  if (override === "bypass" || override === "none") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
    return;
  }
  args.push("--sandbox", override && override.length > 0 ? override : sandbox);
}

function addCodexModelArgs(args: string[], options: ProviderOptions): void {
  if (options.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  if (options.model !== null) {
    args.push("--model", options.model);
  }
  if (options.reasoningEffort !== null) {
    args.push("-c", `model_reasoning_effort="${options.reasoningEffort}"`);
  }
}

const OPENCODE_READ_ONLY_PERMISSION = JSON.stringify({
  bash: "deny",
  edit: "deny",
  task: "deny",
  webfetch: "deny",
  websearch: "deny",
});

async function runOpencodeJson(
  root: string,
  prompt: string,
  model: string | null,
  schema: object,
  readOnly: boolean,
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-opencode-"));
  const promptPath = join(dir, "prompt.txt");
  await writeFile(promptPath, opencodePrompt(prompt, schema, readOnly), "utf8");

  try {
    const args = [
      "run",
      "Follow the attached clawpatch prompt. Return only the requested JSON object.",
      "--format",
      "json",
      "--dir",
      root,
      `--file=${promptPath}`,
    ];
    if (model !== null) {
      args.push("--model", model);
    }
    if (!readOnly) {
      args.push("--dangerously-skip-permissions");
    }
    const result = await runCommandArgs(
      "opencode",
      args,
      root,
      undefined,
      readOnly
        ? { trimOutput: false, env: { OPENCODE_PERMISSION: OPENCODE_READ_ONLY_PERMISSION } }
        : { trimOutput: false },
    );
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        opencodeFailureMessage(result.stdout, result.stderr),
        providerExitCode(result.stderr),
        "provider-failure",
      );
    }
    return extractOpencodeJson(result.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function opencodePrompt(prompt: string, schema: object, readOnly: boolean): string {
  const promptBody = readOnly
    ? "READ-ONLY REVIEW MODE.\n" +
      "Do not modify, create, or delete any files.\n" +
      "Do not run shell commands or launch subagents.\n\n" +
      prompt
    : prompt;
  return `${promptBody}

Provider output schema:
${JSON.stringify(schema, null, 2)}

Return only one JSON object matching the schema.`;
}

export function extractOpencodeJson(stdout: string): unknown {
  const textParts: string[] = [];
  const observedKinds = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let event: {
      type?: string;
      part?: { text?: unknown };
      error?: { data?: { message?: unknown }; name?: unknown; message?: unknown };
    };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      continue;
    }
    if (typeof event.type === "string") {
      observedKinds.add(event.type);
    }
    if (event.type === "text" && typeof event.part?.text === "string") {
      textParts.push(event.part.text);
    }
    if (event.type === "error") {
      const message =
        typeof event.error?.data?.message === "string"
          ? event.error.data.message
          : typeof event.error?.message === "string"
            ? event.error.message
            : typeof event.error?.name === "string"
              ? event.error.name
              : "unknown";
      throw new ClawpatchError(
        `opencode provider error: ${message}`,
        providerExitCode(message),
        "provider-failure",
      );
    }
  }
  const combined = textParts.join("").trim();
  if (combined.length === 0) {
    throw new ClawpatchError(
      `opencode provider produced no extractable text. Observed event kinds: ` +
        `[${[...observedKinds].join(", ")}].`,
      8,
      "malformed-output",
    );
  }
  const parsed = extractJson(combined);
  if (parsed === null) {
    throw new ClawpatchError(
      `opencode provider produced unparsable JSON ` +
        `(text chars=${combined.length}, observed event kinds: ` +
        `[${[...observedKinds].join(", ")}], output preview: ${safeProviderPreview(combined)})`,
      8,
      "malformed-output",
    );
  }
  return parsed;
}

function opencodeFailureMessage(stdout: string, stderr: string): string {
  if (stderr.trim().length > 0) {
    return `opencode provider failed: ${stderr}`;
  }
  const preview = stdout.slice(0, 800).replace(/\s+/gu, " ");
  return preview.length === 0
    ? "opencode provider failed"
    : `opencode provider failed (stdout preview: ${preview})`;
}

export function parseAcpxAgent(model: string | null): {
  agent: string;
  agentModel: string | null;
} {
  if (model === null) {
    return { agent: "codex", agentModel: null };
  }
  const idx = model.indexOf(":");
  if (idx === -1) {
    return { agent: model, agentModel: null };
  }
  return { agent: model.slice(0, idx), agentModel: model.slice(idx + 1) };
}

async function runAcpxJson(
  root: string,
  prompt: string,
  model: string | null,
  schema: object,
  permission: "read" | "approve",
): Promise<unknown> {
  const { agent, agentModel } = parseAcpxAgent(model);
  const permFlag = permission === "read" ? "--approve-reads" : "--approve-all";
  const args = ["--cwd", root, permFlag, "--format", "json", "--json-strict", "--suppress-reads"];
  if (agentModel !== null) {
    args.push("--model", agentModel);
  }
  args.push(agent, "exec", "--file", "-");
  const result = await runCommandArgs(
    "acpx",
    args,
    root,
    buildAcpxPrompt(prompt, schema, permission),
    { trimOutput: false, timeoutMs: acpxTimeoutMs() },
  );
  if (result.exitCode !== 0) {
    throw new ClawpatchError(
      acpxFailureMessage(result.stdout, result.stderr, result.exitCode),
      acpxExitCode(result.stdout, result.stderr, result.exitCode),
      "provider-failure",
    );
  }
  return extractAcpxJson(result.stdout);
}

function buildAcpxPrompt(prompt: string, schema: object, permission: "read" | "approve"): string {
  const promptBody =
    permission === "read"
      ? "READ-ONLY REVIEW MODE.\n" +
        "Do not modify, create, or delete any files.\n" +
        "Do not make any tool calls that write to the workspace.\n" +
        "Only read files and report findings in the JSON output below.\n\n" +
        prompt
      : prompt;

  return (
    `${promptBody}\n\n` +
    "Return ONLY a JSON object matching this schema. No prose preamble, no markdown fences, " +
    "no thinking-out-loud text before the JSON. " +
    `Schema:\n${JSON.stringify(schema)}\n`
  );
}

export function extractAcpxJson(stdout: string): unknown {
  const toolCandidates: string[] = [];
  const messageChunks: string[] = [];
  const thoughtChunks: string[] = [];
  const observedKinds = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let env: {
      method?: string;
      params?: {
        update?: {
          sessionUpdate?: string;
          content?: { type?: string; text?: string };
          output?: unknown;
        };
      };
    };
    try {
      env = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (env.method !== "session/update") {
      continue;
    }
    const update = env.params?.update;
    if (update?.sessionUpdate === undefined) {
      continue;
    }
    observedKinds.add(update.sessionUpdate);
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content?.type === "text" &&
      typeof update.content.text === "string"
    ) {
      messageChunks.push(update.content.text);
    } else if (
      update.sessionUpdate === "agent_thought_chunk" &&
      update.content?.type === "text" &&
      typeof update.content.text === "string"
    ) {
      thoughtChunks.push(update.content.text);
    } else if (update.sessionUpdate === "tool_call_result" && typeof update.output === "string") {
      toolCandidates.push(update.output);
    }
  }
  const candidates = [
    ...(messageChunks.length > 0 ? [messageChunks.join("")] : []),
    ...toolCandidates.toReversed(),
    ...(thoughtChunks.length > 0 ? [thoughtChunks.join("")] : []),
  ];
  if (candidates.length === 0) {
    throw new ClawpatchError(
      `acpx provider produced no extractable text. Observed envelope kinds: ` +
        `[${[...observedKinds].join(", ")}]. ` +
        `acpx envelope shape may have changed since clawpatch was tested ` +
        `against ${ACPX_TESTED_VERSIONS}. Check the installed acpx version.`,
      8,
      "malformed-output",
    );
  }

  let lastErr: unknown;
  for (const candidate of candidates) {
    const text = candidate.trim();
    try {
      const parsed = extractJson(text);
      if (parsed !== null) {
        return parsed;
      }
      throw new Error("no JSON object found");
    } catch (err) {
      lastErr = err;
    }
  }
  throw new ClawpatchError(
    `acpx provider produced unparseable JSON: ${(lastErr as Error).message}. ` +
      `Observed envelope kinds: [${[...observedKinds].join(", ")}]. ` +
      `acpx envelope shape may have changed since clawpatch was tested ` +
      `against ${ACPX_TESTED_VERSIONS}. Check the installed acpx version.`,
    8,
    "malformed-output",
  );
}

async function runGrokJson(
  root: string,
  prompt: string,
  model: string | null,
  schema: object,
  readOnly: boolean,
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-grok-"));
  await chmod(dir, 0o700);
  try {
    const promptPath = join(dir, "prompt.txt");
    const outputPath = join(dir, "result.json");
    await writeFile(outputPath, "", "utf8");
    await writeFile(promptPath, grokPrompt(prompt, schema, outputPath), "utf8");

    const args = [
      "--prompt-file",
      promptPath,
      "--output-format",
      "json",
      "--always-approve",
      "--verbatim",
      "--cwd",
      root,
    ];
    if (model !== null) {
      args.push("-m", model);
    }
    if (readOnly) {
      args.push("--disallowed-tools", GROK_READ_ONLY_DISALLOWED_TOOLS);
    }
    const result = await runCommandArgs("grok", args, root, undefined, { trimOutput: false });
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        `grok provider failed: ${result.stderr || result.stdout}`,
        providerExitCode(result.stderr),
        "provider-failure",
      );
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(result.stdout) as unknown;
    } catch {
      const preview = result.stdout.slice(0, 200).replace(/\s+/gu, " ");
      throw new ClawpatchError(
        `grok provider produced no JSON envelope (stdout preview: ${preview})`,
        8,
        "malformed-output",
      );
    }
    let parsed = await readGrokOutputFile(outputPath);
    if (parsed === null) {
      parsed = parseGrokEnvelope(envelope);
    }
    if (parsed === null) {
      throw new ClawpatchError("grok provider produced unparsable JSON", 8, "malformed-output");
    }
    return normalizeGrokOutput(parsed);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function grokPrompt(prompt: string, schema: object, outputPath: string): string {
  return `${prompt}

Provider output schema:
${JSON.stringify(schema, null, 2)}

Return only one JSON object matching the schema.

As your final action, overwrite this file with exactly the same JSON object and nothing else:
${outputPath}

Use:
cat > ${outputPath} << 'JSON_EOF'
{ ... the exact JSON object for this task ... }
JSON_EOF`;
}

export function grokEnvelopeText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  for (const key of ["text", "response", "output", "content"]) {
    const item = (value as Record<string, unknown>)[key];
    if (typeof item === "string") {
      return item;
    }
  }
  const choices = (value as Record<string, unknown>)["choices"];
  if (Array.isArray(choices)) {
    const first = choices[0] as unknown;
    if (typeof first === "object" && first !== null) {
      const message = (first as Record<string, unknown>)["message"];
      if (typeof message === "object" && message !== null) {
        const content = (message as Record<string, unknown>)["content"];
        if (typeof content === "string") {
          return content;
        }
      }
    }
  }
  return null;
}

async function readGrokOutputFile(outputPath: string): Promise<unknown | null> {
  const raw = (await readFile(outputPath, "utf8").catch(() => "")).trim();
  if (raw.length === 0) {
    return null;
  }
  try {
    return JSON.parse(jsonrepair(raw)) as unknown;
  } catch {
    return null;
  }
}

function parseGrokEnvelope(envelope: unknown): unknown | null {
  const text = grokEnvelopeText(envelope);
  if (text === null) {
    return isPlausibleGrokResult(envelope) ? envelope : null;
  }
  return tryParseGrokStdout(text);
}

export function isPlausibleGrokResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const output = value as Record<string, unknown>;
  if (Array.isArray(output["findings"])) {
    return typeof output["inspected"] === "object" && output["inspected"] !== null;
  }
  return typeof output["summary"] === "string" || typeof output["outcome"] === "string";
}

export function extractLastJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {}

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
  if (fenceMatch?.[1] !== undefined) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as unknown;
    } catch {}
  }

  const lastBrace = text.lastIndexOf("}");
  if (lastBrace === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = lastBrace; i >= 0; i -= 1) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "}") {
      depth += 1;
    } else if (char === "{") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(i, lastBrace + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function tryParseGrokStdout(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return JSON.parse(jsonrepair(trimmed)) as unknown;
  } catch {}

  let envelope: unknown = trimmed;
  try {
    envelope = JSON.parse(trimmed) as unknown;
  } catch {
    try {
      envelope = JSON.parse(jsonrepair(trimmed)) as unknown;
    } catch {}
  }
  const text = grokEnvelopeText(envelope);
  if (text !== null) {
    const candidates = [extractJson(text), extractLastJson(text)].filter(
      (candidate): candidate is unknown => candidate !== null,
    );
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (isPlausibleGrokResult(candidates[i])) {
        return candidates[i];
      }
    }
    const rootKeys = ["findings", "summary", "outcome"];
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const candidate = candidates[i];
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        rootKeys.some((key) => key in candidate)
      ) {
        return candidate;
      }
    }
    if (candidates.length > 0) {
      return candidates[candidates.length - 1]!;
    }
    try {
      return JSON.parse(jsonrepair(text)) as unknown;
    } catch {}
  }
  return isPlausibleGrokResult(envelope) ? envelope : null;
}

export function unwrapGrokEnvelope(raw: string): string {
  try {
    const outer = JSON.parse(raw) as unknown;
    const text = grokEnvelopeText(outer);
    return text ?? raw;
  } catch {
    return raw;
  }
}

export function normalizeGrokOutput(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const normalized = structuredClone(value) as Record<string, unknown>;
  const findings = normalized["findings"];
  if (Array.isArray(findings)) {
    for (const finding of findings) {
      if (typeof finding !== "object" || finding === null) {
        continue;
      }
      const record = finding as Record<string, unknown>;
      const category = record["category"];
      if (typeof category === "string") {
        const normalizedCategory = normalizeCategory(category);
        record["category"] = normalizedCategory;
        if (normalizedCategory !== category) {
          record["originalCategory"] = category;
        }
      }
      const severity = record["severity"];
      if (typeof severity === "string") {
        record["severity"] = normalizeSeverity(severity);
      }
      const confidence = record["confidence"];
      if (typeof confidence === "string") {
        record["confidence"] = normalizeConfidence(confidence);
      }
    }
  }
  const risk = normalized["risk"];
  if (typeof risk === "string") {
    normalized["risk"] = normalizeRisk(risk);
  }
  const outcome = normalized["outcome"];
  if (typeof outcome === "string") {
    normalized["outcome"] = normalizeOutcome(outcome);
  }
  return normalized;
}

const ALLOWED_CATEGORIES = new Set<string>(findingCategories as readonly string[]);

const CATEGORY_ALIASES: Record<string, string> = {
  "api contract": "api-contract",
  authorization: "security",
  auth: "security",
  bottleneck: "performance",
  "build failure": "build-release",
  ci: "build-release",
  "data corruption": "data-loss",
  "data loss": "data-loss",
  deadlock: "concurrency",
  docstring: "docs-gap",
  fork: "concurrency",
  "high latency": "performance",
  "inconsistent data": "data-loss",
  injection: "security",
  "interface mismatch": "api-contract",
  "lost update": "data-loss",
  multiprocessing: "concurrency",
  "no test": "test-gap",
  packaging: "build-release",
  "parallelism issue": "concurrency",
  permission: "security",
  "process pool": "concurrency",
  race: "concurrency",
  "race condition": "concurrency",
  "schema violation": "api-contract",
  "security issue": "security",
  slow: "performance",
  "spawn context": "concurrency",
  "state corruption": "data-loss",
  "test coverage": "test-gap",
  "thread safety": "concurrency",
  "type mismatch": "api-contract",
  untested: "test-gap",
  vulnerability: "security",
};

const CATEGORY_KEYWORD_RULES: Array<{ keywords: string[]; target: string }> = [
  {
    keywords: [
      "concurr",
      "parallel",
      "thread",
      "deadlock",
      "race cond",
      "spawn",
      "multiprocess",
      "fork",
      "process pool",
    ],
    target: "concurrency",
  },
  {
    keywords: ["perform", "slow", "inefficien", "bottleneck", "latenc", "cpu intens", "memory"],
    target: "performance",
  },
  {
    keywords: ["secur", "vulnerab", "inject", "auth", "permis", "exploit", "xss", "csrf"],
    target: "security",
  },
  {
    keywords: ["data loss", "corrupt", "inconsist", "lost data", "state corruption"],
    target: "data-loss",
  },
  { keywords: ["test", "coverage", "untested", "no test"], target: "test-gap" },
  { keywords: ["doc", "readme", "comment", "docstring"], target: "docs-gap" },
  { keywords: ["api", "contract", "interface", "schema", "type mismatch"], target: "api-contract" },
  { keywords: ["build", "ci", "release", "packag", "deploy", "lint"], target: "build-release" },
  {
    keywords: ["maintain", "readab", "complex", "debt", "duplicat", "style", "clarity"],
    target: "maintainability",
  },
  { keywords: ["bug", "incorrect", "wrong", "error", "fault", "logic", "off-by"], target: "bug" },
];

export function normalizeCategory(raw: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (ALLOWED_CATEGORIES.has(trimmed)) {
    return trimmed;
  }
  if (ALLOWED_CATEGORIES.has(lower)) {
    return lower;
  }
  const alias = CATEGORY_ALIASES[lower];
  if (alias !== undefined) {
    return alias;
  }
  for (const rule of CATEGORY_KEYWORD_RULES) {
    if (rule.keywords.some((keyword) => lower.includes(keyword))) {
      return rule.target;
    }
  }
  return "maintainability";
}

export function normalizeSeverity(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (["critical", "high", "medium", "low"].includes(lower)) {
    return lower;
  }
  if (["severe", "crit", "fatal"].includes(lower)) {
    return "critical";
  }
  if (["med", "moderate"].includes(lower)) {
    return "medium";
  }
  if (["minor", "trivial"].includes(lower)) {
    return "low";
  }
  return "medium";
}

export function normalizeConfidence(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (["high", "medium", "low"].includes(lower)) {
    return lower;
  }
  if (["certain", "sure", "strong"].includes(lower)) {
    return "high";
  }
  if (["med", "moderate"].includes(lower)) {
    return "medium";
  }
  if (["weak", "unsure", "guess"].includes(lower)) {
    return "low";
  }
  return "medium";
}

export function normalizeRisk(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (["low", "medium", "high"].includes(lower)) {
    return lower;
  }
  if (["safe", "trivial"].includes(lower)) {
    return "low";
  }
  if (["risky", "dangerous"].includes(lower)) {
    return "high";
  }
  return "medium";
}

export function normalizeOutcome(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (["fixed", "open", "false-positive", "uncertain"].includes(lower)) {
    return lower;
  }
  if (["resolved", "done"].includes(lower)) {
    return "fixed";
  }
  if (["false positive", "fp", "not a bug"].includes(lower)) {
    return "false-positive";
  }
  if (["unsure", "unknown"].includes(lower)) {
    return "uncertain";
  }
  return "open";
}

function providerExitCode(stderr: string): number {
  if (/auth|login|api key|GROK_CODE_XAI|xai-|unauthorized|wrong api key/iu.test(stderr)) {
    return 4;
  }
  if (/quota|rate.?limit/iu.test(stderr)) {
    return 5;
  }
  return 1;
}

function acpxFailureMessage(stdout: string, stderr: string, exitCode: number | null): string {
  const error = extractAcpxError(stdout);
  if (error !== null) {
    return `acpx provider failed: ${error}`;
  }
  const stderrPreview = safeProviderPreview(stderr);
  if (stderrPreview.length > 0) {
    return `acpx provider failed: ${stderrPreview}`;
  }
  return `acpx provider failed with exit code ${exitCode ?? "unknown"}`;
}

function extractAcpxError(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let env: unknown;
    try {
      env = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (typeof env !== "object" || env === null) {
      continue;
    }
    const error = (env as Record<string, unknown>)["error"];
    if (typeof error !== "object" || error === null) {
      continue;
    }
    const errorRecord = error as Record<string, unknown>;
    const data = errorRecord["data"];
    const dataRecord =
      typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    const parts = [
      stringPart("code", errorRecord["code"]),
      stringPart("acpxCode", dataRecord["acpxCode"]),
      stringPart("detail", dataRecord["detailCode"]),
      stringPart("origin", dataRecord["origin"]),
      stringPart("message", errorRecord["message"], 160),
    ].filter((part) => part.length > 0);
    if (parts.length > 0) {
      return parts.join("; ");
    }
  }
  return null;
}

function stringPart(label: string, value: unknown, maxLength = 80): string {
  if (typeof value !== "string" && typeof value !== "number") {
    return "";
  }
  const preview = safeProviderPreview(String(value), maxLength);
  return preview.length === 0 ? "" : `${label}=${preview}`;
}

function acpxExitCode(stdout: string, stderr: string, exitCode: number | null): number {
  const combined = `${stderr}\n${extractAcpxError(stdout) ?? ""}`;
  if (/auth|login|api key|not authenticated|AUTH_REQUIRED/iu.test(combined)) {
    return 4;
  }
  if (/quota|rate.?limit/iu.test(combined)) {
    return 5;
  }
  if (/acpx: command not found|spawn acpx ENOENT/iu.test(combined)) {
    return 4;
  }
  if (exitCode === 3 || exitCode === 124 || /TIMEOUT|timed out/iu.test(combined)) {
    return 1;
  }
  return 1;
}

function acpxTimeoutMs(): number {
  const raw =
    process.env["CLAWPATCH_ACPX_TIMEOUT_MS"] ?? process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
  if (raw === undefined) {
    return ACPX_DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ACPX_DEFAULT_TIMEOUT_MS;
}

// eslint-disable-next-line no-underscore-dangle
export const __testing = {
  acpxFailureMessage,
  addCodexModelArgs,
  addCodexSandboxArgs,
  codexFailureMessage,
  extractAcpxJson,
  extractOpencodeJson,
  parseAcpxAgent,
  parseCodexJson,
  piThinkingLevel,
  providerJsonSchema,
};
