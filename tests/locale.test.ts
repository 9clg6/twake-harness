import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

describe('a deployment that speaks French', () => {
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	let client: E2eeClient;
	let creatorRoom: string;
	let assistantRoom: string;
	const assistantId = '@twake-space-assistant-alice:test.local';
	beforeAll(async () => {
		h = await startMatrixHarness({
			env: { ASSISTANT_LOCALE: 'fr', EVENTS_CLIENT_IDS: 'dispatcher' }
		});
		alice = await h.synapse.registerUser('alice');
		client = await startE2eeClient(h.synapse.url, alice);
		creatorRoom = await h.synapse.createDirectRoom(alice, h.role.creatorUserId);
	}, 240_000);
	afterAll(async () => {
		if (client !== undefined) await client.stop();
		if (h !== undefined) await h.close();
	});

	function fromCreator(predicate: (text: string) => boolean): Promise<string> {
		return h.synapse.waitForMessage(alice, creatorRoom, h.role.creatorUserId, predicate);
	}

	it('greets in the creator conversation with the commands in French', async () => {
		const help = await fromCreator((t) => t.includes('/newbot'));
		expect(help).toBe(
			[
				'Je crée et je gère ton assistant Twake Space :',
				'/newbot : créer ton assistant',
				'/mybot : voir ton assistant',
				'/rename <nom> : renommer ton assistant',
				'/delete : supprimer ton assistant',
				'/recover : récupérer les clés de chiffrement de ton assistant',
				'/help : cette liste'
			].join('\n')
		);
	});

	it('asks for a name and confirms the creation in French', async () => {
		await h.synapse.sendText(alice, creatorRoom, '/newbot');
		expect(await fromCreator((t) => t.includes('nom veux-tu'))).toBe(
			'Quel nom veux-tu lui donner ?'
		);
		await h.synapse.sendText(alice, creatorRoom, 'Lucie');
		expect(await fromCreator((t) => t.startsWith("C'est fait"))).toBe(
			"C'est fait : Lucie est @twake-space-assistant-alice:test.local. Une conversation privée t'attend : https://matrix.to/#/@twake-space-assistant-alice:test.local"
		);
	});

	it('welcomes its owner in French, under the name they chose', async () => {
		// The creator confirms once the room exists, so its invitation is already there
		const invite = (await h.synapse.pendingInvites(alice)).find((i) => i.inviter === assistantId);
		if (invite === undefined) throw new Error('the assistant did not invite its owner');
		assistantRoom = invite.roomId;
		await client.joinRoom(assistantRoom);
		expect(
			await client.waitForMessage(assistantRoom, assistantId, (t) => t.startsWith('Bonjour'))
		).toBe(
			"Bonjour, je m'appelle Lucie et je t'assiste sur Twake Space. Dis-moi ce dont tu as besoin : je retiens ce qui compte et je te demande avant d'agir."
		);
	});

	it('tells the model the name the owner chose, so the assistant introduces itself by it', async () => {
		await client.sendText(assistantRoom, 'Qui es-tu ?');
		await client.waitForMessage(assistantRoom, assistantId, (t) => t === 'echo: Qui es-tu ?');
		const system = h.apisix.llm.calls.at(-1)?.request.messages[0];
		expect(system?.role).toBe('system');
		expect(system?.content).toContain('You are "Lucie", the Twake Space assistant');
	});
	it('tells the model of an invitation in French: check the slot, propose, never accept', async () => {
		const posted = await h.api.post('dispatcher', '/v1/events', {
			owner: 'alice@test.local',
			event_id: 'evt-fr',
			type: 'calendar.invitation'
		});
		expect(posted.status).toBe(202);
		await client.waitForMessage(assistantRoom, assistantId, (t) => t.includes('(id evt-fr)'));
		const told = h.apisix.llm.calls
			.flatMap((call) => call.request.messages)
			.find((m) => m.role === 'user' && (m.content ?? '').includes('(id evt-fr)'));
		expect(told?.content).toMatch(
			/^\[événement\] Un nouvel événement de type « calendar\.invitation »/
		);
		expect(told?.content).toContain('read_freebusy');
		expect(told?.content).toContain('exclude');
		expect(told?.content).toContain("arrête-toi là : ne l'accepte pas toi-même");
	});
});
