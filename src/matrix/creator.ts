import type { AssistantService } from '../assistants/service.js';
import type { DialogState } from '../assistants/repository.js';

export const CREATOR_COMMANDS: readonly { readonly command: string; readonly help: string }[] = [
	{ command: '/newbot', help: 'create your assistant' },
	{ command: '/mybot', help: 'show your assistant' },
	{ command: '/rename <name>', help: 'rename your assistant' },
	{ command: '/delete', help: 'delete your assistant' },
	{ command: '/recover', help: 'recover the encryption keys of your assistant' },
	{ command: '/help', help: 'this list' }
];

export function helpText(): string {
	return [
		'I create and manage your Twake Space assistant. Commands:',
		...CREATOR_COMMANDS.map((c) => `${c.command}: ${c.help}`)
	].join('\n');
}

export interface CreatorTurn {
	readonly reply: string;
	readonly nextState: DialogState | null;
	readonly command: string;
}

export interface CreatorInput {
	readonly owner: string;
	readonly text: string;
	readonly state: DialogState | null;
}

// The creator conversation, like a bot factory: one command per message, one question at a time.
export async function runCreatorTurn(
	input: CreatorInput,
	assistants: AssistantService
): Promise<CreatorTurn> {
	const text = input.text.trim();
	const [word = '', ...rest] = text.split(/\s+/);
	const command = word.toLowerCase();
	const argument = rest.join(' ').trim();

	if (input.state === 'awaiting_name' && !command.startsWith('/')) {
		const created = await assistants.create(input.owner, text);
		if (!created.ok) {
			return {
				command: 'name',
				nextState: created.reason === 'invalid_name' ? 'awaiting_name' : null,
				reply:
					created.reason === 'invalid_name'
						? 'That name is not usable: one line, 64 characters at most. Which name?'
						: 'You already have an assistant. Send /mybot to see it.'
			};
		}
		return {
			command: 'name',
			nextState: null,
			reply: `Done. Your assistant ${created.assistant.name} is ${created.assistant.userId}. It has opened a private conversation with you: ${created.assistant.link}`
		};
	}

	switch (command) {
		case '/newbot': {
			if ((await assistants.find(input.owner)) !== null) {
				return {
					command,
					nextState: null,
					reply: 'You already have an assistant. Send /mybot to see it, or /delete first.'
				};
			}
			return {
				command,
				nextState: 'awaiting_name',
				reply: 'Which name do you want for your assistant?'
			};
		}
		case '/mybot': {
			const assistant = await assistants.find(input.owner);
			return {
				command,
				nextState: null,
				reply:
					assistant === null
						? 'You have no assistant yet. Send /newbot to create one.'
						: `Your assistant ${assistant.name} is ${assistant.userId}: ${assistant.link}`
			};
		}
		case '/rename': {
			if (argument.length === 0)
				return { command, nextState: null, reply: 'Send /rename followed by the new name.' };
			const renamed = await assistants.rename(input.owner, argument);
			return {
				command,
				nextState: null,
				reply:
					renamed === null
						? 'Nothing to rename: you have no assistant, or that name is not usable.'
						: `Your assistant is now called ${renamed.name}.`
			};
		}
		case '/delete': {
			const removed = await assistants.remove(input.owner);
			return {
				command,
				nextState: null,
				reply: removed
					? 'Your assistant is deleted. Send /newbot when you want a new one.'
					: 'You have no assistant to delete.'
			};
		}
		case '/recover':
			return { command, nextState: null, reply: 'Key recovery is not available yet.' };
		case '/help':
		case 'help':
		case 'aide':
		case '/start':
			return { command: '/help', nextState: null, reply: helpText() };
		default:
			return {
				command: 'unknown',
				nextState: input.state,
				reply: `I did not understand « ${text} ». Send /help for the commands.`
			};
	}
}
