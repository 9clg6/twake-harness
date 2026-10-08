import type { Tx } from '../db/client.js';
import { markAssistantDeleted, type AssistantRecord } from './repository.js';

// Erases, in the transaction given under the owner's principal, what the harness keeps of their
// assistant and of what they told it: their conversations, its memory, their skills, the
// permissions they gave it, the calls that wait for their answer, the reminders of their
// delegation and the jobs that would still run for it. Its record stays, marked deleted, with the
// language its owner chose, and its rooms leave the index. What a new assistant needs or must not
// lose stays: the Matrix account, its device and keys, as a Matrix identifier is never reused, the
// owner's quota counters, the identity the harness pinned for them, and the wake-ups, which keep an
// event replayed later from waking the next assistant. False when the live assistant is no longer
// the one created at that time.
export async function eraseAssistant(
	tx: Tx,
	assistant: Pick<AssistantRecord, 'owner' | 'userId' | 'createdAt'>
): Promise<boolean> {
	const { owner, userId, createdAt } = assistant;
	// Locked first: a deletion that comes at the same time waits, then finds nothing left to erase
	const [live] = await tx.sql<{ created_at: Date }[]>`
		select created_at from assistants where owner = ${owner} and deleted_at is null for update`;
	if (live === undefined || live.created_at.getTime() !== createdAt.getTime()) return false;
	await markAssistantDeleted(tx, owner);
	await tx.sql`delete from assistant_rooms where owner = ${owner}`;
	await tx.sql`delete from assistant_provisioned where owner = ${owner}`;
	// The conversations go before what a turn keeps in their name, which holds its conversation as
	// it writes: such a write that came first is erased below, and one that comes later finds its
	// conversation gone and keeps nothing
	await tx.sql`delete from sessions where owner = ${owner}`;
	await tx.sql`delete from memory_entries where owner = ${owner}`;
	await tx.sql`delete from skills where owner = ${owner} and scope = 'user'`;
	await tx.sql`delete from consents where owner = ${owner}`;
	await tx.sql`delete from pending_calls where owner = ${owner}`;
	await tx.sql`delete from delegation_reminders where owner = ${owner}`;
	// The owner's turns, an event's included, whether queued, deferred or running, which then keeps
	// nothing; what the assistant was to send, answers and status counts; and the recoveries and
	// preparations that failed for good, which no route shows. A turn names its owner, a send the
	// account it goes out as, each in a payload the queue keeps as the JSON text of its fields.
	await tx.sql`
		delete from jobs where
			kind in ('turn', 'resume') and (payload #>> '{}')::jsonb ->> 'owner' = ${owner}
			or kind in ('send', 'progress') and (payload #>> '{}')::jsonb ->> 'asUserId' = ${userId}
			or kind in ('recover', 'prepare') and status = 'failed'
				and (payload #>> '{}')::jsonb ->> 'owner' = ${owner}`;
	return true;
}
