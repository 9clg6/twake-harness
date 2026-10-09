import { expireWaitingCall, type ClosedRequest } from '../consents/repository.js';
import type { Tx } from '../db/client.js';

// The brief of an owner's working day that gave way to the harness's question about their
// permission for their assistant to act for them, the platform's broker holding none or an expired
// one: the date it is of, and the call that question froze, which their yes resumes as that brief
export interface BriefWait {
	readonly date: string;
	readonly pendingCallId: string;
}

// The owner's brief that waits for that permission, if one does
export async function findBriefWait(tx: Tx, owner: string): Promise<BriefWait | null> {
	const rows = await tx.sql<{ brief_date: string; pending_call_id: string }[]>`
		select brief_date::text as brief_date, pending_call_id from brief_delegation_waits
		where owner = ${owner}`;
	const row = rows[0];
	return row === undefined ? null : { date: row.brief_date, pendingCallId: row.pending_call_id };
}

// The brief waits for the owner's answer to the question that froze this call: the one it gave way
// to, or the one their yes got once the broker still refused the read
export async function keepBriefWait(tx: Tx, owner: string, wait: BriefWait): Promise<void> {
	await tx.sql`
		insert into brief_delegation_waits (owner, brief_date, pending_call_id)
		values (${owner}, ${wait.date}, ${wait.pendingCallId})
		on conflict (owner) do update set brief_date = excluded.brief_date,
			pending_call_id = excluded.pending_call_id`;
}

// A brief went out: none waits any more, and the question the last one gave way to closes as
// expired, should it still wait for an answer, or for its yes to run, so that a yes to it then
// runs nothing. The call a yes just ran as the brief is no longer waiting, and stays as it is.
// Resolves to that question's request when it closed unanswered.
export async function endBriefWait(tx: Tx, owner: string): Promise<ClosedRequest | null> {
	const rows = await tx.sql<{ pending_call_id: string }[]>`
		delete from brief_delegation_waits where owner = ${owner} returning pending_call_id`;
	const ended = rows[0];
	return ended === undefined ? null : expireWaitingCall(tx, owner, ended.pending_call_id);
}
