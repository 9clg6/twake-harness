import type { Messages } from '../i18n/messages.js';

// The applications an owner's assistant may listen to, by the names their consents give them, in
// the order a brief offers them: what one of them publishes for the owner wakes the assistant only
// while it listens there
export const SOURCES = ['calendar', 'tasks', 'mail', 'drive', 'chat'] as const;
export type Source = (typeof SOURCES)[number];

// The source the calendar producer gave the invitations it published, which the harness gives
// Calendar's notifications and keeps their wake-ups by
export const CALENDAR_SOURCE = 'twake://calendar';

// What the harness knows of a source
export interface SourceEntry {
	readonly source: Source;
	// Whether its owner may have their assistant listen there or not
	readonly listenable: boolean;
	// Whether their assistant listens there until they choose otherwise
	readonly byDefault: boolean;
	// The application their assistant may read, at the read level, before it listens there, which
	// their yes to listening allows: none where listening reads nothing through a contract
	readonly reads: string | null;
	// What its producer publishes its activities under, which wake their assistant while it listens
	// there, and by none other: none where only their brief tells them what arrives
	readonly publishedAs: readonly string[];
	// Its source offer, the question a brief may ask its owner once, after it, of having their
	// assistant listen there, in their language, the application named as the catalog names it: none
	// where no brief makes one
	readonly offer?: (messages: Messages, application: string) => string;
}

// Every source, as the harness knows it, in the order of SOURCES
export type SourceRegistry = readonly SourceEntry[];

// Calendar and Tasks are listened to by default: the harness takes the activities their producers
// publish, Calendar's notifications under the source it names them by. Mail and Drive publish none it
// takes, so that listening there only has the brief read them: Mail waits for the owner's yes to the
// question of their first brief, and Drive for their asking. The Chat cannot be listened to yet, and
// its listening will read nothing through a contract. None has a source offer yet.
const ENTRIES: Readonly<Record<Source, Omit<SourceEntry, 'source'>>> = {
	calendar: {
		listenable: true,
		byDefault: true,
		reads: 'calendar',
		publishedAs: [CALENDAR_SOURCE]
	},
	tasks: { listenable: true, byDefault: true, reads: 'tasks', publishedAs: ['twake://tasks'] },
	mail: { listenable: true, byDefault: false, reads: 'mail', publishedAs: [] },
	drive: { listenable: true, byDefault: false, reads: 'drive', publishedAs: [] },
	chat: { listenable: false, byDefault: false, reads: null, publishedAs: [] }
};

export const SOURCE_REGISTRY: SourceRegistry = SOURCES.map((source) => ({
	source,
	...ENTRIES[source]
}));

// The sources their owner may have their assistant listen to or not
export const LISTENABLE: readonly Source[] = SOURCE_REGISTRY.filter(
	(entry) => entry.listenable
).map((entry) => entry.source);

// The listenable sources their assistant listens to unless they said otherwise
export const LISTENED_BY_DEFAULT: readonly Source[] = SOURCE_REGISTRY.filter(
	(entry) => entry.byDefault
).map((entry) => entry.source);

export function isSource(value: string): value is Source {
	return (SOURCES as readonly string[]).includes(value);
}

export function isListenable(value: string): value is Source {
	return (LISTENABLE as readonly string[]).includes(value);
}

// The application a source's listening allows its assistant to read, if any
export function readDomainOf(source: Source): string | null {
	return ENTRIES[source].reads;
}

// The listenable source an activity was published under, or null for one nobody listens to
export function sourceOfActivity(published: string): Source | null {
	const entry = SOURCE_REGISTRY.find(
		({ listenable, publishedAs }) => listenable && publishedAs.includes(published)
	);
	return entry?.source ?? null;
}

// Whether what a source publishes for its owner wakes their assistant while it listens there
export function wakesAssistant(source: Source): boolean {
	return ENTRIES[source].publishedAs.length > 0;
}

// What the producers of the sources given publish their activities under
export function publishedUnder(sources: readonly Source[]): string[] {
	return SOURCE_REGISTRY.filter(({ source }) => sources.includes(source)).flatMap(
		({ publishedAs }) => publishedAs
	);
}

// The harness's own words that confirm the owner's choice for a source, in their language, the
// application named as the catalog names it: what reaches them in an application that wakes no
// assistant, such as Mail or Drive, only their brief tells them of
export function listeningSaid(
	messages: Messages,
	source: Source,
	application: string,
	listening: boolean
): string {
	const { sources } = messages;
	if (wakesAssistant(source)) {
		return listening ? sources.listening(application) : sources.notListening(application);
	}
	return listening
		? sources.listeningForBrief(application)
		: sources.notListeningForBrief(application);
}
