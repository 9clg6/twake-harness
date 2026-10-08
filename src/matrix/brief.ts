import type { RichText } from './format.js';

// The key by which the content of a message of the harness tells its owner's client that it is the
// brief of their working day, and of which date: the client may show it apart from the
// conversation's other messages, which the text, sent as any other, does not need.
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';

// The brief a message is: the date, in its owner's zone, of the day it tells them of
export interface BriefMarker {
	readonly date: string;
}

export function isBriefMarker(value: unknown): value is BriefMarker {
	if (typeof value !== 'object' || value === null) return false;
	return typeof (value as Record<string, unknown>)['date'] === 'string';
}

// A text that is a brief, and says under that key of which date. It mentions nobody, in the
// intentional mentions of Matrix: its titles are what other people wrote, an @room included, which
// would otherwise notify as a mention of the room
type BriefText = RichText & {
	readonly [BRIEF_CONTENT_KEY]: BriefMarker;
	readonly 'm.mentions': Record<string, never>;
};

// The content of a message as it goes out: its text as it is, and the brief it is when it is one
export function markBrief(content: RichText, brief: BriefMarker | undefined): RichText {
	if (brief === undefined) return content;
	const marked: BriefText = {
		...content,
		[BRIEF_CONTENT_KEY]: { date: brief.date },
		'm.mentions': {}
	};
	return marked;
}
