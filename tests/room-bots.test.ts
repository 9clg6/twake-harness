import { describe, expect, it } from 'vitest';

import { COMMANDS_EVENT_TYPE } from '../src/matrix/commands.js';
import { botsOf } from '../src/matrix/role.js';

const member = (userId: string) => ({ type: 'm.room.member', state_key: userId, sender: userId });

describe('the bots of a room', () => {
	it('takes @bot_ and @hermes_ ids of our homeserver for bots', () => {
		const state = [member('@bot_x:ours.test'), member('@hermes_x:ours.test')];
		expect([...botsOf(state, 'ours.test')]).toEqual(['@bot_x:ours.test', '@hermes_x:ours.test']);
	});

	it('takes the same ids of another server for people, who are asked for their yes', () => {
		const state = [member('@bot_x:other.example'), member('@hermes_x:other.example')];
		expect(botsOf(state, 'ours.test').size).toBe(0);
	});

	it('takes a member announcing its own commands for a bot, wherever it comes from', () => {
		const announce = (userId: string, sender: string) => ({
			type: COMMANDS_EVENT_TYPE,
			state_key: userId,
			sender
		});
		const state = [
			announce('@a:other.example', '@a:other.example'),
			announce('@b:other.example', '@c:other.example')
		];
		expect([...botsOf(state, 'ours.test')]).toEqual(['@a:other.example']);
	});
});
