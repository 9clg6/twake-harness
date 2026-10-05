import type { Tx } from '../db/client.js';

export type MemoryTarget = 'memory' | 'user';

export const MEMORY_TARGETS: readonly MemoryTarget[] = ['memory', 'user'];

export function toMemoryTarget(raw: unknown): MemoryTarget | null {
	return typeof raw === 'string' && (MEMORY_TARGETS as readonly string[]).includes(raw)
		? (raw as MemoryTarget) // SAFETY: membership confirmed above
		: null;
}

// Character budgets per store, the values Hermes uses for its notes and user profile
export const MEMORY_BUDGETS: Readonly<Record<MemoryTarget, number>> = { memory: 2200, user: 1375 };

export interface MemoryView {
	readonly memory: readonly string[];
	readonly user: readonly string[];
}

export type MemoryResult =
	| { readonly success: true; readonly target: MemoryTarget; readonly entries: number }
	| { readonly success: false; readonly error: string };

interface EntryRow {
	target: string;
	content: string;
}

export async function listMemory(tx: Tx, owner: string): Promise<MemoryView> {
	const rows = await tx.sql<EntryRow[]>`
		select target, content from memory_entries where owner = ${owner} order by id`;
	return {
		memory: rows.filter((r) => r.target === 'memory').map((r) => r.content),
		user: rows.filter((r) => r.target === 'user').map((r) => r.content)
	};
}

// Writers of one owner queue behind an advisory lock so the budget is checked against a
// settled store and no concurrent write is lost.
async function lockStore(tx: Tx, owner: string, target: MemoryTarget): Promise<void> {
	await tx.sql`select pg_advisory_xact_lock(hashtext(${`memory:${owner}:${target}`}))`;
}

async function usedChars(tx: Tx, owner: string, target: MemoryTarget): Promise<number> {
	const rows = await tx.sql<{ used: number }[]>`
		select coalesce(sum(length(content)), 0)::int as used
		from memory_entries where owner = ${owner} and target = ${target}`;
	return rows[0]?.used ?? 0;
}

async function countEntries(tx: Tx, owner: string, target: MemoryTarget): Promise<number> {
	const rows = await tx.sql<{ n: number }[]>`
		select count(*)::int as n from memory_entries where owner = ${owner} and target = ${target}`;
	return rows[0]?.n ?? 0;
}

export async function addMemoryEntry(
	tx: Tx,
	owner: string,
	target: MemoryTarget,
	content: string
): Promise<MemoryResult> {
	const text = content.trim();
	if (text.length === 0) return { success: false, error: 'content is empty' };
	await lockStore(tx, owner, target);
	const used = await usedChars(tx, owner, target);
	if (used + text.length > MEMORY_BUDGETS[target]) {
		return {
			success: false,
			error: `the ${target} store would exceed its budget of ${MEMORY_BUDGETS[target]} characters`
		};
	}
	await tx.sql`insert into memory_entries (owner, target, content) values (${owner}, ${target}, ${text})`;
	return { success: true, target, entries: await countEntries(tx, owner, target) };
}

export async function replaceMemoryEntry(
	tx: Tx,
	owner: string,
	target: MemoryTarget,
	oldText: string,
	newText: string
): Promise<MemoryResult> {
	const text = newText.trim();
	if (text.length === 0) return { success: false, error: 'content is empty' };
	await lockStore(tx, owner, target);
	const used = await usedChars(tx, owner, target);
	if (used - oldText.length + text.length > MEMORY_BUDGETS[target]) {
		return { success: false, error: `the ${target} store would exceed its budget` };
	}
	const result = await tx.sql`
		update memory_entries set content = ${text}
		where owner = ${owner} and target = ${target} and content = ${oldText}`;
	if (result.count === 0) return { success: false, error: 'no entry matches old_text' };
	return { success: true, target, entries: await countEntries(tx, owner, target) };
}

export async function removeMemoryEntry(
	tx: Tx,
	owner: string,
	target: MemoryTarget,
	oldText: string
): Promise<MemoryResult> {
	await lockStore(tx, owner, target);
	const result = await tx.sql`
		delete from memory_entries
		where owner = ${owner} and target = ${target} and content = ${oldText}`;
	if (result.count === 0) return { success: false, error: 'no entry matches old_text' };
	return { success: true, target, entries: await countEntries(tx, owner, target) };
}

export function formatMemoryForPrompt(view: MemoryView): string | null {
	const blocks: string[] = [];
	if (view.user.length > 0) {
		blocks.push(`## About the user\n${view.user.map((e) => `- ${e}`).join('\n')}`);
	}
	if (view.memory.length > 0) {
		blocks.push(`## Your notes\n${view.memory.map((e) => `- ${e}`).join('\n')}`);
	}
	return blocks.length === 0 ? null : blocks.join('\n\n');
}
