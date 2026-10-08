// The applications an owner's assistant may listen to, by the names their consents give them: what
// one of them publishes for the owner wakes the assistant only while it listens there
export const SOURCES = ['calendar', 'tasks', 'mail', 'drive', 'chat'] as const;
export type Source = (typeof SOURCES)[number];

// The sources whose activities the harness takes today, which their owner may listen to or not, and
// which their assistant listens to unless they said otherwise
export const LISTENABLE: readonly Source[] = ['calendar', 'tasks'];

// The source the calendar producer gave the invitations it published, which the harness gives
// Calendar's notifications and keeps their wake-ups by
export const CALENDAR_SOURCE = 'twake://calendar';

// Each listenable source by the source its producer publishes its activities under, and by none
// other: Calendar's notifications, which the harness names so, and Tasks' events
const PUBLISHED_AS: ReadonlyMap<string, Source> = new Map([
	[CALENDAR_SOURCE, 'calendar'],
	['twake://tasks', 'tasks']
]);

export function isSource(value: string): value is Source {
	return (SOURCES as readonly string[]).includes(value);
}

export function isListenable(value: string): value is Source {
	return (LISTENABLE as readonly string[]).includes(value);
}

// The listenable source an activity was published under, or null for one nobody listens to
export function sourceOfActivity(published: string): Source | null {
	return PUBLISHED_AS.get(published) ?? null;
}
