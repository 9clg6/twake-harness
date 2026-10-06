import { expect } from 'vitest';

import { readJsonColumn, withPrincipal } from '../../src/db/client.js';
import { startE2eeClient, type DecryptedMessage, type E2eeClient } from './e2ee-client.js';
import type { ChatRequest, ScriptedReply, ToolCall } from './fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './matrix-harness.js';
import type { MatrixUser } from './synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// One read contract per application, each named after the application it belongs to
export function readCatalog(domains: readonly string[]): Record<string, unknown> {
	const paths: Record<string, unknown> = {};
	for (const domain of domains) {
		paths[`/contracts/v1/${domain}/items`] = {
			get: {
				operationId: `search_${domain}`,
				summary: `Searches the user's ${domain}`,
				tags: [`${domain}.items.read.v1`],
				parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }]
			}
		};
	}
	return { openapi: '3.0.3', paths };
}

export function call(name: string, args: unknown): ToolCall[] {
	return [
		{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
	];
}

// A literal model: it calls the tool its owner's request needs, and once a call came back with
// data it tells what it found
export function modelUsing(tool: string, args: unknown): (request: ChatRequest) => ScriptedReply {
	return (request) => {
		const last = request.messages.at(-1);
		if (last?.role === 'tool' && (last.content ?? '').includes('"status":200')) {
			return { content: `Found: ${last.content ?? ''}` };
		}
		return { toolCalls: call(tool, args) };
	};
}

// A literal model for a conversation: it calls the tool given for each request it knows, tells
// what a call found, and repeats anything else it hears
export function modelFor(
	requests: Record<string, { readonly tool: string; readonly args: unknown }>
): (request: ChatRequest) => ScriptedReply {
	return (request) => {
		const last = request.messages.at(-1);
		const content = last?.content ?? '';
		if (last?.role === 'tool' && content.includes('"status":200')) {
			return { content: `Found: ${content}` };
		}
		const known = last?.role === 'user' ? requests[content] : undefined;
		if (known !== undefined) return { toolCalls: call(known.tool, known.args) };
		return { content: `Heard: ${content}` };
	};
}

// The owner Alice in the encrypted room of her assistant Jarvis, what the harness asks her there
// and what her assistant answers
export interface ConsentRoom {
	readonly h: MatrixTestHarness;
	readonly alice: MatrixUser;
	readonly client: E2eeClient;
	readonly room: string;
	readonly assistantId: string;
	// The harness's questions, as Alice's client received them
	questions(): DecryptedMessage[];
	// Resolves to the event id of the question after the first `seen` ones
	nextQuestion(seen: number): Promise<string>;
	// The assistant's messages that start with a prefix, such as the model's answers
	saying(prefix: string): DecryptedMessage[];
	nextSaying(prefix: string, seen: number): Promise<string>;
	// What the harness keeps of Alice's calls to an application, oldest first
	callsTo(domain: string): Promise<{ status: string; arguments: unknown }[]>;
	close(): Promise<void>;
}

export async function startConsentRoom(env: Record<string, string> = {}): Promise<ConsentRoom> {
	const h = await startMatrixHarness({ env });
	const alice = await h.synapse.registerUser('alice');
	const client = await startE2eeClient(h.synapse.url, alice);
	const created = await h.api.post<{ roomId: string }>('alice@test.local', '/v1/assistants', {
		name: 'Jarvis'
	});
	expect(created.status).toBe(201);
	const room = created.body.roomId;
	for (let i = 0; i < 40; i += 1) {
		const invites = await h.synapse.pendingInvites(alice);
		if (invites.some((inv) => inv.roomId === room)) break;
		await sleep(250);
	}
	await client.joinRoom(room);
	const assistantId = '@twake-space-assistant-alice:test.local';
	await client.waitForMessage(room, assistantId, (t) => t.includes('Jarvis'));
	const saying = (prefix: string): DecryptedMessage[] =>
		client.messages.filter(
			(m) => m.roomId === room && m.sender === assistantId && m.body.startsWith(prefix)
		);
	const nextSaying = async (prefix: string, seen: number): Promise<string> => {
		for (let i = 0; i < 120; i += 1) {
			const latest = saying(prefix).at(seen);
			if (latest !== undefined) return latest.body;
			await sleep(250);
		}
		throw new Error(`the assistant said nothing new starting with ${prefix}`);
	};
	const questions = (): DecryptedMessage[] => saying('This is the first time');
	const nextQuestion = async (seen: number): Promise<string> => {
		for (let i = 0; i < 120; i += 1) {
			const latest = questions().at(seen);
			if (latest !== undefined) return latest.eventId;
			await sleep(250);
		}
		throw new Error('no new question from the harness');
	};
	return {
		h,
		alice,
		client,
		room,
		assistantId,
		questions,
		nextQuestion,
		saying,
		nextSaying,
		callsTo: async (domain) => {
			const rows = await withPrincipal(
				h.db,
				{ id: 'alice@test.local' },
				(tx) =>
					tx.sql<{ status: string; arguments: unknown }[]>`
					select status, arguments from pending_calls where domain = ${domain}
					order by created_at`
			);
			return rows.map((row) => ({ status: row.status, arguments: readJsonColumn(row.arguments) }));
		},
		close: async () => {
			await client.stop();
			await h.close();
		}
	};
}
