import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startE2eeClient, type DecryptedMessage, type E2eeClient } from './helpers/e2ee-client.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

const COMMANDS_TYPE = 'org.matrix.msc4332.commands';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function announced(name: string, syntax: string, description: string): unknown {
	return { name, syntax, description: { 'm.text': [{ body: description }] } };
}

// What Twake Chat offers after « / » in a room of the creator, in the deployment's language
const CREATOR_COMMANDS = {
	commands: [
		announced('newbot', 'newbot', 'create your assistant'),
		announced('mybot', 'mybot', 'show your assistant'),
		announced('rename', 'rename {name...}', 'rename your assistant'),
		announced('delete', 'delete', 'delete your assistant'),
		announced('recover', 'recover', 'recover the encryption keys of your assistant'),
		announced('help', 'help', 'this list')
	]
};

describe('Twake Chat offers the creator’s commands, which the creator takes as Chat sends them', () => {
	let h: MatrixTestHarness;
	let carol: MatrixUser;
	let client: E2eeClient;
	// My conversation with the creator, opened as Twake Chat opens it
	let room: string;
	let creatorId: string;
	beforeAll(async () => {
		h = await startMatrixHarness();
		carol = await h.synapse.registerUser('carol');
		client = await startE2eeClient(h.synapse.url, carol);
		creatorId = h.role.creatorUserId;
		room = await client.createDirectRoom(creatorId);
		await client.waitForMessage(room, creatorId, (t) => t.includes('/newbot'));
	}, 240_000);
	afterAll(async () => {
		if (client !== undefined) await client.stop();
		if (h !== undefined) await h.close();
	});

	// The commands a bot announced in a room, as a member reads them; null when it announced none
	async function announcedCommands(
		viewer: MatrixUser,
		roomId: string,
		botUserId: string,
		attempts = 40
	): Promise<unknown> {
		const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${COMMANDS_TYPE}/${encodeURIComponent(botUserId)}`;
		for (let i = 0; i < attempts; i += 1) {
			const res = await h.synapse.request(viewer, 'GET', path);
			if (res.status === 200) return res.body;
			await sleep(250);
		}
		return null;
	}

	function fromCreator(): DecryptedMessage[] {
		return client.messages.filter((m) => m.roomId === room && m.sender === creatorId);
	}

	// What the creator answers me next, once I sent it a command it announced, as Twake Chat sends
	// one: `!` before the command, its syntax in the content
	async function answerToCommand(text: string, syntax: string): Promise<string> {
		const seen = fromCreator().length;
		await client.client.sendMessage(room, {
			msgtype: 'm.text',
			body: text,
			'org.matrix.msc4332.command': { syntax, arguments: {} }
		});
		for (let i = 0; i < 120; i += 1) {
			const answer = fromCreator()[seen];
			if (answer !== undefined) return answer.body;
			await sleep(250);
		}
		throw new Error(`the creator did not answer « ${text} »`);
	}

	it('announces its commands in the direct room I open with it', async () => {
		expect(await announcedCommands(carol, room, creatorId)).toEqual(CREATOR_COMMANDS);
	});

	it('takes each command as Twake Chat sends it, a name it waits for included', async () => {
		expect(await answerToCommand('!mybot', 'mybot')).toBe(
			'You have no assistant yet. Send /newbot to create one.'
		);
		expect(await answerToCommand('!newbot', 'newbot')).toBe(
			'Which name do you want for your assistant?'
		);
		// A command while it waits for a name is a command, not the name
		expect(await answerToCommand('!mybot', 'mybot')).toBe(
			'You have no assistant yet. Send /newbot to create one.'
		);
		await answerToCommand('!newbot', 'newbot');
		await client.sendText(room, 'Jarvis');
		await client.waitForMessage(room, creatorId, (t) =>
			t.startsWith('Done. Your assistant Jarvis')
		);
		expect(await answerToCommand('!rename Friday', 'rename {name...}')).toBe(
			'Your assistant is now called Friday.'
		);
		expect(await answerToCommand('!help', 'help')).toContain(
			'/rename <name>: rename your assistant'
		);
		expect(await answerToCommand('!delete', 'delete')).toBe(
			'Delete Friday? I will erase its conversations, its memory, its skills and your permissions. Answer yes to confirm.'
		);
		await client.sendText(room, 'yes');
		await client.waitForMessage(room, creatorId, (t) => t.startsWith('Your assistant is deleted'));
	});

	it('announces its commands, once it starts, in the rooms it was already in', async () => {
		const dan = await h.synapse.registerUser('dan');
		const roomsPath = '/_matrix/client/v3/rooms';
		// A room opened before the creator announced anything: here only its creator may announce
		// commands, so the creator's announcement at its join is refused
		const created = await h.synapse.request(dan, 'POST', '/_matrix/client/v3/createRoom', {
			is_direct: true,
			preset: 'private_chat',
			invite: [creatorId],
			power_level_content_override: { events: { [COMMANDS_TYPE]: 100 } }
		});
		const older = created.body['room_id'] as string;
		await h.synapse.waitForMember(dan, older, creatorId);
		expect(await announcedCommands(dan, older, creatorId, 8)).toBeNull();
		// The room lets members announce commands from now on
		const levelsPath = `${roomsPath}/${encodeURIComponent(older)}/state/m.room.power_levels/`;
		const levels = (await h.synapse.request(dan, 'GET', levelsPath)).body;
		const events = { ...(levels['events'] as Record<string, number>), [COMMANDS_TYPE]: 0 };
		await h.synapse.request(dan, 'PUT', levelsPath, { ...levels, events });

		await h.restartRole();

		expect(await announcedCommands(dan, older, creatorId)).toEqual(CREATOR_COMMANDS);
	});
});
