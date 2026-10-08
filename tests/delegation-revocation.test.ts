import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { until } from './helpers/activity.js';
import {
	modelFor,
	readCatalog,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import {
	brokerDelegation,
	brokerDriveUnavailable,
	brokerNoDelegation,
	brokerRefusal,
	brokerRevoked,
	gatewayNoRoute,
	type ContractReply
} from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
// When I gave the broker the permission for my assistant to act for me, long before any deletion
const GIVEN_BEFORE = '2026-09-20T08:00:00Z';
// The waits between the tries of a revocation: as many as the deployment's, each a moment
const REVOKE_RETRY_DELAYS_MS = [300, 300, 300, 300, 300];
// What my creator answers once it deleted my assistant
const DELETED = 'Your assistant is deleted. Send /newbot when you want a new one.';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// A moment as the broker dates it: to the second
function dated(at: Date): string {
	return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

describe('deleting my assistant revokes, at the broker, my permission for it to act for me', () => {
	let r: ConsentRoom;
	let creatorId: string;
	// My conversation with the creator
	let creatorRoom: string;
	// When I gave the permission the broker holds, as it dates it; null while it holds none
	let consentedAt: string | null = GIVEN_BEFORE;

	// What the broker answers about an owner's permission: mine while it holds it
	function brokerStatus(owner: string | null): ContractReply {
		if (owner !== ALICE || consentedAt === null) return brokerNoDelegation();
		const expiresAt = dated(new Date(Date.parse(consentedAt) + 30 * 86_400_000));
		return brokerDelegation(consentedAt, expiresAt);
	}

	// What the broker does when asked to revoke an owner's permission: it erases mine, even when my
	// Drive instance does not answer, then answers as told, done unless told otherwise
	function revoke(owner: string | null, answer: ContractReply = brokerRevoked()): ContractReply {
		if (owner === ALICE) consentedAt = null;
		return answer;
	}

	beforeAll(async () => {
		r = await startConsentRoom({}, { retryDelaysMs: { revoke: REVOKE_RETRY_DELAYS_MS } });
		// Forward-auth lets a call to my applications through while the broker holds my permission
		r.h.apisix.contracts.spec = readCatalog(['drive']);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(1);
		r.h.apisix.contracts.handler = (call) =>
			call.headers['x-twake-on-behalf-of'] === ALICE && consentedAt !== null
				? { status: 200, body: { items: ['Budget 2027'] } }
				: brokerRefusal('delegation_missing');
		r.h.apisix.llm.script = modelFor({
			'Search my drive': { tool: 'search_drive', args: { q: 'budget' } }
		});
		creatorId = r.h.role.creatorUserId;
		creatorRoom = await r.client.createDirectRoom(creatorId);
		await r.client.waitForMessage(creatorRoom, creatorId, (t) => t.includes('/newbot'));
	}, 240_000);
	beforeEach(() => {
		consentedAt = GIVEN_BEFORE;
		r.h.apisix.delegation = brokerStatus;
		r.h.apisix.revocation = (owner) => revoke(owner);
	});
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	// What the creator answers me next, once I wrote it a message
	async function answerTo(text: string): Promise<string> {
		const fromCreator = (): DecryptedMessage[] =>
			r.client.messages.filter((m) => m.roomId === creatorRoom && m.sender === creatorId);
		const seen = fromCreator().length;
		await r.client.sendText(creatorRoom, text);
		await until(`the creator answered « ${text} »`, () => fromCreator().length > seen);
		return fromCreator()[seen]?.body ?? '';
	}

	// Gives me a new assistant through the API, and resolves to its room
	async function newAssistant(name: string): Promise<string> {
		const created = await r.h.api.post<{ roomId: string }>(ALICE, '/v1/assistants', { name });
		expect(created.status).toBe(201);
		return created.body.roomId;
	}

	// The calls of the broker's route since the first `seen`, by method and by the owner they name
	function callsSince(seen: number): { method: string; owner: string | null }[] {
		return r.h.apisix.delegationCalls.slice(seen).map(({ method, owner }) => ({ method, owner }));
	}

	function methodsSince(seen: number): string[] {
		return callsSince(seen).map((call) => call.method);
	}

	// How many times the harness said so of my permission so far
	function said(msg: string): number {
		return r.h.logLines().filter((line) => line['msg'] === msg && line['owner'] === ALICE).length;
	}

	// The failed tries of the revocations so far, after the first `seen` log lines: their try and why
	function failedTries(seen: number): { attempts: unknown; error: unknown }[] {
		return r.h
			.logLines()
			.slice(seen)
			.filter((line) => line['msg'] === 'job failed' && line['kind'] === 'revoke')
			.map((line) => ({
				attempts: line['attempts'],
				error: (line['err'] as Record<string, unknown> | undefined)?.['message']
			}));
	}

	// Deletes my assistant with `remove` while my Drive instance does not answer the revocation, the
	// broker holding its 502 until the test lets it go: resolves, once the harness asked for the
	// revocation, to what lets that answer go out
	async function deleteWhileBrokerHolds(remove: () => Promise<void>): Promise<() => void> {
		let release = (): void => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const answers: ContractReply[] = [{ ...brokerDriveUnavailable(), hold: released }];
		r.h.apisix.revocation = (owner) => revoke(owner, answers.shift());
		const seen = r.h.apisix.delegationCalls.length;
		await remove();
		await until('the broker was asked to revoke my permission', () =>
			methodsSince(seen).includes('DELETE')
		);
		return release;
	}

	it('asks the broker, through the gateway and in my name, to revoke it once I confirm /delete', async () => {
		const seen = r.h.apisix.delegationCalls.length;
		const before = said('delegation revoked');
		expect(await answerTo('/delete')).toContain('Delete Jarvis?');
		expect(await answerTo('yes')).toBe(DELETED);
		await until('the harness revoked my permission', () => said('delegation revoked') > before);
		// It read first that I gave it before I asked for the deletion
		expect(callsSince(seen)).toEqual([
			{ method: 'GET', owner: ALICE },
			{ method: 'DELETE', owner: ALICE }
		]);
		for (const call of r.h.apisix.delegationCalls.slice(seen)) {
			expect(call.headers['apikey']).toBe(r.h.apisix.consumerKey);
		}
		expect(consentedAt).toBeNull();
	});

	it('asks the same once I delete my assistant through the API', async () => {
		await newAssistant('Iris');
		const seen = r.h.apisix.delegationCalls.length;
		const before = said('delegation revoked');
		expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
		await until('the harness revoked my permission', () => said('delegation revoked') > before);
		expect(callsSince(seen)).toEqual([
			{ method: 'GET', owner: ALICE },
			{ method: 'DELETE', owner: ALICE }
		]);
		expect(consentedAt).toBeNull();
	});

	it('tells me my assistant is deleted while the broker fails, then asks the broker again', async () => {
		await newAssistant('Iris');
		const seen = r.h.apisix.delegationCalls.length;
		const logged = r.h.logLines().length;
		const before = said('delegation revoked');
		// The creator answers me before the broker does
		const release = await deleteWhileBrokerHolds(async () => {
			expect(await answerTo('/delete')).toContain('Delete Iris?');
			expect(await answerTo('yes')).toBe(DELETED);
		});
		release();
		await until('the harness revoked my permission', () => said('delegation revoked') > before);
		// My permission was gone at the second try: the broker had yet to leave my Drive instance
		expect(methodsSince(seen)).toEqual(['GET', 'DELETE', 'GET', 'DELETE']);
		expect(failedTries(logged)).toEqual([
			{ attempts: 1, error: 'the delegation route answered 502 to the revocation' }
		]);
	});

	it('asks again while the gateway publishes no route to the broker', async () => {
		await newAssistant('Iris');
		// Neither route on the first try, the read alone on the second, both on the third
		const reads: ContractReply[] = [gatewayNoRoute()];
		const revocations: ContractReply[] = [gatewayNoRoute()];
		r.h.apisix.delegation = (owner) => reads.shift() ?? brokerStatus(owner);
		r.h.apisix.revocation = (owner) => revocations.shift() ?? revoke(owner);
		const seen = r.h.apisix.delegationCalls.length;
		const logged = r.h.logLines().length;
		const before = said('delegation revoked');
		expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
		await until('the harness revoked my permission', () => said('delegation revoked') > before);
		expect(methodsSince(seen)).toEqual(['GET', 'GET', 'DELETE', 'GET', 'DELETE']);
		expect(failedTries(logged)).toEqual([
			{ attempts: 1, error: 'the gateway publishes no delegation route at /delegation' },
			{ attempts: 2, error: 'the gateway publishes no delegation route at /delegation' }
		]);
		expect(consentedAt).toBeNull();
	});

	it('gives the revocation up after six tries, and says so', async () => {
		await newAssistant('Iris');
		r.h.apisix.revocation = (owner) => revoke(owner, brokerDriveUnavailable());
		const seen = r.h.apisix.delegationCalls.length;
		const logged = r.h.logLines().length;
		expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
		await until('the sixth try failed', () => failedTries(logged).length === 6);
		const error = 'the delegation route answered 502 to the revocation';
		expect(failedTries(logged)).toEqual(
			[1, 2, 3, 4, 5, 6].map((attempts) => ({ attempts, error }))
		);
		// My Drive instance answers again, and nobody asks the broker any more, longer than the wait
		// before a seventh try would be
		r.h.apisix.revocation = (owner) => revoke(owner);
		await sleep(3_000);
		expect(methodsSince(seen)).toEqual(Array.from({ length: 6 }, () => ['GET', 'DELETE']).flat());
	});

	it('still asks the broker for a deletion of mine once I deleted my next assistant, which erased my jobs', async () => {
		await newAssistant('Iris');
		const seen = r.h.apisix.delegationCalls.length;
		const before = said('delegation revoked');
		const release = await deleteWhileBrokerHolds(async () => {
			expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
		});
		// While the broker holds its answer, I create my next assistant and delete it too
		await newAssistant('Lucie');
		expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
		release();
		// The first revocation is tried again, and the second one runs
		await until(
			'the harness revoked my permission twice',
			() => said('delegation revoked') >= before + 2
		);
		expect(methodsSince(seen)).toEqual(['GET', 'DELETE', 'GET', 'DELETE', 'GET', 'DELETE']);
	});

	it('keeps the permission I give again between two tries, with which my next assistant reads my drive', async () => {
		await newAssistant('Iris');
		const seen = r.h.apisix.delegationCalls.length;
		const before = said('delegation kept: given again since the deletion');
		let deleted = 0;
		const release = await deleteWhileBrokerHolds(async () => {
			expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
			deleted = Date.now();
		});
		// I give it again once the broker erased the one I gave before, in a later second than my
		// deletion, as the broker dates a permission to the second
		await sleep(1_000 - (deleted % 1_000));
		consentedAt = dated(new Date());
		const given = consentedAt;
		release();
		await until(
			'the harness kept my permission',
			() => said('delegation kept: given again since the deletion') > before
		);
		expect(methodsSince(seen)).toEqual(['GET', 'DELETE', 'GET']);
		expect(consentedAt).toBe(given);
		// Forward-auth still answers for me: my next assistant reads my drive with that permission
		const room = await newAssistant('Lucie');
		await r.client.joinRoom(room);
		await r.client.waitForMessage(room, r.assistantId, (t) => t.includes('Lucie'));
		expect((await r.h.api.put(ALICE, '/v1/consents/drive/read', {})).status).toBe(201);
		await r.client.sendText(room, 'Search my drive');
		expect(
			await r.client.waitForMessage(room, r.assistantId, (t) => t.startsWith('Found:'))
		).toContain('Budget 2027');
	});
});
