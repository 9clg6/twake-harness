import type { AssistantService } from '../assistants/service.js';
import type { DialogState } from '../assistants/repository.js';
import type { Messages } from '../i18n/messages.js';

export function helpText(messages: Messages): string {
	const { helpHeader, commands, commandSeparator } = messages.creator;
	return [helpHeader, ...commands.map((c) => `${c.command}${commandSeparator}${c.help}`)].join(
		'\n'
	);
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
	assistants: AssistantService,
	messages: Messages
): Promise<CreatorTurn> {
	const say = messages.creator;
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
				reply: say.refusals[created.reason]
			};
		}
		return {
			command: 'name',
			nextState: null,
			reply: say.created(created.assistant.name, created.assistant.userId, created.assistant.link)
		};
	}

	switch (command) {
		case '/newbot': {
			if ((await assistants.find(input.owner)) !== null) {
				return {
					command,
					nextState: null,
					reply: say.alreadyHasOne
				};
			}
			return {
				command,
				nextState: 'awaiting_name',
				reply: say.askName
			};
		}
		case '/mybot': {
			const assistant = await assistants.find(input.owner);
			return {
				command,
				nextState: null,
				reply:
					assistant === null
						? say.noneYet
						: say.mine(assistant.name, assistant.userId, assistant.link)
			};
		}
		case '/rename': {
			if (argument.length === 0) return { command, nextState: null, reply: say.renameUsage };
			const renamed = await assistants.rename(input.owner, argument);
			return {
				command,
				nextState: null,
				reply: renamed === null ? say.renameRefused : say.renamed(renamed.name)
			};
		}
		case '/delete': {
			const removed = await assistants.remove(input.owner);
			return {
				command,
				nextState: null,
				reply: removed ? say.deleted : say.nothingToDelete
			};
		}
		case '/recover':
			return { command, nextState: null, reply: say.recoveryUnavailable };
		case '/help':
		case 'help':
		case 'aide':
		case '/start':
			return { command: '/help', nextState: null, reply: helpText(messages) };
		default:
			return {
				command: 'unknown',
				nextState: input.state,
				reply: say.notUnderstood(text)
			};
	}
}
