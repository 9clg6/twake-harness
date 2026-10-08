import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { insertPendingCall } from '../src/consents/repository.js';
import { withPrincipal, type Tx } from '../src/db/client.js';
import { ensurePrincipal } from '../src/principals/repository.js';
import { muteRoomFor, recordSuggestion, writeSettings } from '../src/suggestions/repository.js';
import { purgeSuggestions } from '../src/suggestions/retention.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';

const ALICE = 'alice@test.local';
const BOB = 'bob@test.local';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('the hourly purge of the suggestions', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness();
	});
	afterAll(async () => {
		if (h !== undefined) await h.close();
	});

	// A suggestion made the owner so many hours ago, whose call still waits for them or not
	async function suggest(tx: Tx, owner: string, hoursAgo: number, open: boolean): Promise<string> {
		const id = await insertPendingCall(tx, {
			owner,
			tool: 'create_meeting',
			contract: 'calendar',
			domain: 'calendar',
			level: 'write',
			reasons: ['event_turn', 'high_risk'],
			arguments: { body: { title: 'Sync', start: '2026-10-09T08:00:00Z' } },
			previewDigest: null,
			correlationId: null,
			origin: 'suggestion',
			sessionId: null,
			request: 'Create the meeting?'
		});
		await recordSuggestion(tx, owner, {
			pendingCallId: id,
			roomId: '!channel:test.local',
			startsAt: new Date('2026-10-09T08:00:00Z'),
			endsAt: new Date('2026-10-09T08:30:00Z'),
			attempt: 0
		});
		await tx.sql`
			update suggestions set created_at = now() - make_interval(hours => ${hoursAgo})
			where pending_call_id = ${id}`;
		await tx.sql`
			update pending_calls set created_at = now() - make_interval(hours => ${hoursAgo})
			where id = ${id}`;
		if (!open) {
			await tx.sql`update pending_calls set status = 'refused', arguments = null where id = ${id}`;
		}
		return id;
	}

	async function kept(owner: string): Promise<{ suggestions: string[]; mutes: string[] }> {
		return withPrincipal(h.db, { id: owner }, async (tx) => {
			const suggestions = await tx.sql<{ id: string }[]>`
				select pending_call_id as id from suggestions order by created_at`;
			const mutes = await tx.sql<{ room_id: string }[]>`
				select room_id from suggestion_mutes order by room_id`;
			return { suggestions: suggestions.map((r) => r.id), mutes: mutes.map((r) => r.room_id) };
		});
	}

	it('forgets what nothing reads any more, of every owner, and keeps what the caps, a refusal or a mute still read', async () => {
		const alice = await withPrincipal(h.db, { id: ALICE }, async (tx) => {
			await ensurePrincipal(tx, { id: ALICE });
			const ids = {
				// Closed, and older than a day: the caps no longer count it
				old: await suggest(tx, ALICE, 26, false),
				// Older than a day, and still waiting for my answer, which reads it
				waiting: await suggest(tx, ALICE, 25, true),
				// Closed, within the day the caps count
				recent: await suggest(tx, ALICE, 2, false)
			};
			await writeSettings(tx, ALICE, { enabled: false, mutedRooms: ['!for-good:test.local'] });
			await muteRoomFor(tx, ALICE, '!for-a-week:test.local', 7 * DAY_MS);
			await tx.sql`
				insert into suggestion_mutes (owner, room_id, until)
				values (${ALICE}, ${'!ended:test.local'}, now() - interval '1 minute')`;
			return ids;
		});
		const bobs = await withPrincipal(h.db, { id: BOB }, async (tx) => {
			await ensurePrincipal(tx, { id: BOB });
			return suggest(tx, BOB, 30, false);
		});
		const app = h.apps[0];
		if (app === undefined) throw new Error('no api role');

		// A request that lives two days keeps a suggestion closed after one
		expect(await purgeSuggestions(h.db, app.log, 2 * DAY_MS)).toBe(1);
		expect(await kept(ALICE)).toEqual({
			suggestions: [alice.old, alice.waiting, alice.recent],
			mutes: ['!for-a-week:test.local', '!for-good:test.local']
		});
		expect((await kept(BOB)).suggestions).toEqual([bobs]);

		expect(await purgeSuggestions(h.db, app.log, DAY_MS)).toBe(2);
		expect(await kept(ALICE)).toEqual({
			suggestions: [alice.waiting, alice.recent],
			mutes: ['!for-a-week:test.local', '!for-good:test.local']
		});
		expect((await kept(BOB)).suggestions).toEqual([]);
		// My switch stays as I set it
		const settings = await withPrincipal(
			h.db,
			{ id: ALICE },
			(tx) => tx.sql<{ enabled: boolean }[]>`select enabled from suggestion_settings`
		);
		expect(settings).toEqual([{ enabled: false }]);
		expect(h.logLines().filter((l) => l['msg'] === 'suggestions purged')).toMatchObject([
			{ purged: 1 },
			{ purged: 2 }
		]);
	});
});
