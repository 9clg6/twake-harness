import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/db/migrate.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import { eventually } from './helpers/feedback.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import {
	PROVISIONER,
	provisioned,
	provisioningPath,
	provisionUntilReady,
	type OwnedAssistant
} from './helpers/provisioning.js';
import type { MatrixUser } from './helpers/synapse.js';

// The migration that flags the live assistants to take their owner's first name at the next start
const FLAG_MIGRATION = '0065_assistants_rename_if_former_default.sql';

// Where a user's Matrix name is, on the homeserver's client API
function profileName(userId: string): string {
	return `/profile/${encodeURIComponent(userId)}/displayname`;
}

// Where a user's member event in a room is, on the homeserver's client API
function memberEvent(roomId: string, userId: string): string {
	return `/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`;
}

describe('an assistant named after its owner, on a homeserver that refuses display-name changes', () => {
	let h: MatrixTestHarness;
	const clients: E2eeClient[] = [];

	beforeAll(async () => {
		h = await startMatrixHarness({
			env: { PROVISIONER_CLIENT_IDS: PROVISIONER },
			// As the platform's homeserver: nobody changes the display name of their profile
			synapse: { enable_set_displayname: false }
		});
	}, 240_000);
	afterAll(async () => {
		for (const client of clients) await client.stop();
		if (h !== undefined) await h.close();
	});

	// The name the assistant goes by in the room, as its owner's client reads it: once it is the one
	// expected, or else when the time is up
	async function nameShown(
		owner: MatrixUser,
		roomId: string,
		assistantId: string,
		expected: string
	): Promise<unknown> {
		const path = `/_matrix/client/v3${memberEvent(roomId, assistantId)}`;
		let shown: unknown = null;
		await eventually(async () => {
			shown = (await h.synapse.request(owner, 'GET', path)).body['displayname'];
			return shown === expected;
		});
		return shown;
	}

	// How many calls of the method on the path the gateway passed on to the homeserver, since the
	// call counted first
	function calls(method: string, path: string, since = 0): number {
		return h.apisix.matrixCalls
			.slice(since)
			.filter((call) => call.method === method && call.path.includes(path)).length;
	}

	// The database as it stood before the flag, brought up to date: every live assistant is flagged
	// to take its owner's first name at the next start, as the assistants were when the harness
	// started naming them after it
	async function flagLiveAssistants(): Promise<void> {
		await h.db.sql`alter table assistants drop column rename_if_former_default`;
		await h.db.sql`delete from schema_migrations where name = ${FLAG_MIGRATION}`;
		expect((await runMigrations(h.db)).applied).toEqual([FLAG_MIGRATION]);
	}

	it("takes its owner's first name, the words before the first one in capitals", async () => {
		const { assistant } = await provisioned(h, 'michel', 'Michel-Marie MAUDET');
		expect(assistant.name).toBe("Michel-Marie's assistant");
	});

	it('keeps the first 64 characters of a long name, none of them cut in half', async () => {
		const { assistant } = await provisioned(h, 'ines', `Inès ${'😀'.repeat(70)}`);
		expect(assistant.name).toBe(`Inès ${'😀'.repeat(59)}`);
	});

	it("takes its owner's identifier when their name holds what a name of an assistant cannot", async () => {
		// The technologist emoji joins its two halves with a format character
		const { assistant } = await provisioned(h, 'zoe', 'Zoé 👩‍💻');
		expect(assistant.name).toBe("zoe's assistant");
	});

	it('goes by its name in the room its owner opens with it', async () => {
		const { owner, assistant } = await provisioned(h, 'nina', 'Nina SIMONE');
		const room = await h.synapse.createDirectRoom(owner, assistant.userId);
		expect(await nameShown(owner, room, assistant.userId, "Nina's assistant")).toBe(
			"Nina's assistant"
		);
	});

	it('goes by the name its owner chose in the room it opens with them', async () => {
		const owner = await h.synapse.registerUser('paul', 'Paul VALÉRY');
		const created = await h.api.post<OwnedAssistant>('paul@test.local', '/v1/assistants', {
			name: 'Friday'
		});
		expect(created.status).toBe(201);
		const room = created.body.roomId ?? '';
		await h.synapse.joinRoom(owner, room);
		expect(await nameShown(owner, room, created.body.userId, 'Friday')).toBe('Friday');
	});

	it('goes by its name in the room a provisioner makes its home', async () => {
		const { owner, assistant } = await provisioned(h, 'rosa', 'Rosa PARKS');
		// The homeserver refuses the name the assistant writes in the room it joins, each time the
		// queue tries it
		const member = `/state/m.room.member/${encodeURIComponent(assistant.userId)}`;
		let refused = 0;
		h.apisix.matrixFault = (call) => {
			if (call.method !== 'PUT' || !call.path.includes(member) || refused >= 3) return null;
			refused += 1;
			return 403;
		};
		try {
			const room = await h.synapse.createDirectRoom(owner, assistant.userId);
			expect(await eventually(() => refused === 3, 30_000)).toBe(true);

			const home = await h.api.put(PROVISIONER, `${provisioningPath(owner.userId)}/home`, {
				roomId: room
			});
			expect(home.status).toBe(204);
			expect(await nameShown(owner, room, assistant.userId, "Rosa's assistant")).toBe(
				"Rosa's assistant"
			);
		} finally {
			h.apisix.matrixFault = null;
		}
	});

	it('goes by each name its owner gives it in their room', async () => {
		const { owner, assistant } = await provisioned(h, 'omar', 'Omar SY');
		const room = await h.synapse.createDirectRoom(owner, assistant.userId);
		expect(await nameShown(owner, room, assistant.userId, "Omar's assistant")).toBe(
			"Omar's assistant"
		);

		for (const name of ['Jarvis', 'Vision']) {
			const renamed = await h.api.put('omar@test.local', '/v1/assistants/me', { name });
			expect(renamed.status).toBe(200);
			expect(await nameShown(owner, room, assistant.userId, name)).toBe(name);
		}
	});

	it('greets its owner, and tries its name in their room again when the homeserver refuses it', async () => {
		const qara = await h.synapse.registerUser('qara', 'Qara KHAN');
		const client = await startE2eeClient(h.synapse.url, qara);
		clients.push(client);
		const mine = await provisionUntilReady(h.api, qara.userId);
		// The homeserver refuses the name in the room twice, then takes it
		const member = `/state/m.room.member/${encodeURIComponent(mine.userId)}`;
		let refused = 0;
		h.apisix.matrixFault = (call) => {
			if (call.method !== 'PUT' || !call.path.includes(member) || refused >= 2) return null;
			refused += 1;
			return 403;
		};
		const before = h.logLines().length;
		try {
			const room = await client.createDirectRoom(mine.userId);
			await client.waitForMessage(room, mine.userId, (text) => text.startsWith('Hello'));
			expect(await nameShown(qara, room, mine.userId, "Qara's assistant")).toBe("Qara's assistant");
			expect(refused).toBe(2);
			// Each refusal fails the naming job, which the queue tries again
			const failed = h
				.logLines()
				.slice(before)
				.filter((line) => line['msg'] === 'job failed' && line['kind'] === 'name');
			expect(failed).toHaveLength(2);
		} finally {
			h.apisix.matrixFault = null;
		}
	});

	it('greets its owner while the homeserver hangs on its name in their room', async () => {
		const lea = await h.synapse.registerUser('lea', 'Léa SEYDOUX');
		const client = await startE2eeClient(h.synapse.url, lea);
		clients.push(client);
		const mine = await provisionUntilReady(h.api, lea.userId);
		let release = (): void => undefined;
		const hung = new Promise<void>((resolve) => {
			release = resolve;
		});
		const member = `/state/m.room.member/${encodeURIComponent(mine.userId)}`;
		let held = 0;
		h.apisix.matrixHold = (call) => {
			if (call.method !== 'PUT' || !call.path.includes(member)) return null;
			held += 1;
			return hung;
		};
		try {
			const room = await client.createDirectRoom(mine.userId);
			expect(await eventually(() => held === 1)).toBe(true);
			await client.waitForMessage(room, mine.userId, (text) => text.startsWith('Hello'));

			release();
			expect(await nameShown(lea, room, mine.userId, "Léa's assistant")).toBe("Léa's assistant");
		} finally {
			release();
			h.apisix.matrixHold = null;
		}
	});

	it("reads no owner's name when a provisioner asks again for their assistant", async () => {
		const { owner } = await provisioned(h, 'wim', 'Wim WENDERS');
		const renamed = await h.api.put('wim@test.local', '/v1/assistants/me', { name: 'Assistant' });
		expect(renamed.status).toBe(200);
		const before = calls('GET', profileName(owner.userId));

		const again = await h.api.put(PROVISIONER, provisioningPath(owner.userId), {});
		expect([200, 503]).toContain(again.status);
		expect(calls('GET', profileName(owner.userId))).toBe(before);
	});

	it("takes its owner's first name as the matrix role starts, if it goes by a former default name", async () => {
		const owners = [
			{ localpart: 'sara', name: 'Sara LEE', given: 'Assistant', expected: "Sara's assistant" },
			// The default name before the first name: the owner's whole Matrix name
			{
				localpart: 'theo',
				name: 'Théo DUPONT',
				given: "Théo DUPONT's assistant",
				expected: "Théo's assistant"
			},
			// A name its owner gave it stays
			{ localpart: 'uma', name: 'Uma THURMAN', given: 'Jarvis', expected: 'Jarvis' }
		];
		const opened: { owner: MatrixUser; assistantId: string; roomId: string; reads: number }[] = [];
		for (const { localpart, name, given } of owners) {
			const { owner, assistant } = await provisioned(h, localpart, name);
			const roomId = await h.synapse.createDirectRoom(owner, assistant.userId);
			expect(await nameShown(owner, roomId, assistant.userId, assistant.name)).toBe(assistant.name);
			const renamed = await h.api.put(`${localpart}@test.local`, '/v1/assistants/me', {
				name: given
			});
			expect(renamed.status).toBe(200);
			expect(await nameShown(owner, roomId, assistant.userId, given)).toBe(given);
			opened.push({ owner, assistantId: assistant.userId, roomId, reads: 0 });
		}
		await flagLiveAssistants();
		for (const room of opened)
			room.reads = calls('GET', memberEvent(room.roomId, room.assistantId));

		await h.restartRole();

		for (const [i, { localpart, expected }] of owners.entries()) {
			const room = opened[i];
			if (room === undefined) throw new Error('no room opened');
			// Once the role went over the assistant's name at its start
			const reads = (): number => calls('GET', memberEvent(room.roomId, room.assistantId));
			expect(await eventually(() => reads() > room.reads)).toBe(true);
			expect(await nameShown(room.owner, room.roomId, room.assistantId, expected)).toBe(expected);
			const mine = await h.api.get<OwnedAssistant>(`${localpart}@test.local`, '/v1/assistants/me');
			expect(mine.body.name).toBe(expected);
		}
	});

	it('keeps the name its owner gives it while the matrix role names it after them', async () => {
		const { owner, assistant } = await provisioned(h, 'vic', 'Vic CHESNUTT');
		const roomId = await h.synapse.createDirectRoom(owner, assistant.userId);
		const renamed = await h.api.put('vic@test.local', '/v1/assistants/me', { name: 'Assistant' });
		expect(renamed.status).toBe(200);
		expect(await nameShown(owner, roomId, assistant.userId, 'Assistant')).toBe('Assistant');
		await flagLiveAssistants();
		// The homeserver is slow to give the owner's name, as the role reads it at its start
		let release = (): void => undefined;
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		let held = 0;
		h.apisix.matrixHold = (call) => {
			if (call.method !== 'GET' || !call.path.includes(profileName(owner.userId)) || held > 0) {
				return null;
			}
			held += 1;
			return slow;
		};
		try {
			await h.restartRole();
			expect(await eventually(() => held === 1)).toBe(true);
			const meanwhile = await h.api.put('vic@test.local', '/v1/assistants/me', { name: 'Vision' });
			expect(meanwhile.status).toBe(200);
		} finally {
			release();
			h.apisix.matrixHold = null;
		}

		expect(await nameShown(owner, roomId, assistant.userId, 'Vision')).toBe('Vision');
		const mine = await h.api.get<OwnedAssistant>('vic@test.local', '/v1/assistants/me');
		expect(mine.body.name).toBe('Vision');
	});

	it('goes over its name at one start only, after which « Assistant » chosen by its owner stays', async () => {
		const owners = [
			{ localpart: 'ana', name: 'Ana DE ARMAS', given: 'Assistant' },
			{ localpart: 'bea', name: 'Bea ARTHUR', given: 'Assistant' },
			{ localpart: 'cid', name: 'Cid CAMPEADOR', given: 'Jarvis' }
		];
		const opened: { owner: MatrixUser; assistantId: string; roomId: string }[] = [];
		for (const { localpart, name, given } of owners) {
			const { owner, assistant } = await provisioned(h, localpart, name);
			const roomId = await h.synapse.createDirectRoom(owner, assistant.userId);
			const renamed = await h.api.put(`${localpart}@test.local`, '/v1/assistants/me', {
				name: given
			});
			expect(renamed.status).toBe(200);
			expect(await nameShown(owner, roomId, assistant.userId, given)).toBe(given);
			opened.push({ owner, assistantId: assistant.userId, roomId });
		}
		const [ana, bea, cid] = opened;
		if (ana === undefined || bea === undefined || cid === undefined) {
			throw new Error('no room opened');
		}
		await flagLiveAssistants();

		// At the first start, the homeserver fails to give bea's name each time the queue asks for it
		let refused = 0;
		h.apisix.matrixFault = (call) => {
			if (call.method !== 'GET' || !call.path.includes(profileName(bea.owner.userId))) return null;
			refused += 1;
			return 500;
		};
		const firstStart = h.apisix.matrixCalls.length;
		try {
			await h.restartRole();
			// The queue's third try, its last
			expect(await eventually(() => refused >= 3, 30_000)).toBe(true);
		} finally {
			h.apisix.matrixFault = null;
		}
		expect(await nameShown(ana.owner, ana.roomId, ana.assistantId, "Ana's assistant")).toBe(
			"Ana's assistant"
		);
		const cidRead = (): boolean =>
			calls('GET', memberEvent(cid.roomId, cid.assistantId), firstStart) > 0;
		expect(await eventually(cidRead)).toBe(true);
		const chosen = await h.api.put('ana@test.local', '/v1/assistants/me', { name: 'Assistant' });
		expect(chosen.status).toBe(200);
		expect(await nameShown(ana.owner, ana.roomId, ana.assistantId, 'Assistant')).toBe('Assistant');

		const secondStart = h.apisix.matrixCalls.length;
		await h.restartRole();

		// The one name the first start left unsettled
		expect(await nameShown(bea.owner, bea.roomId, bea.assistantId, "Bea's assistant")).toBe(
			"Bea's assistant"
		);
		// Nothing about the other two goes to the homeserver: their owners' names, their profiles or
		// their rooms
		const paths = [ana, cid].flatMap(({ owner, assistantId, roomId }) => [
			profileName(owner.userId),
			profileName(assistantId),
			memberEvent(roomId, assistantId)
		]);
		const checkedAgain = (): boolean =>
			h.apisix.matrixCalls
				.slice(secondStart)
				.some((call) => paths.some((path) => call.path.includes(path)));
		expect(await eventually(checkedAgain, 3_000)).toBe(false);
		for (const [localpart, expected] of [
			['ana', 'Assistant'],
			['bea', "Bea's assistant"],
			['cid', 'Jarvis']
		] as const) {
			const mine = await h.api.get<OwnedAssistant>(`${localpart}@test.local`, '/v1/assistants/me');
			expect(mine.body.name).toBe(expected);
		}
		expect(await nameShown(ana.owner, ana.roomId, ana.assistantId, 'Assistant')).toBe('Assistant');
	}, 240_000);
});
