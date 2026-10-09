import type { Activity } from '../journal/repository.js';
import { activityView } from '../journal/tool.js';
import { isRecord } from '../matrix/json.js';
import {
	CANCELLED_EVENT_TYPE,
	COUNTERED_EVENT_TYPE,
	INVITED_EVENT_TYPE,
	MOVED_EVENT_TYPE,
	RENAMED_EVENT_TYPE,
	REPLIED_EVENT_TYPE,
	TASK_ASSIGNED_EVENT_TYPE
} from '../wakeups/event-types.js';

// The most activities of the owner's journal a brief is handed, the first ones that arrived
export const MAX_UNTOLD = 20;

// What an activity was, as the brief's template says it
export type UntoldKind =
	'invited' | 'moved' | 'renamed' | 'cancelled' | 'countered' | 'replied' | 'assigned' | 'other';

const KINDS: Readonly<Record<string, UntoldKind>> = {
	[INVITED_EVENT_TYPE]: 'invited',
	[MOVED_EVENT_TYPE]: 'moved',
	[RENAMED_EVENT_TYPE]: 'renamed',
	[CANCELLED_EVENT_TYPE]: 'cancelled',
	[COUNTERED_EVENT_TYPE]: 'countered',
	[REPLIED_EVENT_TYPE]: 'replied',
	[TASK_ASSIGNED_EVENT_TYPE]: 'assigned'
};

export function kindOf(activity: Activity): UntoldKind {
	return KINDS[activity.type] ?? 'other';
}

// The title of what an activity is about, as people wrote it, when its journal kept one
export function titleOf(activity: Activity): string | null {
	const title = activity.names?.untrusted['title'];
	return typeof title === 'string' ? title : null;
}

// A meeting a brief names by a number, and what the number names for the owner's next turns: its
// UID and its occurrence
export interface NumberedMeeting {
	readonly number: number;
	readonly uid: string;
	readonly recurrence_id: string | null;
}

type Meeting = Omit<NumberedMeeting, 'number'>;

// A task an activity is about, by its id, and by its key when Tasks gave one
interface Task {
	readonly key: string | null;
	readonly task_id: string;
}

// An activity no brief named yet, as the next one names it: a meeting by its number, a task by its
// key, or neither
export interface UntoldActivity {
	readonly activity: Activity;
	readonly meeting: NumberedMeeting | null;
	readonly task: Task | null;
}

// The activities of the owner's journal that had no turn and that no brief named yet, the first
// ones that arrived, and whether the journal had more
export interface Untold {
	readonly activities: readonly UntoldActivity[];
	readonly truncated: boolean;
}

// What the numbers and the keys of those activities name, for the owner's next turns
export type UntoldReference = NumberedMeeting | { readonly key?: string; readonly task_id: string };

// The meeting an activity of Calendar is about: its UID, as the organizer wrote it, and its
// occurrence
function meetingOf(activity: Activity): Meeting | null {
	const uid = activity.ids.untrusted['uid'];
	if (typeof uid !== 'string') return null;
	const occurrence = activity.ids.computed['recurrence_id'];
	return { uid, recurrence_id: typeof occurrence === 'string' ? occurrence : null };
}

// The task an activity of the activity exchange is about
function taskOf(activity: Activity): Task | null {
	const object = activity.ids.computed['object'];
	if (!isRecord(object) || object['type'] !== 'task') return null;
	const { id, key } = object;
	if (typeof id !== 'string') return null;
	return { key: typeof key === 'string' ? key : null, task_id: id };
}

// The activities no brief named yet, of those read, MAX_UNTOLD at most: each meeting numbered after
// the invitations the brief numbers, or with the number of its invitation when the brief numbers it
// too, so that a number names one meeting whatever section shows it
export function untoldOf(
	activities: readonly Activity[],
	invitations: readonly NumberedMeeting[]
): Untold {
	const keyOf = (meeting: Meeting): string => JSON.stringify([meeting.uid, meeting.recurrence_id]);
	const numbers = new Map(invitations.map((invitation) => [keyOf(invitation), invitation.number]));
	let last = Math.max(0, ...invitations.map((invitation) => invitation.number));
	const numbered = (meeting: Meeting): NumberedMeeting => {
		const key = keyOf(meeting);
		const known = numbers.get(key);
		if (known !== undefined) return { number: known, ...meeting };
		last += 1;
		numbers.set(key, last);
		return { number: last, ...meeting };
	};
	return {
		activities: activities.slice(0, MAX_UNTOLD).map((activity) => {
			const meeting = meetingOf(activity);
			return {
				activity,
				meeting: meeting === null ? null : numbered(meeting),
				task: meeting === null ? taskOf(activity) : null
			};
		}),
		truncated: activities.length > MAX_UNTOLD
	};
}

// What the model is handed of them: each activity as the listening journal shows it to a turn,
// after the number or the key the owner answers it by
export function untoldData(untold: Untold, timeZone: string): Record<string, unknown> {
	return {
		activities: untold.activities.map(({ activity, meeting, task }) => ({
			...(meeting === null ? {} : { number: meeting.number }),
			...(task === null || task.key === null ? {} : { key: task.key }),
			...activityView(activity, timeZone)
		})),
		truncated: untold.truncated
	};
}

// What their numbers and keys name: each meeting once, by its UID and occurrence, and each task by
// its id
export function untoldReferences(untold: Untold): readonly UntoldReference[] {
	const named = new Set<number>();
	return untold.activities.flatMap(({ meeting, task }): UntoldReference[] => {
		if (meeting !== null) {
			if (named.has(meeting.number)) return [];
			named.add(meeting.number);
			return [meeting];
		}
		if (task === null) return [];
		return [{ ...(task.key === null ? {} : { key: task.key }), task_id: task.task_id }];
	});
}
