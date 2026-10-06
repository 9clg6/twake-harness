import type { FastifyBaseLogger } from 'fastify';

import { withPrincipal, type Db, type Tx } from '../db/client.js';
import { readJsonColumn } from '../db/client.js';
import type { LlmMessage } from '../llm/client.js';
import { insertSkill } from '../skills/repository.js';

export interface CurationReport {
	readonly owners: number;
	readonly duplicatesRemoved: number;
	readonly proposalsMade: number;
}

// A request the user made the same way in several conversations is worth a skill
const RECURRENCE_THRESHOLD = 3;

function normalizeText(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function dedupeMemory(tx: Tx, owner: string): Promise<number> {
	const rows = await tx.sql<{ id: number; target: string; content: string }[]>`
		select id, target, content from memory_entries where owner = ${owner} order by id`;
	const seen = new Set<string>();
	const duplicates: number[] = [];
	for (const row of rows) {
		const key = `${row.target}:${normalizeText(row.content)}`;
		if (seen.has(key)) duplicates.push(Number(row.id));
		else seen.add(key);
	}
	if (duplicates.length === 0) return 0;
	await tx.sql`delete from memory_entries where owner = ${owner} and id in ${tx.sql(duplicates)}`;
	return duplicates.length;
}

async function proposeRecurringRequests(tx: Tx, owner: string): Promise<number> {
	const rows = await tx.sql<{ id: string; messages: unknown }[]>`
		select id, messages from sessions where owner = ${owner}`;
	const sessionsByRequest = new Map<string, { text: string; sessions: Set<string> }>();
	for (const row of rows) {
		const messages = readJsonColumn(row.messages);
		if (!Array.isArray(messages)) continue;
		for (const message of messages as LlmMessage[]) {
			if (message.role !== 'user' || typeof message.content !== 'string') continue;
			const key = normalizeText(message.content);
			if (key.length < 12) continue;
			const entry = sessionsByRequest.get(key) ?? {
				text: message.content.trim(),
				sessions: new Set<string>()
			};
			entry.sessions.add(row.id);
			sessionsByRequest.set(key, entry);
		}
	}
	const existing = new Set(
		(
			await tx.sql<
				{ name: string }[]
			>`select name from skills where scope = 'user' and owner = ${owner}`
		).map((r) => normalizeText(r.name))
	);
	let made = 0;
	for (const entry of sessionsByRequest.values()) {
		if (entry.sessions.size < RECURRENCE_THRESHOLD) continue;
		const name = `Recurring: ${entry.text.slice(0, 60)}`;
		if (existing.has(normalizeText(name))) continue;
		await insertSkill(tx, {
			scope: 'user',
			owner,
			status: 'proposed',
			name,
			description: `The user asked this in ${entry.sessions.size} conversations: ${entry.text.slice(0, 120)}`,
			content: `When the user asks: "${entry.text}"\n\nHandle it the way the previous conversations did, consistently, and ask only what is still missing.`
		});
		made += 1;
	}
	return made;
}

// The daily pass of the worker role: every owner's memory is deduplicated and their recurring
// requests become skill proposals, each owner's data touched under their own principal.
export async function runCuration(db: Db, log: FastifyBaseLogger): Promise<CurationReport> {
	const owners = (
		await db.sql<{ owner: string }[]>`select owner from principal_index order by owner`
	).map((r) => r.owner);
	let duplicatesRemoved = 0;
	let proposalsMade = 0;
	for (const owner of owners) {
		try {
			const result = await withPrincipal(db, { id: owner }, async (tx) => ({
				duplicates: await dedupeMemory(tx, owner),
				proposals: await proposeRecurringRequests(tx, owner)
			}));
			duplicatesRemoved += result.duplicates;
			proposalsMade += result.proposals;
			log.info({ owner, ...result }, 'curation of an owner');
		} catch (err: unknown) {
			log.error({ owner, err }, 'curation of an owner failed');
		}
	}
	const report = { owners: owners.length, duplicatesRemoved, proposalsMade };
	log.info(report, 'curation run');
	return report;
}

export interface CurationScheduler {
	stop(): void;
}

export function startCurationScheduler(
	db: Db,
	log: FastifyBaseLogger,
	intervalMs: number
): CurationScheduler {
	let timer: NodeJS.Timeout | null = null;
	const tick = (): void => {
		void runCuration(db, log).catch((err: unknown) => log.error({ err }, 'curation failed'));
	};
	tick();
	if (intervalMs > 0) timer = setInterval(tick, intervalMs);
	return {
		stop: () => {
			if (timer !== null) clearInterval(timer);
		}
	};
}
