import { isDeepStrictEqual } from 'node:util';

import type { FastifyBaseLogger } from 'fastify';

import type { Messages } from '../i18n/messages.js';
import type { MatrixAdmin } from './admin.js';

// The state event a bot announces its commands with in a room (MSC4332, unstable name), keyed by
// the bot's own id. Twake Chat offers them after « / » and sends one back as `!<name> ...`, the
// command's syntax in the message's content too.
export const COMMANDS_EVENT_TYPE = 'org.matrix.msc4332.commands';
const COMMAND_CONTENT_KEY = 'org.matrix.msc4332.command';

// The commands an assistant answers itself in its owner's rooms, without the model
const ASSISTANT_COMMANDS = ['help'] as const;
export type AssistantCommand = (typeof ASSISTANT_COMMANDS)[number];

function isAssistantCommand(word: string): word is AssistantCommand {
	return (ASSISTANT_COMMANDS as readonly string[]).includes(word);
}

// The commands the creator answers in its rooms, in the order its help lists them
export const CREATOR_COMMANDS = ['newbot', 'mybot', 'rename', 'delete', 'recover', 'help'] as const;
export type CreatorCommandName = (typeof CREATOR_COMMANDS)[number];

export function isCreatorCommand(word: string): word is CreatorCommandName {
	return (CREATOR_COMMANDS as readonly string[]).includes(word);
}

// The syntax the creator announces for a command: `rename` takes the rest of the message as the
// assistant's new name
function creatorSyntax(name: CreatorCommandName): string {
	return name === 'rename' ? 'rename {name...}' : name;
}

// The command an owner's message is, when it names one the assistant answers: as the client
// sends an announced command (its syntax in the content, `!help` as the text), or typed by hand
export function commandOf(
	text: string,
	content: Readonly<Record<string, unknown>> | undefined
): AssistantCommand | null {
	const announced = content?.[COMMAND_CONTENT_KEY];
	if (typeof announced === 'object' && announced !== null) {
		const syntax = (announced as Record<string, unknown>)['syntax'];
		const name = typeof syntax === 'string' ? (syntax.trim().split(/\s+/)[0] ?? '') : '';
		if (isAssistantCommand(name)) return name;
	}
	const typed = /^[!/](\S+)/.exec(text.trim())?.[1]?.toLowerCase() ?? '';
	return isAssistantCommand(typed) ? typed : null;
}

interface AnnouncedCommand {
	readonly name: string;
	readonly syntax: string;
	// MSC1767 text, as the client reads a description
	readonly description: { readonly 'm.text': readonly { readonly body: string }[] };
}

interface CommandsContent {
	readonly commands: AnnouncedCommand[];
}

function announced(name: string, syntax: string, description: string): AnnouncedCommand {
	return { name, syntax, description: { 'm.text': [{ body: description }] } };
}

export function commandsContent(messages: Messages): CommandsContent {
	return {
		commands: ASSISTANT_COMMANDS.map((name) =>
			announced(name, name, messages.assistantCommands[name].description)
		)
	};
}

// The creator's commands as the client offers them, each with what its help says it does
export function creatorCommandsContent(messages: Messages): CommandsContent {
	return {
		commands: CREATOR_COMMANDS.map((name) =>
			announced(name, creatorSyntax(name), messages.creator.commands[name].help)
		)
	};
}

export interface AnnounceDeps {
	readonly admin: MatrixAdmin;
	readonly log: FastifyBaseLogger;
}

type Announcement = 'announced' | 'unchanged' | 'refused';

// Announces a bot's commands in one of its rooms, as that bot. Written only when the room holds
// none or other ones, so announcing a room again changes nothing: compared as values, since the
// homeserver gives a state event back with its keys in another order. A room that refuses it (its
// power levels) is logged.
async function announce(
	deps: AnnounceDeps,
	roomId: string,
	userId: string,
	content: CommandsContent
): Promise<Announcement> {
	try {
		const current = await deps.admin.readState(userId, roomId, COMMANDS_EVENT_TYPE, userId);
		if (isDeepStrictEqual(current, content)) return 'unchanged';
		await deps.admin.writeState(userId, roomId, COMMANDS_EVENT_TYPE, userId, content);
		deps.log.info({ roomId, userId }, 'commands announced');
		return 'announced';
	} catch (err: unknown) {
		deps.log.warn({ roomId, userId, err }, 'commands not announced');
		return 'refused';
	}
}

// Announces an assistant's commands in one of its owner's rooms, as the assistant. A room that
// refuses it is tried again only at the next join or naming of it.
export function announceCommands(
	deps: AnnounceDeps,
	room: { readonly roomId: string; readonly assistantUserId: string },
	messages: Messages
): Promise<Announcement> {
	return announce(deps, room.roomId, room.assistantUserId, commandsContent(messages));
}

// Announces the creator's commands in one of its rooms, as the creator, in the language of the one
// it talks to there. A room that refuses it is tried again at the next start.
export function announceCreatorCommands(
	deps: AnnounceDeps,
	room: { readonly roomId: string; readonly creatorUserId: string },
	messages: Messages
): Promise<Announcement> {
	return announce(deps, room.roomId, room.creatorUserId, creatorCommandsContent(messages));
}
