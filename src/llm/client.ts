import { z } from 'zod';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
	readonly id: string;
	readonly type: 'function';
	readonly function: { readonly name: string; readonly arguments: string };
}

export interface LlmMessage {
	readonly role: LlmRole;
	readonly content: string | null;
	readonly tool_calls?: readonly LlmToolCall[];
	readonly tool_call_id?: string;
	readonly name?: string;
}

export interface LlmToolDefinition {
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters: Record<string, unknown>;
	};
}

export interface LlmUsage {
	readonly promptTokens: number;
	readonly completionTokens: number;
}

export interface LlmCompletion {
	readonly content: string | null;
	readonly reasoning: string | null;
	readonly toolCalls: readonly LlmToolCall[];
	readonly finishReason: string | null;
	readonly usage: LlmUsage | null;
	// How long the call took, from the request to its answer read
	readonly durationMs: number;
}

// What one call may change from the client's defaults
export interface LlmCallOptions {
	readonly maxTokens?: number;
	// Another model of the gateway than the client's own, such as a faster one for a short check
	readonly model?: string;
}

export interface LlmClient {
	readonly model: string;
	// The token budget of a call that does not set its own
	readonly maxTokens: number;
	complete(
		messages: readonly LlmMessage[],
		tools: readonly LlmToolDefinition[],
		options?: LlmCallOptions
	): Promise<LlmCompletion>;
}

export interface LlmClientOptions {
	readonly baseUrl: URL;
	readonly consumerKey: string;
	readonly model: string;
	readonly maxTokens: number;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof fetch;
	// Where every call that failed is logged, with its kind and how long it took: one line for
	// every caller, so that the calls that timed out are counted against those that answered
	readonly log?: { warn(fields: Record<string, unknown>, msg: string): void };
}

// What went wrong with a call: it ran past timeoutMs, the gateway answered an HTTP error, the
// request never reached it, or its answer could not be read as a completion
export type LlmFailureKind = 'timeout' | 'http' | 'network' | 'answer';

export interface LlmFailure {
	readonly kind: LlmFailureKind;
	readonly durationMs: number;
	readonly status?: number;
	readonly cause?: unknown;
}

export class LlmError extends Error {
	override readonly name = 'LlmError';
	readonly kind: LlmFailureKind;
	readonly durationMs: number;
	readonly status: number | undefined;

	constructor(message: string, failure: LlmFailure) {
		super(message, failure.cause === undefined ? {} : { cause: failure.cause });
		this.kind = failure.kind;
		this.durationMs = failure.durationMs;
		this.status = failure.status;
	}
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// A fetch that failed: as the signal of the call fired, or otherwise, as told by where it failed
function kindOf(err: unknown, otherwise: LlmFailureKind): LlmFailureKind {
	return err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : otherwise;
}

const toolCallSchema = z.object({
	id: z.string(),
	type: z.literal('function'),
	function: z.object({ name: z.string(), arguments: z.string() })
});

const choiceSchema = z.object({
	message: z.object({
		content: z.string().nullable().optional(),
		reasoning_content: z.string().nullable().optional(),
		tool_calls: z.array(toolCallSchema).optional()
	}),
	finish_reason: z.string().nullable().optional()
});

// At least one choice: the first is the answer
const completionSchema = z.object({
	choices: z.tuple([choiceSchema]).rest(choiceSchema),
	usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).partial().optional()
});

const THINK_BLOCK = /<think>([\s\S]*?)<\/think>\s*/g;

// Reasoning models return their deliberation either as a separate field or inline in think
// tags. Both are kept for the logs and neither reaches the caller.
export function splitReasoning(
	content: string | null,
	reasoningField: string | null
): { content: string | null; reasoning: string | null } {
	const parts: string[] = [];
	if (reasoningField !== null && reasoningField.length > 0) parts.push(reasoningField);
	let visible = content;
	if (visible !== null) {
		for (const match of visible.matchAll(THINK_BLOCK)) {
			const inner = match[1];
			if (inner !== undefined && inner.trim().length > 0) parts.push(inner.trim());
		}
		visible = visible.replace(THINK_BLOCK, '').trim();
	}
	return { content: visible, reasoning: parts.length === 0 ? null : parts.join('\n\n') };
}

