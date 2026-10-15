import type { RichText } from './format.js';

// The key by which the content of a message of the harness tells its owner's client that it asks
// them a question to answer yes or no, and which one: the client may offer both answers under it
// until the question expires, and send the one chosen as the owner's own words, which answer it as
// typed ones do. The text asks the same without it, for any other client.
const QUESTION_CONTENT_KEY = 'app.twake.assistant.question';

// A question its owner answers yes or no in their next message: what identifies it, and when it
// stops taking answers, in milliseconds since the epoch
export interface YesNoQuestion {
	readonly id: string;
	readonly expiresTs: number;
	readonly meeting?: MeetingContext;
}

// What a meeting suggestion adds to its marker, for the client to show a card from data rather than
// from the words of the text: the channel it comes from, the other people invited whose Matrix id
// the homeserver can name, the slot in milliseconds since the epoch and the title as text
export interface MeetingContext {
	readonly roomId: string;
	readonly invitees: readonly string[];
	readonly startTs: number;
	readonly endTs: number;
	readonly title: string;
}

function isMeetingContext(value: unknown): value is MeetingContext {
	if (typeof value !== 'object' || value === null) return false;
	const meeting = value as Record<string, unknown>;
	const invitees = meeting['invitees'];
	return (
		typeof meeting['roomId'] === 'string' &&
		Array.isArray(invitees) &&
		invitees.every((id) => typeof id === 'string') &&
		Number.isFinite(meeting['startTs']) &&
		Number.isFinite(meeting['endTs']) &&
		typeof meeting['title'] === 'string'
	);
}

export function isYesNoQuestion(value: unknown): value is YesNoQuestion {
	if (typeof value !== 'object' || value === null) return false;
	const question = value as Record<string, unknown>;
	return (
		typeof question['id'] === 'string' &&
		Number.isFinite(question['expiresTs']) &&
		(question['meeting'] === undefined || isMeetingContext(question['meeting']))
	);
}

// What the content says of a meeting suggestion, all of it or none
interface MeetingMarker {
	readonly kind: 'meeting';
	readonly room_id: string;
	readonly with: readonly string[];
	readonly start_ts: number;
	readonly end_ts: number;
	readonly title: string;
}

interface QuestionMarker {
	readonly id: string;
	readonly expires_ts: number;
}

// A text that asks a question to answer yes or no, and says under that key which one
type QuestionText = RichText & {
	readonly [QUESTION_CONTENT_KEY]: QuestionMarker | (QuestionMarker & MeetingMarker);
};

// The content of a message as it goes out: its text as it is, and the question it asks when it asks
// one to answer yes or no. Every yes or no question of the harness goes out this way, whatever it
// is about, so that the owner's client knows each one without reading its text.
export function markQuestion(content: RichText, question: YesNoQuestion | undefined): RichText {
	if (question === undefined) return content;
	const marked: QuestionText = {
		...content,
		[QUESTION_CONTENT_KEY]: {
			id: question.id,
			expires_ts: question.expiresTs,
			...(question.meeting === undefined
				? {}
				: {
						kind: 'meeting' as const,
						room_id: question.meeting.roomId,
						with: question.meeting.invitees,
						start_ts: question.meeting.startTs,
						end_ts: question.meeting.endTs,
						title: question.meeting.title
					})
		}
	};
	return marked;
}
