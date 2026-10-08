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

export function commandsContent(messages: Messages): { readonly commands: AnnouncedCommand[] } {
	return {
		commands: ASSISTANT_COMMANDS.map((name) => ({
			name,
			syntax: name,
			description: { 'm.text': [{ body: messages.assistantCommands[name].description }] }
		}))
	};
}

export interface AnnounceDeps {
	readonly admin: MatrixAdmin;
	readonly log: FastifyBaseLogger;
}

// Announces an assistant's commands in one of its owner's rooms, as the assistant. Written only
// when the room holds none or other ones, so announcing a room again changes nothing. A room that
// refuses it (its power levels) is logged, and tried again only at the next join or naming of it.
export async function announceCommands(
	deps: AnnounceDeps,
	room: { readonly roomId: string; readonly assistantUserId: string },
	messages: Messages
): Promise<'announced' | 'unchanged' | 'refused'> {
	const { roomId, assistantUserId } = room;
	const content = commandsContent(messages);
	try {
		const current = await deps.admin.readState(
			assistantUserId,
			roomId,
			COMMANDS_EVENT_TYPE,
			assistantUserId
		);
		if (JSON.stringify(current) === JSON.stringify(content)) return 'unchanged';
		await deps.admin.writeState(
			assistantUserId,
			roomId,
			COMMANDS_EVENT_TYPE,
			assistantUserId,
			content
		);
		deps.log.info({ roomId, userId: assistantUserId }, 'commands announced');
		return 'announced';
	} catch (err: unknown) {
		deps.log.warn({ roomId, userId: assistantUserId, err }, 'commands not announced');
		return 'refused';
	}
}
