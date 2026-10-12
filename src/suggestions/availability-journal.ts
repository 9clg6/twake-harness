import {
	NOTHING_SHOWN,
	noteActivity,
	type AvailabilityJournalOutcome
} from '../journal/repository.js';
import type { Tx } from '../db/client.js';
import { slotsOf, type AvailabilityAnswer, type AvailabilityRequest } from './availability.js';

// The source the invitee's assistant notes an availability request under, which their listening
// journal accepts without change: a source of the harness's own, not a contract's, and one no
// listenable list names, so an answered request never reaches a brief
export const AVAILABILITY_SOURCE: string = 'availability';

// The type of an availability request, the harness's own name as for its brief: the one activity a
// colleague's assistant asks the invitee's assistant, never the words of the conversation
export const AVAILABILITY_REQUEST_TYPE: string = 'com.twake.harness.availability.v1';

// What an availability request shows in the invitee's journal, as display fields the purge erases
// after a week as every other name: the colleague who asks, the period and the asked time, the
// duration, and the candidate slots given. Never a word of the conversation.
function shownOf(
	request: AvailabilityRequest,
	answer: AvailabilityAnswer
): Readonly<Record<string, unknown>> {
	return {
		organizer: request.organizer,
		period_start: request.periodStart,
		...(request.periodEnd === null ? {} : { period_end: request.periodEnd }),
		...(request.askedMinutes === null ? {} : { asked_minutes: request.askedMinutes }),
		duration_ms: request.durationMs,
		slots: slotsOf(answer).map((slot) => ({ start: slot.start, end: slot.end }))
	};
}

// Notes, in the invitee's listening journal, the one activity a colleague's availability request
// leaves: the source `availability`, its type, and whether their assistant answered with candidate
// slots or none, with the colleague, the period, the asked time, the duration and the slots given as
// display fields. Written under the invitee's principal, in the transaction the answerer already
// holds, and never posted in their room.
export async function noteAvailabilityRequest(
	tx: Tx,
	owner: string,
	request: AvailabilityRequest,
	answer: AvailabilityAnswer,
	outcome: AvailabilityJournalOutcome,
	now: Date
): Promise<void> {
	await noteActivity(tx, owner, {
		source: AVAILABILITY_SOURCE,
		eventId: request.id,
		type: AVAILABILITY_REQUEST_TYPE,
		receivedAt: now,
		outcome,
		noted: { ids: NOTHING_SHOWN, names: { computed: shownOf(request, answer), untrusted: {} } }
	});
}
