// The CloudEvent type of a task assigned in Twake Tasks, which names its assignee among the
// recipients: the type the activity exchange wakes assistants for, unless the deployment lists
// others, and the one whose turn is told as a task assigned to the owner
export const TASK_ASSIGNED_EVENT_TYPE = 'com.twake.tasks.task.assigned.v1';

// The CloudEvent type of an invitation, as the calendar producer named it: what a new invitation in
// Calendar wakes its invitee's assistant as
export const INVITED_EVENT_TYPE = 'com.twake.calendar.event.invited.v1';

// The type the harness gives a change to the start or the end of a meeting Calendar notifies an
// invitee of: its own name, which no producer publishes
export const MOVED_EVENT_TYPE = 'com.twake.calendar.event.moved.v1';

// The type the harness gives a change of a meeting's title alone, which it keeps for the invitee's
// brief: its own name too
export const RENAMED_EVENT_TYPE = 'com.twake.calendar.event.renamed.v1';

// The type the harness gives the cancellation of a meeting Calendar notifies an invitee of, of the
// meeting, one occurrence of its series or the whole series: its own name too
export const CANCELLED_EVENT_TYPE = 'com.twake.calendar.event.cancelled.v1';

// The type the harness gives an invitee's counter-proposal Calendar notifies the organizer of, of
// another time for the meeting: its own name too
export const COUNTERED_EVENT_TYPE = 'com.twake.calendar.event.countered.v1';

// The type the harness gives an invitee's answer to a meeting Calendar notifies the organizer of,
// which it keeps for the organizer's brief: its own name too
export const REPLIED_EVENT_TYPE = 'com.twake.calendar.event.replied.v1';

// What a change to a meeting, or a counter-proposal, is about, as its turn tells it: a meeting on
// its own, one occurrence of a series, or the whole series
export const MEETING_SCOPES = ['event', 'occurrence', 'series'] as const;
export type MeetingScope = (typeof MEETING_SCOPES)[number];

// The type of the wake-up by which the worker role's scheduler asks an owner's assistant for the
// brief of their working day: the harness's own, which no source publishes
export const BRIEF_EVENT_TYPE = 'com.twake.harness.brief.v1';
