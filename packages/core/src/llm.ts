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
}

export interface LlmClient {
  readonly provider: "anthropic" | "mock";
  readonly model: string;
  readonly maxTokens: number;
  create(req: LlmRequest): Promise<LlmResponse>;
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
  constructor(
    readonly model = process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
    readonly maxTokens = Number(process.env.CLAUDE_MAX_TOKENS ?? 8000),
    private effort: "low" | "medium" | "high" = (process.env.CLAUDE_EFFORT as any) ?? "medium",
  ) {
    // Reads ANTHROPIC_API_KEY from the server environment. Never sent to browsers.
    this.client = new Anthropic({ maxRetries: 2 });
  }

  async create(req: LlmRequest): Promise<LlmResponse> {
    try {
      const res = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: req.messages,
        tools: req.tools,
        thinking: { type: "adaptive" },
        output_config: { effort: this.effort },
        // Server-side fallback if the primary model declines a request.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      return { content: res.content, stop_reason: res.stop_reason, usage: res.usage, model: res.model ?? this.model };
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
