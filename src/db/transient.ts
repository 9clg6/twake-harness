// The socket errors of Node and the connection errors of postgres.js: the database is out of reach
const CONNECTION_ERRORS: ReadonlySet<string> = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'ETIMEDOUT',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'ENOTFOUND',
	'EAI_AGAIN',
	'EPIPE',
	'CONNECT_TIMEOUT',
	'CONNECTION_CLOSED',
	'CONNECTION_ENDED',
	'CONNECTION_DESTROYED'
]);

// What PostgreSQL answers when it is not itself: a connection exception, insufficient resources,
// a server shutting down, crashed or starting up, a read-only server after a failover, a
// serialization failure or a deadlock, a lock or a statement that timed out
const TRANSIENT_SQLSTATE = /^(08|53|57P0[123]$|25006$|40001$|40P01$|55P03$|57014$)/;

// Whether a failure may pass when the same work is tried again later, unchanged, as with a
// database that is down or a connection that was lost
export function isTransient(err: unknown): boolean {
	for (let cause: unknown = err; cause instanceof Error; cause = cause.cause) {
		const code: unknown = Reflect.get(cause, 'code');
		if (typeof code !== 'string') continue;
		if (CONNECTION_ERRORS.has(code)) return true;
		if (cause.name === 'PostgresError') return TRANSIENT_SQLSTATE.test(code);
	}
	return false;
}
