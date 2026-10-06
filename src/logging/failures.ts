// What a log line may say of a failure. The matrix role sends the APISIX consumer key with every
// request of matrix-bot-sdk, and the SDK rejects a refused request that names no Matrix error code
// with the whole response of the request library, whose toJSON() hands over the headers of the
// request: pino would write the key and the access token into the logs. So an error keeps its
// type, message, stack and plain fields, a response or any other instance only its type and
// status, and no header, body, request, option or credential survives, at any depth.

export type LogSerializer = (value: unknown) => unknown;

type LogFields = Record<string, unknown>;

interface ErrorLike {
	readonly message: string;
	readonly stack?: string | undefined;
}

type ErrorObject = ErrorLike & object;

// Where requests and responses keep their headers, bodies, sockets and settings
const TRANSPORT_KEYS: ReadonlySet<string> = new Set([
	'request',
	'response',
	'req',
	'res',
	'options',
	'config',
	'headers',
	'rawHeaders',
	'body',
	'socket',
	'connection',
	'agent',
	'_header',
	'_httpMessage'
]);

// The names a credential or a key travels under, whose value is never written
const CREDENTIAL_KEY = /authorization|cookie|token|secret|passw|passphrase|credential|key$/i;

// Fields an error is written with before its own
const ERROR_KEYS: ReadonlySet<string> = new Set(['type', 'message', 'stack', 'cause', 'errors']);

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;
const MAX_CAUSES = 10;

// The keys a log line carries a failure under: err, as pino names it, the reason of a refusal or
// of a rejection, what the SDK reports through its logger, and error and cause, which a call is
// as likely to use
const FAILURE_KEYS = ['err', 'error', 'cause', 'reason', 'rejection', 'rest'] as const;

// A log call must never throw because of what it logs, as a getter that throws would make it
function normalizeFailure(value: unknown): unknown {
	try {
		return normalizeValue(value, 0, new WeakSet<object>());
	} catch {
		return '[unserializable]';
	}
}

export const FAILURE_SERIALIZERS: Readonly<Record<string, LogSerializer>> = Object.fromEntries(
	FAILURE_KEYS.map((key): [string, LogSerializer] => [key, normalizeFailure])
);

function normalizeValue(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'function' || typeof value === 'symbol') return null;
	if (value === null || typeof value !== 'object') return value;
	if (ancestors.has(value)) return '[Circular]';
	if (depth >= MAX_DEPTH) return '[Truncated]';
	ancestors.add(value);
	try {
		return normalizeObject(value, depth, ancestors);
	} finally {
		ancestors.delete(value);
	}
}

function normalizeObject(value: object, depth: number, ancestors: WeakSet<object>): unknown {
	if (Array.isArray(value)) {
		return value.map((item: unknown) => normalizeValue(item, depth + 1, ancestors));
	}
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
	}
	if (isErrorLike(value)) return normalizeError(value, depth, ancestors);
	if (isPlainObject(value)) return normalizeEntries(Object.entries(value), depth, ancestors);
	return normalizeInstance(value);
}

function isErrorLike(value: object): value is ErrorObject {
	if (value instanceof Error) return true;
	return (
		typeof Reflect.get(value, 'message') === 'string' &&
		typeof Reflect.get(value, 'stack') === 'string'
	);
}

function isPlainObject(value: object): boolean {
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function typeNameOf(value: object): string {
	const constructor: unknown = Reflect.get(value, 'constructor');
	if (typeof constructor === 'function' && constructor.name !== '') return constructor.name;
	const name: unknown = Reflect.get(value, 'name');
	return typeof name === 'string' ? name : 'Object';
}

// The fields worth writing: no part of a request, no credential, nothing JSON would leave out
function normalizeEntries(
	entries: readonly [string, unknown][],
	depth: number,
	ancestors: WeakSet<object>
): LogFields {
	const fields: LogFields = {};
	for (const [key, value] of entries) {
		if (TRANSPORT_KEYS.has(key)) continue;
		if (value === undefined || typeof value === 'function' || typeof value === 'symbol') continue;
		fields[key] = CREDENTIAL_KEY.test(key) ? REDACTED : normalizeValue(value, depth + 1, ancestors);
	}
	return fields;
}

// The errors an error was caused by, outermost first, and the first cause that is not an error
function causesOf(err: ErrorObject): { chain: ErrorObject[]; otherCause: unknown } {
	const chain: ErrorObject[] = [];
	const seen = new Set<object>([err]);
	let cause: unknown = Reflect.get(err, 'cause');
	while (
		typeof cause === 'object' &&
		cause !== null &&
		isErrorLike(cause) &&
		!seen.has(cause) &&
		chain.length < MAX_CAUSES
	) {
		chain.push(cause);
		seen.add(cause);
		cause = Reflect.get(cause, 'cause');
	}
	// A cycle, or a chain too long to follow, ends on an error already written or left out
	const ended = typeof cause === 'object' && cause !== null && isErrorLike(cause);
	return { chain, otherCause: ended ? undefined : cause };
}

function statusOf(value: unknown): number | null {
	if (typeof value !== 'object' || value === null) return null;
	const status: unknown = Reflect.get(value, 'statusCode') ?? Reflect.get(value, 'status');
	return typeof status === 'number' ? status : null;
}

// Type, message and stack as pino writes them, causes appended, then the error's own fields
function normalizeError(err: ErrorObject, depth: number, ancestors: WeakSet<object>): LogFields {
	const { chain, otherCause } = causesOf(err);
	const withCauses = [err, ...chain];
	const own = Object.keys(err)
		.filter((key) => !ERROR_KEYS.has(key))
		.map((key): [string, unknown] => [key, Reflect.get(err, key)]);
	const fields: LogFields = {
		type: typeNameOf(err),
		message: withCauses.map((each) => each.message).join(': '),
		stack: withCauses.map((each) => each.stack ?? each.message).join('\ncaused by: '),
		...normalizeEntries(own, depth, ancestors)
	};
	// The status of a response the error carries is worth keeping, the response itself is not
	if (typeof fields['statusCode'] !== 'number') {
		const status = statusOf(Reflect.get(err, 'response')) ?? statusOf(Reflect.get(err, 'res'));
		if (status !== null) fields['statusCode'] = status;
	}
	const errors: unknown = Reflect.get(err, 'errors');
	if (Array.isArray(errors)) {
		fields['aggregateErrors'] = errors.map((each: unknown) =>
			normalizeValue(each, depth + 1, ancestors)
		);
	}
	if (otherCause !== undefined && otherCause !== null) {
		fields['cause'] = normalizeValue(otherCause, depth + 1, ancestors);
	}
	return fields;
}

// A response, a request or any other instance: its type and, for a response, its status and the
// Matrix error its body names
function normalizeInstance(value: object): LogFields {
	const fields: LogFields = { type: typeNameOf(value) };
	for (const key of ['statusCode', 'status']) {
		const status: unknown = Reflect.get(value, key);
		if (typeof status === 'number') fields[key] = status;
	}
	for (const key of ['statusMessage', 'statusText']) {
		const text: unknown = Reflect.get(value, key);
		if (typeof text === 'string') fields[key] = text;
	}
	const body: unknown = Reflect.get(value, 'body');
	if (typeof body === 'object' && body !== null && isPlainObject(body)) {
		const errcode: unknown = Reflect.get(body, 'errcode');
		const error: unknown = Reflect.get(body, 'error');
		if (typeof errcode === 'string') fields['errcode'] = errcode;
		if (typeof error === 'string') fields['error'] = error;
	}
	return fields;
}
