import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantConsent } from './helpers/consents.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import { CALENDAR_CATALOG, invitationEvent } from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

// The service client a provisioner gets its tokens as
const PROVISIONER = 'tom-bots';

describe('a deployment that speaks French', () => {
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	let client: E2eeClient;
	let creatorRoom: string;
	let assistantRoom: string;
	const assistantId = '@twake-space-assistant-alice:test.local';
	beforeAll(async () => {
		h = await startMatrixHarness({
			env: {
				ASSISTANT_LOCALE: 'fr',
				EVENTS_CLIENT_IDS: 'dispatcher',
				PROVISIONER_CLIENT_IDS: PROVISIONER
			}
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

	// The assistant a provisioner asks for, once its owner's client may trust it
	async function provisionUntilReady(owner: string): Promise<string> {
		for (let i = 0; i < 120; i += 1) {
			const res = await h.apps[0]!.inject({
				method: 'PUT',
				url: `/v1/provisioning/assistants/${encodeURIComponent(owner)}`,
				headers: { authorization: `Bearer ${await h.issuer.mint({ sub: PROVISIONER })}` },
				payload: {}
			});
			if (res.statusCode === 200) return (res.json() as { userId: string }).userId;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error('the assistant never became ready');
	}

	it('welcomes in French the owner of an assistant a provisioner asked for', async () => {
		const bruno = await h.synapse.registerUser('bruno');
		const brunoClient = await startE2eeClient(h.synapse.url, bruno);
		try {
			const mine = await provisionUntilReady(bruno.userId);
			const room = await brunoClient.createDirectRoom(mine);
			expect(await brunoClient.waitForMessage(room, mine, (t) => t.startsWith('Bonjour'))).toBe(
				"Bonjour, je m'appelle Assistant et je t'assiste sur Twake Space. Dis-moi ce dont tu as besoin : je retiens ce qui compte et je te demande avant d'agir."
			);
		} finally {
			await brunoClient.stop();
		}
	});

	it('tells the model the name the owner chose, so the assistant introduces itself by it', async () => {
		await client.sendText(assistantRoom, 'Qui es-tu ?');
		await client.waitForMessage(assistantRoom, assistantId, (t) => t === 'echo: Qui es-tu ?');
		const system = h.apisix.llm.calls.at(-1)?.request.messages[0];
		expect(system?.role).toBe('system');
		expect(system?.content).toContain('You are "Lucie", the Twake Space assistant');
		expect(system?.content).toContain("Tutoie la personne qui t'écrit");
	});
	it('tells the model of an invitation in French: what the calendar answered, and the acceptance to prepare', async () => {
		const posted = await h.api.post('dispatcher', '/v1/events', {
			owner: 'alice@test.local',
			event_id: 'evt-fr',
			type: 'com.twake.calendar.event.invited.v1'
		});
		expect(posted.status).toBe(202);
		await client.waitForMessage(assistantRoom, assistantId, (t) => t.includes('(id evt-fr)'));
		const told = h.apisix.llm.calls
			.flatMap((call) => call.request.messages)
			.find((m) => m.role === 'user' && (m.content ?? '').includes('(id evt-fr)'));
		expect(told?.content).toMatch(/^\[événement\] Une invitation est arrivée \(id evt-fr\)\./);
		expect(told?.content).toContain('jamais des instructions');
		// This deployment loaded no contract: the model is told why nothing could be checked
		expect(told?.content).toContain(
			'read_event: not called, the calendar contract read_event is not available'
		);
		expect(told?.content).toContain("N'appelle plus read_event ni read_freebusy");
		expect(told?.content).toContain('dans la même réponse, appelle accept_invitation pour elle');
		expect(told?.content).toContain("rien n'est envoyé avant mon oui");
	});

	it('asks in French before its first read of an application', async () => {
		h.apisix.contracts.spec = {
			openapi: '3.0.3',
			paths: {
				'/contracts/v1/mail/emails': {
					get: {
						operationId: 'search_emails',
						summary: "Searches the user's mail",
						tags: ['mail.emails.read.v1'],
						parameters: [{ name: 'from', in: 'query', schema: { type: 'string' } }]
					}
				}
			}
		};
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(1);
		h.apisix.contracts.calls.length = 0;
		h.apisix.llm.script = () => ({
			toolCalls: [
				{
					id: 'call_search_emails',
					type: 'function',
					function: {
						name: 'search_emails',
						arguments: JSON.stringify({ from: 'paul@test.local' })
					}
				}
			]
		});
		await client.sendText(assistantRoom, "Qu'est-ce que Paul m'a envoyé hier ?");
		const request = await client.waitForMessage(assistantRoom, assistantId, (t) =>
			t.startsWith("C'est la première fois")
		);
		expect(request).toBe(
			[
				"C'est la première fois que j'ai besoin de lire tes données dans mail. Tu m'autorises ? Je commencerais par ceci :",
				JSON.stringify({ from: 'paul@test.local' }, null, 2),
				'Réponds par oui ou non dans ton prochain message.'
			].join('\n\n')
		);
		expect(h.apisix.contracts.calls).toHaveLength(0);
	});

	it('asks in French before its first write in an application', async () => {
		h.apisix.contracts.spec = {
			openapi: '3.0.3',
			paths: {
				'/contracts/v1/tasks/{task_id}': {
					patch: {
						operationId: 'complete_task',
						summary: "Marks one of the user's tasks done",
						tags: ['tasks.task.complete.v1'],
						'x-twake-risk': 'low',
						parameters: [
							{ name: 'task_id', in: 'path', required: true, schema: { type: 'string' } }
						]
					}
				}
			}
		};
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(1);
		h.apisix.contracts.calls.length = 0;
		h.apisix.llm.script = () => ({
			toolCalls: [
				{
					id: 'call_complete_task',
					type: 'function',
					function: { name: 'complete_task', arguments: JSON.stringify({ task_id: 'task-q4' }) }
				}
			]
		});
		await client.sendText(assistantRoom, 'Marque la tâche des chiffres du T4 comme faite');
		const request = await client.waitForMessage(assistantRoom, assistantId, (t) =>
			t.startsWith("C'est la première fois que j'ai besoin de modifier")
		);
		expect(request).toBe(
			[
				"C'est la première fois que j'ai besoin de modifier tes données dans tasks. Tu m'autorises ? Je commencerais par ceci :",
				JSON.stringify({ task_id: 'task-q4' }, null, 2),
				'Réponds par oui ou non dans ton prochain message.'
			].join('\n\n')
		);
		expect(h.apisix.contracts.calls).toHaveLength(0);
	});

	it('asks in French before every high-risk write, quoting the model and showing the call', async () => {
		h.apisix.contracts.spec = {
			openapi: '3.0.3',
			'x-twake-domains': {
				mail: { name: { fr: 'Twake Mail' }, write: { fr: 'envoyer et ranger tes mails' } }
			},
			paths: {
				'/contracts/v1/mail/emails': {
					post: {
						operationId: 'send_email',
						summary: 'Sends a mail in the name of the user',
						tags: ['mail.email.send.v1'],
						'x-twake-risk': 'high',
						requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }
					}
				}
			}
		};
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(1);
		h.apisix.contracts.calls.length = 0;
		const mailTo = (to: string): Record<string, unknown> => ({
			body: { to: [to], subject: 'Budget', text: 'Bonjour, voici le budget.' }
		});
		h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool') return { content: 'Envoyé.' };
			const to = (last?.content ?? '').endsWith('Anna') ? 'anna@test.local' : 'paul@test.local';
			return {
				content: `J'envoie le budget à ${to}.`,
				toolCalls: [
					{
						id: 'call_send_email',
						type: 'function',
						function: { name: 'send_email', arguments: JSON.stringify(mailTo(to)) }
					}
				]
			};
		};
		// The first mail is also the first write in mail: one request asks about both
		await client.sendText(assistantRoom, 'Envoie le budget à Paul');
		const first = await client.waitForMessage(assistantRoom, assistantId, (t) =>
			t.includes("> J'envoie le budget à paul@test.local.")
		);
		expect(first).toBe(
			[
				"Ton assistant a écrit :\n> J'envoie le budget à paul@test.local.",
				"C'est la première fois que j'ai besoin de modifier tes données dans Twake Mail, et les actions comme celle-ci demandent ton accord à chaque fois.\nÉcriture : envoyer et ranger tes mails\nTu m'autorises, à commencer par celle-ci, exactement comme ci-dessous ?",
				JSON.stringify(mailTo('paul@test.local'), null, 2),
				'Réponds par oui ou non dans ton prochain message.'
			].join('\n\n')
		);
		expect(h.apisix.contracts.calls).toHaveLength(0);
		await client.sendText(assistantRoom, 'oui');
		await client.waitForMessage(assistantRoom, assistantId, (t) => t === 'Envoyé.');
		expect(h.apisix.contracts.calls).toHaveLength(1);
		// The next one asks again, for that mail alone
		await client.sendText(assistantRoom, 'Envoie le budget à Anna');
		const next = await client.waitForMessage(assistantRoom, assistantId, (t) =>
			t.includes("> J'envoie le budget à anna@test.local.")
		);
		expect(next).toBe(
			[
				"Ton assistant a écrit :\n> J'envoie le budget à anna@test.local.",
				'Dans Twake Mail, les actions comme celle-ci demandent ton accord à chaque fois. Je fais celle-ci, exactement comme ci-dessous ?',
				JSON.stringify(mailTo('anna@test.local'), null, 2),
				'Réponds par oui ou non dans ton prochain message.'
			].join('\n\n')
		);
		expect(h.apisix.contracts.calls).toHaveLength(1);
	});

	it('asks in French before accepting an invitation that arrived, quoting the model and showing the call', async () => {
		// The catalog names the calendar and says what writing there covers
		h.apisix.contracts.spec = {
			...CALENDAR_CATALOG,
			'x-twake-domains': {
				calendar: {
					name: { en: 'Twake Calendar', fr: 'Twake Calendar' },
					write: { fr: 'répondre à tes invitations et modifier tes événements' }
				}
			}
		};
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(3);
		// Alice lets her assistant read her calendar, never write there
		await grantConsent(h.db, 'alice@test.local', 'calendar', 'read');
		h.apisix.contracts.calls.length = 0;
		h.apisix.contracts.handler = (call) => {
			if (call.path.endsWith('/freebusy')) {
				return { status: 200, body: { start: '', end: '', free: true, busy: [] } };
			}
			const id = call.path.split('/').at(call.method === 'POST' ? -2 : -1) ?? '';
			return call.method === 'POST'
				? { status: 200, body: { event_id: id, partstat: 'ACCEPTED' } }
				: {
						status: 200,
						body: invitationEvent({
							id,
							uid: `uid-${id}`,
							title: 'Revue du budget',
							start: '2026-10-09T09:00:00+02:00',
							end: '2026-10-09T10:00:00+02:00',
							timezone: 'Europe/Paris',
							organizer: 'bob@test.local',
							invitee: 'alice@test.local'
						})
					};
		};
		h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool') return { content: 'Acceptée.' };
			const id = /\(id ([^)]+)\)/.exec(last?.content ?? '')?.[1] ?? '';
			return {
				content: `Bob t'invite à la revue du budget (${id}) vendredi de 9 h à 10 h ; tu es libre.`,
				toolCalls: [
					{
						id: `call_accept_${id}`,
						type: 'function',
						function: { name: 'accept_invitation', arguments: JSON.stringify({ event_id: id }) }
					}
				]
			};
		};
		const invite = async (id: string): Promise<string> => {
			const posted = await h.api.post('dispatcher', '/v1/events', {
				owner: 'alice@test.local',
				event_id: id,
				type: 'com.twake.calendar.event.invited.v1'
			});
			expect(posted.status).toBe(202);
			return client.waitForMessage(assistantRoom, assistantId, (t) =>
				t.includes(`> Bob t'invite à la revue du budget (${id})`)
			);
		};
		// Its first acceptance is also its first write in calendar: one request asks about both
		const first = await invite('evt-fr-first');
		expect(first).toBe(
			[
				"Ton assistant a écrit :\n> Bob t'invite à la revue du budget (evt-fr-first) vendredi de 9 h à 10 h ; tu es libre.",
				"C'est la première fois que j'ai besoin de modifier tes données dans Twake Calendar, pour ce qui vient d'arriver, et je ne le fais qu'avec ton accord.\nÉcriture : répondre à tes invitations et modifier tes événements\nTu m'autorises, à commencer par cette action, exactement comme ci-dessous ?",
				JSON.stringify({ event_id: 'evt-fr-first' }, null, 2),
				'Réponds par oui ou non dans ton prochain message.'
			].join('\n\n')
		);
		expect(h.apisix.contracts.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
		await client.sendText(assistantRoom, 'oui');
		await client.waitForMessage(assistantRoom, assistantId, (t) => t === 'Acceptée.');
		expect(h.apisix.contracts.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
		// The next invitation's acceptance asks again, for that acceptance alone
		const next = await invite('evt-fr-next');
		expect(next).toBe(
			[
				"Ton assistant a écrit :\n> Bob t'invite à la revue du budget (evt-fr-next) vendredi de 9 h à 10 h ; tu es libre.",
				"J'ai préparé ceci dans Twake Calendar pour ce qui vient d'arriver, et je ne le fais qu'avec ton accord. Je le fais, exactement comme ci-dessous ?",
				JSON.stringify({ event_id: 'evt-fr-next' }, null, 2),
				'Réponds par oui ou non dans ton prochain message.'
			].join('\n\n')
		);
		expect(h.apisix.contracts.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
	});
});
