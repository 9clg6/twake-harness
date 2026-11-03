import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { insertPendingCall } from '../src/consents/repository.js';
import { makeDb, withPrincipal, type Db } from '../src/db/client.js';
import { enqueueJob } from '../src/jobs/queue.js';
import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';

const OWNER = 'alice@test.local';
// The container's own user, which may take a right from the harness's role and give it back
const ADMIN_DATABASE_URL: string =
	process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://harness:harness@127.0.0.1:5433/harness';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(what: string, holds: () => Promise<boolean>): Promise<void> {
	for (let i = 0; i < 120; i += 1) {
		if (await holds()) return;
		await sleep(250);
	}
	throw new Error(`never: ${what}`);
}

describe('a send job that fails after its message went out', () => {
	let room: ConsentRoom;
	let admin: Db;
	beforeAll(async () => {
		// The next try waits long enough for the test to give the right back before it
		room = await startConsentRoom({}, { retryDelaysMs: { send: [2000, 2000] } });
		admin = makeDb(ADMIN_DATABASE_URL);
	});
	afterAll(async () => {
		await admin.close();
		await room.close();
	});

	it('sends the message once, and records it on its next try', async () => {
		const pendingCallId = await withPrincipal(room.h.db, { id: OWNER }, (tx) =>
			insertPendingCall(tx, {
				owner: OWNER,
				tool: 'mail_send',
				contract: 'mail',
				domain: 'mail',
				level: 'write',
				reasons: ['consent'],
				arguments: {},
				previewDigest: null,
				correlationId: null,
				origin: 'owner',
				sessionId: null,
				request: 'May I send it?'
			})
		);
		// Recording the question fails after the message went out: the database refuses the write,
		// until the right is given back
		await admin.sql.unsafe('revoke update on pending_calls from harness_app');
		await enqueueJob(room.h.db, {
			kind: 'send',
			payload: {
				asUserId: room.assistantId,
				roomId: room.room,
				text: 'MARK sent once',
				request: { pendingCallId, owner: OWNER }
			},
			groupKey: `send:${room.room}`
		});
		const failures = (): Record<string, unknown>[] =>
			room.h.logLines().filter((l) => l['msg'] === 'job failed');
		await until('the first try failed', async () => failures().length > 0);
		await admin.sql.unsafe('grant update on pending_calls to harness_app');
		await until(
			'the job is done',
			async () => (await room.h.db.sql`select 1 from jobs where kind = 'send'`).length === 0
		);
		expect(failures().map((l) => l['attempts'])).toEqual([1]);
		// Alice's client may still be reading the room
		await sleep(1000);
		const shown = room.saying('MARK sent once');
		expect(shown).toHaveLength(1);
		const recorded = await withPrincipal(
			room.h.db,
			{ id: OWNER },
			(tx) =>
				tx.sql<{ event: string | null }[]>`
					select request_event_id as event from pending_calls where id = ${pendingCallId}`
		);
		expect(recorded[0]?.event).toBe(shown[0]?.eventId);
		// Encrypted, as every message of the room is
		const stored = await room.h.synapse.request(
			room.alice,
			'GET',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room.room)}/event/${encodeURIComponent(shown[0]?.eventId ?? '')}`
		);
		expect((stored.body as { type?: string }).type).toBe('m.room.encrypted');
	});
});
