// The CloudEvent type of a task assigned in Twake Tasks, which names its assignee among the
// recipients: the type the activity exchange wakes assistants for, unless the deployment lists
// others, and the one whose turn is told as a task assigned to the owner
export const TASK_ASSIGNED_EVENT_TYPE = 'com.twake.tasks.task.assigned.v1';

// The CloudEvent type of an invitation, as the calendar producer named it: what a new invitation in
// Calendar wakes its invitee's assistant as
export const INVITED_EVENT_TYPE = 'com.twake.calendar.event.invited.v1';
