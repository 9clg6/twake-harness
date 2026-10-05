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
		logLevel: values.LOG_LEVEL
	};
}
