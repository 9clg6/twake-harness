import { z } from 'zod';

const ROLES = ['api', 'matrix', 'worker'] as const;
export type Role = (typeof ROLES)[number];

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
	readonly role: Role;
	readonly host: string;
	readonly port: number;
	readonly databaseUrl: string;
	readonly auth: {
		readonly jwksUrl: URL;
		readonly issuer: string;
		readonly audience: string;
	};
	readonly apisix: {
		readonly baseUrl: URL;
		readonly consumerKey: string;
	};
	readonly llm: {
		readonly model: string;
		readonly maxTokens: number;
		readonly timeoutMs: number;
	};
	readonly turn: {
		readonly maxToolCalls: number;
		readonly memoryNudgeInterval: number;
	};
	readonly curation: {
		readonly intervalMs: number;
	};
	readonly admission: {
		// Turns running at once in this replica, and the queue behind them
		readonly maxInflight: number;
		// Per user: one running turn, then this many waiting; beyond, the user is told to come back
		readonly userQueue: number;
		readonly userPerMinute: number;
		readonly userDailyTokens: number;
		// The AI Gateway's own rate, respected before it refuses us
		readonly globalPerMinute: number;
	};
	readonly contracts: {
		// Paths under the APISIX address: the curated OpenAPI, the contracts, the audit route
		readonly openapiPath: string;
		readonly basePath: string;
		readonly auditPath: string;
		readonly refreshMs: number;
		readonly timeoutMs: number;
	};
	readonly matrix: {
		readonly serverName: string;
		readonly appserviceId: string;
		readonly senderLocalpart: string;
		readonly assistantPrefix: string;
		// The token APISIX injects on the matrix route; set it only when the harness sends it itself
		readonly asToken: string;
		readonly hsToken: string;
	};
	readonly logLevel: LogLevel;
}

const envSchema = z.object({
	HARNESS_ROLE: z.enum(ROLES).default('api'),
	HOST: z.string().default('0.0.0.0'),
	PORT: z.coerce.number().int().min(1).max(65535).default(8080),
	DATABASE_URL: z.string().min(1),
	AUTH_JWKS_URL: z.url(),
	AUTH_ISSUER: z.string().min(1),
	AUTH_AUDIENCE: z.string().min(1),
	APISIX_BASE_URL: z.url(),
	APISIX_CONSUMER_KEY: z.string().min(1),
	LLM_MODEL: z.string().min(1).default('qwen3.8'),
	LLM_MAX_TOKENS: z.coerce.number().int().min(1).default(1024),
	LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
	TURN_MAX_TOOL_CALLS: z.coerce.number().int().min(0).default(6),
	MEMORY_NUDGE_INTERVAL: z.coerce.number().int().min(0).default(10),
	CURATION_INTERVAL_MS: z.coerce.number().int().min(0).default(86_400_000),
	ADMISSION_MAX_INFLIGHT: z.coerce.number().int().min(1).default(32),
	ADMISSION_USER_QUEUE: z.coerce.number().int().min(0).default(2),
	ADMISSION_USER_PER_MINUTE: z.coerce.number().int().min(1).default(10),
	ADMISSION_USER_DAILY_TOKENS: z.coerce.number().int().min(1).default(200_000),
	ADMISSION_GLOBAL_PER_MINUTE: z.coerce.number().int().min(1).default(400),
	CONTRACTS_OPENAPI_PATH: z.string().min(1).default('contracts/openapi.json'),
	CONTRACTS_BASE_PATH: z.string().min(1).default('contracts'),
	AUDIT_PATH: z.string().min(1).default('audit'),
	CONTRACTS_REFRESH_MS: z.coerce.number().int().min(0).default(300_000),
	CONTRACTS_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
	MATRIX_SERVER_NAME: z.string().default(''),
	MATRIX_APPSERVICE_ID: z.string().min(1).default('twake-harness'),
	MATRIX_SENDER_LOCALPART: z.string().min(1).default('twake-space-assistant'),
	MATRIX_ASSISTANT_PREFIX: z.string().min(1).default('twake-space-assistant-'),
	MATRIX_AS_TOKEN: z.string().default('injected-by-apisix'),
	MATRIX_HS_TOKEN: z.string().default(''),
	LOG_LEVEL: z.enum(LOG_LEVELS).default('info')
});

export type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): Config {
	const parsed = envSchema.safeParse(env);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
		throw new Error(`invalid configuration: ${issues.join('; ')}`);
	}
	const values = parsed.data;
	if (
		values.HARNESS_ROLE === 'matrix' &&
		(values.MATRIX_SERVER_NAME === '' || values.MATRIX_HS_TOKEN === '')
	) {
		throw new Error(
			'invalid configuration: the matrix role needs MATRIX_SERVER_NAME and MATRIX_HS_TOKEN'
		);
	}
	return {
		role: values.HARNESS_ROLE,
		host: values.HOST,
		port: values.PORT,
		databaseUrl: values.DATABASE_URL,
		auth: {
			jwksUrl: new URL(values.AUTH_JWKS_URL),
			issuer: values.AUTH_ISSUER,
			audience: values.AUTH_AUDIENCE
		},
		apisix: {
			baseUrl: new URL(values.APISIX_BASE_URL),
			consumerKey: values.APISIX_CONSUMER_KEY
		},
		llm: {
			model: values.LLM_MODEL,
			maxTokens: values.LLM_MAX_TOKENS,
			timeoutMs: values.LLM_TIMEOUT_MS
		},
		turn: {
			maxToolCalls: values.TURN_MAX_TOOL_CALLS,
			memoryNudgeInterval: values.MEMORY_NUDGE_INTERVAL
		},
		curation: {
			intervalMs: values.CURATION_INTERVAL_MS
		},
		admission: {
			maxInflight: values.ADMISSION_MAX_INFLIGHT,
			userQueue: values.ADMISSION_USER_QUEUE,
			userPerMinute: values.ADMISSION_USER_PER_MINUTE,
			userDailyTokens: values.ADMISSION_USER_DAILY_TOKENS,
			globalPerMinute: values.ADMISSION_GLOBAL_PER_MINUTE
		},
		contracts: {
			openapiPath: values.CONTRACTS_OPENAPI_PATH,
			basePath: values.CONTRACTS_BASE_PATH,
			auditPath: values.AUDIT_PATH,
			refreshMs: values.CONTRACTS_REFRESH_MS,
			timeoutMs: values.CONTRACTS_TIMEOUT_MS
		},
		matrix: {
			serverName: values.MATRIX_SERVER_NAME,
			appserviceId: values.MATRIX_APPSERVICE_ID,
			senderLocalpart: values.MATRIX_SENDER_LOCALPART,
			assistantPrefix: values.MATRIX_ASSISTANT_PREFIX,
			asToken: values.MATRIX_AS_TOKEN,
			hsToken: values.MATRIX_HS_TOKEN
		},
		logLevel: values.LOG_LEVEL
	};
}
