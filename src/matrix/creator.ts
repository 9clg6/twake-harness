import { randomUUID } from 'node:crypto';

import type { AssistantService } from '../assistants/service.js';
import type { DialogState } from '../assistants/repository.js';
import { wordAnswer } from '../consents/answers.js';
import type { Messages } from '../i18n/messages.js';
import type { YesNoQuestion } from './questions.js';

// How long the owner has to confirm the deletion of their assistant once the creator asked
const DELETION_CONFIRMATION_MS = 10 * 60_000;

export function helpText(messages: Messages): string {
	const { helpHeader, commands, commandSeparator } = messages.creator;
	return [helpHeader, ...commands.map((c) => `${c.command}${commandSeparator}${c.help}`)].join(
		'\n'
	);
}

// What the owner's message was to the creator, as the matrix role logs it: a command, the name it
// asked for, an answer to its question, something it did not understand, or a turn that failed
export type CreatorCommand =
	| '/newbot'
	| '/mybot'
	| '/rename'
	| '/delete'
	| '/recover'
	| '/help'
	| 'name'
	| 'delete_confirmed'
	| 'delete_cancelled'
	| 'delete_expired'
	| 'unknown'
	| 'failed';

export interface CreatorTurn {
	readonly reply: string;
	// Where the dialog stands once the owner read the reply: the question it then waits on is the
	// one the reply asks
	readonly nextState: DialogState | null;
	readonly command: CreatorCommand;
}

export interface CreatorInput {
	readonly owner: string;
	readonly text: string;
	readonly state: DialogState | null;
	// The present, which a question asked now expires after
	readonly now: Date;
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

	if (input.state?.step === 'confirming_deletion') {
		const answered = await answerDeletion(input, input.state.question, assistants, say);
		if (answered !== null) return answered;
	}
	// A deletion that went unconfirmed in time leaves nothing to wait for
	const awaitingName = input.state?.step === 'awaiting_name';

	if (awaitingName && !command.startsWith('/')) {
		const created = await assistants.create(input.owner, text);
		if (!created.ok) {
			return {
				command: 'name',
				nextState: created.reason === 'invalid_name' ? { step: 'awaiting_name' } : null,
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
				nextState: { step: 'awaiting_name' },
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
			// Nothing is deleted yet: the owner confirms first, in the time the question gives them
			const assistant = await assistants.find(input.owner);
			if (assistant === null) return { command, nextState: null, reply: say.nothingToDelete };
			const question: YesNoQuestion = {
				id: randomUUID(),
				expiresTs: input.now.getTime() + DELETION_CONFIRMATION_MS
			};
			return {
				command,
				nextState: { step: 'confirming_deletion', question },
				reply: say.confirmDeletion(assistant.name)
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
				nextState: awaitingName ? { step: 'awaiting_name' } : null,
				reply: say.notUnderstood(text)
			};
	}
}

// The owner's message once the creator asked them to confirm the deletion of their assistant. In
// the time the question gives them, a yes deletes it and anything else cancels. Once that time is
// over, a yes or a no deletes nothing and is told so; anything else answers nothing, null.
async function answerDeletion(
	input: CreatorInput,
	question: YesNoQuestion,
	assistants: AssistantService,
	say: Messages['creator']
): Promise<CreatorTurn | null> {
	const answer = wordAnswer(input.text);
	if (input.now.getTime() >= question.expiresTs) {
		return answer === null
			? null
			: { command: 'delete_expired', nextState: null, reply: say.deletionExpired };
	}
	if (answer !== 'yes') {
		return { command: 'delete_cancelled', nextState: null, reply: say.deletionCancelled };
	}
	const removed = await assistants.remove(input.owner);
	return {
		command: 'delete_confirmed',
		nextState: null,
		reply: removed ? say.deleted : say.nothingToDelete
	};
}
