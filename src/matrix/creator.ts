import { randomUUID } from 'node:crypto';

import type { AssistantService } from '../assistants/service.js';
import type { DialogState } from '../assistants/repository.js';
import { wordAnswer } from '../consents/answers.js';
import type { Messages } from '../i18n/messages.js';
import { CREATOR_COMMANDS, isCreatorCommand } from './commands.js';
import type { YesNoQuestion } from './questions.js';

// How long the owner has to confirm the deletion of their assistant once the creator asked
const DELETION_CONFIRMATION_MS = 10 * 60_000;

type ConfirmingDeletion = Extract<DialogState, { step: 'confirming_deletion' }>;

export function helpText(messages: Messages): string {
	const { helpHeader, commands, commandSeparator } = messages.creator;
	return [
		helpHeader,
		...CREATOR_COMMANDS.map(
			(name) => `${commands[name].command}${commandSeparator}${commands[name].help}`
		)
	].join('\n');
}

// The command a message's first word names: typed after « / », or after « ! » as Twake Chat sends
// a command the creator announced
function commandOf(word: string): string {
	const lowered = word.toLowerCase();
	const sent = lowered.startsWith('!') ? lowered.slice(1) : null;
	return sent !== null && isCreatorCommand(sent) ? `/${sent}` : lowered;
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
	// What the owner wrote, null for a message without words, as an image or a file
	readonly text: string | null;
	readonly state: DialogState | null;
	// The present, which a question asked now expires after
	readonly now: Date;
}

export interface CreatorDeps {
	readonly assistants: AssistantService;
	// Takes the answer to the question the dialog waits on: false when another message took it
	// first, as the same answer delivered twice, or two answers sent together
	readonly claimAnswer: (questionId: string) => Promise<boolean>;
}

// The creator conversation, like a bot factory: one command per message, one question at a time.
// Null when the creator has nothing to say: the message answers a question that another one
// already answered, or, without words, answers none.
export async function runCreatorTurn(
	input: CreatorInput,
	deps: CreatorDeps,
	messages: Messages
): Promise<CreatorTurn | null> {
	const { assistants } = deps;
	const say = messages.creator;
	if (input.state?.step === 'confirming_deletion') {
		const asked = input.state;
		const answer = await deletionAnswer(input, asked, assistants);
		if (answer !== null) {
			if (!(await deps.claimAnswer(asked.question.id))) return null;
			return settleDeletion(answer, input.owner, asked, assistants, say);
		}
	}
	// A message without words names no command
	if (input.text === null) return null;
	const text = input.text.trim();
	const [word = '', ...rest] = text.split(/\s+/);
	const command = commandOf(word);
	const argument = rest.join(' ').trim();
	// A question that no longer stands leaves nothing to wait for
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
			const assistant = await assistants.identify(input.owner);
			if (assistant === null) return { command, nextState: null, reply: say.nothingToDelete };
			const question: YesNoQuestion = {
				id: randomUUID(),
				expiresTs: input.now.getTime() + DELETION_CONFIRMATION_MS
			};
			return {
				command,
				nextState: {
					step: 'confirming_deletion',
					question,
					assistantCreatedAt: assistant.createdAt
				},
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

type DeletionAnswer = 'confirm' | 'cancel' | 'too_late';

// What the owner's message is to the question that asks them to confirm the deletion of their
// assistant. The question stands for the time it gives them, while the assistant it named is still
// their live one: a yes then confirms and any other message cancels, one without words included.
// Once the question no longer stands, a yes or a no comes too late, and anything else is no
// answer, null.
async function deletionAnswer(
	input: CreatorInput,
	asked: ConfirmingDeletion,
	assistants: AssistantService
): Promise<DeletionAnswer | null> {
	const answer = input.text === null ? null : wordAnswer(input.text);
	const live = await assistants.identify(input.owner);
	const stands =
		input.now.getTime() < asked.question.expiresTs &&
		live?.createdAt.getTime() === asked.assistantCreatedAt.getTime();
	if (!stands) return answer === null ? null : 'too_late';
	return answer === 'yes' ? 'confirm' : 'cancel';
}

// What the answer the message took comes to: a confirmation deletes the assistant the question
// named and no other, as it may yet have been deleted and created again since; an answer that
// deletes nothing says so
async function settleDeletion(
	answer: DeletionAnswer,
	owner: string,
	asked: ConfirmingDeletion,
	assistants: AssistantService,
	say: Messages['creator']
): Promise<CreatorTurn> {
	if (answer === 'cancel') {
		return { command: 'delete_cancelled', nextState: null, reply: say.deletionCancelled };
	}
	if (answer === 'confirm' && (await assistants.remove(owner, asked.assistantCreatedAt))) {
		return { command: 'delete_confirmed', nextState: null, reply: say.deleted };
	}
	return { command: 'delete_expired', nextState: null, reply: say.deletionExpired };
}
