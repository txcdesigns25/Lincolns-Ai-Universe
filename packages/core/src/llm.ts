import Anthropic from "@anthropic-ai/sdk";
import { RetryableError } from "./errors.js";

export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type ToolDef = Anthropic.Beta.Messages.BetaTool;
export type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface LlmResponse {
  content: ContentBlock[];
  stop_reason: string | null;
  usage: LlmUsage;
  model: string;
}

export interface LlmRequest {
  system: string;
  messages: MessageParam[];
  tools: ToolDef[];
  /** "important" uses the stronger model; everything else uses the cheap one. */
  tier?: Tier;
}

export type Tier = "routine" | "important";

export interface TierConfig { model: string; maxTokens: number; effort: "low" | "medium" | "high" }

export interface LlmClient {
  readonly provider: "anthropic" | "mock";
  /** The routine (default) model, shown on the dashboard. */
  readonly model: string;
  readonly maxTokens: number;
  tierConfig(tier: Tier): TierConfig;
  create(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Cheap by default. Routine work runs on Haiku with low effort. The stronger
 * model is used only for tasks the engine marks important (owner-boosted
 * agents, real inbound customers). Both are configurable on the worker:
 *   CLAUDE_MODEL / CLAUDE_MAX_TOKENS / CLAUDE_EFFORT                       (routine)
 *   CLAUDE_MODEL_IMPORTANT / CLAUDE_MAX_TOKENS_IMPORTANT / CLAUDE_EFFORT_IMPORTANT
 */
export function tiersFromEnv(env = process.env): Record<Tier, TierConfig> {
  const effort = (v: string | undefined, d: TierConfig["effort"]) => (["low", "medium", "high"].includes(v ?? "") ? v as TierConfig["effort"] : d);
  return {
    routine: {
      model: env.CLAUDE_MODEL?.trim() || "claude-haiku-5-5",
      maxTokens: Number(env.CLAUDE_MAX_TOKENS ?? 3000),
      effort: effort(env.CLAUDE_EFFORT, "low"),
    },
    important: {
      model: env.CLAUDE_MODEL_IMPORTANT?.trim() || "claude-sonnet-5-5",
      maxTokens: Number(env.CLAUDE_MAX_TOKENS_IMPORTANT ?? 6000),
      effort: effort(env.CLAUDE_EFFORT_IMPORTANT, "medium"),
    },
  };
}

/** USD per million tokens. Keep in sync with Anthropic's published pricing. */
export const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

function priceFor(model: string) {
  // Unknown model: price conservatively at the most expensive known rate.
  return PRICING[model] ?? { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
}

/** Actual cost of a completed call, in (fractional) cents. */
export function costCents(model: string, u: LlmUsage): number {
  const p = priceFor(model);
  const usd = (u.input_tokens * p.input + u.output_tokens * p.output
    + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1e6;
  return Math.round(usd * 100 * 1e6) / 1e6; // strip float noise
}

/**
 * Upper bound for a call before it is made, used to reserve budget.
 * Input is estimated generously (1 token per 3 chars) and output at max_tokens.
 */
export function estimateMaxCostCents(model: string, maxTokens: number, req: LlmRequest): number {
  const chars = req.system.length + JSON.stringify(req.messages).length + JSON.stringify(req.tools).length;
  const p = priceFor(model);
  const usd = (Math.ceil(chars / 3) * p.input + maxTokens * p.output) / 1e6;
  return Math.max(1, Math.ceil(usd * 100));
}

export class ClaudeClient implements LlmClient {
  readonly provider = "anthropic" as const;
  private client: Anthropic;
  readonly model: string;
  readonly maxTokens: number;
  constructor(private tiers: Record<Tier, TierConfig> = tiersFromEnv()) {
    this.model = tiers.routine.model;
    this.maxTokens = tiers.routine.maxTokens;
    // Reads ANTHROPIC_API_KEY from the server environment. Never sent to browsers.
    this.client = new Anthropic({ maxRetries: 2 });
  }

  tierConfig(tier: Tier): TierConfig { return this.tiers[tier] ?? this.tiers.routine; }

  async create(req: LlmRequest): Promise<LlmResponse> {
    const t = this.tierConfig(req.tier ?? "routine");
    // Haiku has no server-side fallback; only send it for models that do.
    const fallback = /opus|sonnet/.test(t.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {};
    try {
      const res = await this.client.beta.messages.create({
        model: t.model,
        max_tokens: t.maxTokens,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: req.messages,
        tools: req.tools,
        thinking: { type: "adaptive" },
        output_config: { effort: t.effort },
        ...fallback,
      });
      return { content: res.content, stop_reason: res.stop_reason, usage: res.usage, model: res.model ?? t.model };
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new RetryableError(`Claude rate limited: ${err.message}`, 60_000);
      if (err instanceof Anthropic.InternalServerError) throw new RetryableError(`Claude server error: ${err.message}`);
      if (err instanceof Anthropic.APIConnectionError) throw new RetryableError(`Claude connection error: ${err.message}`);
      throw err; // 4xx: a bug or bad request; do not retry blindly
    }
  }
}

/**
 * Deterministic stand-in used in development, tests, and whenever no API key
 * is configured. Costs nothing. A script decides the response for each call.
 */
export class MockLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly model = "mock";
  readonly maxTokens = 1000;
  calls: LlmRequest[] = [];
  tierConfig(_tier: Tier): TierConfig { return { model: "mock", maxTokens: 1000, effort: "low" }; }
  constructor(private script: (req: LlmRequest, callIndex: number) => Partial<LlmResponse> = defaultMockScript) {}
  async create(req: LlmRequest): Promise<LlmResponse> {
    const i = this.calls.length;
    this.calls.push(structuredClone(req));
    const r = this.script(req, i);
    return {
      content: r.content ?? [{ type: "text", text: "Done.", citations: null } as ContentBlock],
      stop_reason: r.stop_reason ?? "end_turn",
      usage: r.usage ?? { input_tokens: 0, output_tokens: 0 },
      model: "mock",
    };
  }
}

export function toolUse(name: string, input: unknown, id = `toolu_${Math.random().toString(36).slice(2, 10)}`): ContentBlock {
  return { type: "tool_use", id, name, input } as ContentBlock;
}
export function text(t: string): ContentBlock {
  return { type: "text", text: t, citations: null } as ContentBlock;
}

/**
 * Default sandbox behavior: on the first turn, record an observation and
 * create a draft; then finish. Lets the whole pipeline run with no API key.
 */
function defaultMockScript(req: LlmRequest, i: number): Partial<LlmResponse> {
  const has = (n: string) => req.tools.some((t) => t.name === n);
  if (req.messages.length === 1 && has("record_memory")) { // first turn of each task
    const calls: ContentBlock[] = [toolUse("record_memory", {
      kind: "observation", title: "Sandbox cycle ran",
      content: "Mock LLM executed a cycle. No real research was performed; configure ANTHROPIC_API_KEY for real reasoning.",
      tags: ["sandbox"],
    })];
    if (has("create_draft")) calls.push(toolUse("create_draft", {
      draft_type: "report", title: "Sandbox draft", body: "Placeholder produced by the mock LLM.",
    }));
    return { content: calls, stop_reason: "tool_use" };
  }
  return { content: [text("Sandbox cycle complete (mock LLM).")], stop_reason: "end_turn" };
}

export function createLlmFromEnv(): LlmClient {
  if (process.env.LLM_PROVIDER === "mock" || !process.env.ANTHROPIC_API_KEY) return new MockLlm();
  return new ClaudeClient();
}