export function makeLlmClient(options: LlmClientOptions): LlmClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const endpoint = new URL('llm/v1/chat/completions', ensureTrailingSlash(options.baseUrl));
	return {
		model: options.model,
		maxTokens: options.maxTokens,
		async complete(messages, tools, callOptions) {
			const body = requestOf(options, messages, tools, callOptions);
			const started = performance.now();
			const failed = failureOf(options.log, body.model, started);
			let response: Response;
			try {
				response = await fetchImpl(endpoint, {
					method: 'POST',
					headers: { 'content-type': 'application/json', apikey: options.consumerKey },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(options.timeoutMs)
				});
			} catch (err: unknown) {
				throw failed('model call failed', {
					kind: kindOf(err, 'network'),
					cause: err,
					message: messageOf(err)
				});
			}
			if (!response.ok) {
				throw failed(`model answered HTTP ${response.status}`, {
					kind: 'http',
					status: response.status
				});
			}
			// The call keeps its time limit until its answer is read, and a proxy in front of the model
			// may answer a page that is not JSON: a model that failed in either way is no bug
			let answer: unknown;
			try {
				answer = await response.json();
			} catch (err: unknown) {
				// A page that is not JSON is an answer that is none; a body cut short never came
				throw failed('model answer could not be read', {
					kind: err instanceof SyntaxError ? 'answer' : kindOf(err, 'network'),
					cause: err,
					message: messageOf(err)
				});
			}
			const read = readCompletion(answer, Math.round(performance.now() - started));
			if (typeof read === 'string') throw failed(read, { kind: 'answer' });
			return read;
		}
	};
}

// What the gateway is asked: the call's own model and budget over the client's, the tools only
// when there are some
function requestOf(
	options: LlmClientOptions,
	messages: readonly LlmMessage[],
	tools: readonly LlmToolDefinition[],
	callOptions: LlmCallOptions | undefined
): {
	model: string;
	messages: readonly LlmMessage[];
	max_tokens: number;
	tools?: readonly LlmToolDefinition[];
} {
	return {
		model: callOptions?.model ?? options.model,
		messages,
		max_tokens: callOptions?.maxTokens ?? options.maxTokens,
		...(tools.length > 0 ? { tools } : {})
	};
}

// A call that gave no answer, whatever went wrong between the harness and the model's reply: what
// the callers that go on without a model that failed catch, so that they fail on a bug alone.
// Logged once for every caller, with how long the call took.
function failureOf(
	log: LlmClientOptions['log'],
	model: unknown,
	started: number
): (what: string, failure: Omit<LlmFailure, 'durationMs'> & { message?: string }) => LlmError {
	return (what, failure) => {
		const durationMs = Math.round(performance.now() - started);
		log?.warn(
			{ model, kind: failure.kind, status: failure.status, durationMs },
			'model call failed'
		);
		const detail = failure.message === undefined ? '' : `: ${failure.message}`;
		return new LlmError(`${what}${detail}`, { ...failure, durationMs });
	};
}

// What the gateway answered, read as a completion, or why it is none
function readCompletion(answer: unknown, durationMs: number): LlmCompletion | string {
	const parsed = completionSchema.safeParse(answer);
	if (!parsed.success) return 'model answer has an unexpected shape';
	const [choice] = parsed.data.choices;
	const { content, reasoning } = splitReasoning(
		choice.message.content ?? null,
		choice.message.reasoning_content ?? null
	);
	const usage = parsed.data.usage;
	return {
		content,
		reasoning,
		toolCalls: choice.message.tool_calls ?? [],
		finishReason: choice.finish_reason ?? null,
		usage:
			usage?.prompt_tokens === undefined || usage.completion_tokens === undefined
				? null
				: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens },
		durationMs
	};
}

function ensureTrailingSlash(url: URL): URL {
	return url.pathname.endsWith('/') ? url : new URL(`${url.href}/`);
}
