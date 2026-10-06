import type { OlmMachine, RequestType } from '@matrix-org/matrix-sdk-crypto-nodejs';
import type { Intent } from 'matrix-bot-sdk';

export interface CryptoRequest {
	readonly id: string;
	readonly body: string;
	readonly type: RequestType;
}

// A step of a crypto operation, named in the error it may raise: the bindings' own errors say
// nothing of where
export async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`${name}: ${message}`, { cause: err });
	}
}

// The OlmMachine behind an intent's crypto client, which the SDK keeps to itself
export function machineOf(intent: Intent): OlmMachine {
	const crypto = intent.underlyingClient.crypto as unknown as {
		engine?: { machine?: OlmMachine };
	};
	const machine = crypto.engine?.machine;
	if (machine === undefined) throw new Error('the assistant has no encryption state yet');
	return machine;
}

// The HTTP body of a request the machine prepared: the signatures upload comes wrapped in the
// field the Rust SDK names it by, which the homeserver would take for a user
function bodyOf(request: CryptoRequest): unknown {
	const parsed = JSON.parse(request.body) as Record<string, unknown>;
	return 'signed_keys' in parsed ? parsed['signed_keys'] : parsed;
}

// Sends a request the crypto machine prepared, as the assistant, and tells the machine
export async function sendRequest(
	intent: Intent,
	machine: OlmMachine,
	method: 'POST' | 'PUT',
	path: string,
	request: CryptoRequest,
	query: Record<string, string> | null = null
): Promise<unknown> {
	const response: unknown = await step(`${method} ${path}`, () =>
		intent.underlyingClient.doRequest(method, path, query, bodyOf(request))
	);
	const reply = JSON.stringify(response ?? {});
	await step(`marking ${path} as sent (reply ${reply.slice(0, 400)})`, () =>
		machine.markRequestAsSent(request.id, request.type, reply)
	);
	return response;
}
