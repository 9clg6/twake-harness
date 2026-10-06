import type { Tx } from '../db/client.js';

export type SkillScope = 'user' | 'org';
export type SkillStatus = 'active' | 'proposed' | 'rejected';

export interface SkillRecord {
	readonly id: string;
	readonly scope: SkillScope;
	readonly owner: string;
	readonly name: string;
	readonly description: string;
	readonly content: string;
	readonly status: SkillStatus;
}

export interface SkillSummary {
	readonly id: string;
	readonly scope: SkillScope;
	readonly name: string;
	readonly description: string;
	readonly status: SkillStatus;
}

interface SkillRow {
	id: string;
	scope: string;
	owner: string;
	name: string;
	description: string;
	content: string;
	status: string;
}

const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidSkillId(value: string): boolean {
	return SKILL_ID.test(value);
}

export function toSkillId(scope: SkillScope, owner: string, name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	const base = scope === 'org' ? `org-${slug}` : `${owner.replace(/[^a-z0-9]/g, '')}-${slug}`;
	return base.slice(0, 63);
}

function normalize(row: SkillRow): SkillRecord {
	return {
		id: row.id,
		scope: row.scope === 'org' ? 'org' : 'user',
		owner: row.owner,
		name: row.name,
		description: row.description,
		content: row.content,
		status:
			row.status === 'proposed' ? 'proposed' : row.status === 'rejected' ? 'rejected' : 'active'
	};
}

// The Agent Skills file: frontmatter with the name and description, then the instructions
export function toSkillMarkdown(skill: SkillRecord): string {
	return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.content}\n`;
}

export async function listSkills(tx: Tx, status: SkillStatus = 'active'): Promise<SkillSummary[]> {
	const rows = await tx.sql<SkillRow[]>`
		select id, scope, owner, name, description, content, status from skills
		where status = ${status} order by scope desc, name`;
	return rows.map(normalize).map(({ id, scope, name, description, status: s }) => ({
		id,
		scope,
		name,
		description,
		status: s
	}));
}

export async function findSkill(tx: Tx, id: string): Promise<SkillRecord | null> {
	const rows = await tx.sql<SkillRow[]>`
		select id, scope, owner, name, description, content, status from skills where id = ${id}`;
	const row = rows[0];
	return row === undefined ? null : normalize(row);
}

export async function searchSkills(tx: Tx, query: string): Promise<SkillSummary[]> {
	const pattern = `%${query.toLowerCase()}%`;
	const rows = await tx.sql<SkillRow[]>`
		select id, scope, owner, name, description, content, status from skills
		where status = 'active' and (lower(name) like ${pattern} or lower(description) like ${pattern})
		order by scope desc, name limit 20`;
	return rows.map(normalize).map(({ id, scope, name, description, status: s }) => ({
		id,
		scope,
		name,
		description,
		status: s
	}));
}

export interface NewSkill {
	readonly scope: SkillScope;
	readonly owner: string;
	readonly name: string;
	readonly description: string;
	readonly content: string;
	readonly status: SkillStatus;
}

export async function insertSkill(tx: Tx, skill: NewSkill): Promise<SkillRecord> {
	const id = toSkillId(skill.scope, skill.owner, skill.name);
	await tx.sql`
		insert into skills (id, scope, owner, name, description, content, status)
		values (${id}, ${skill.scope}, ${skill.owner}, ${skill.name}, ${skill.description}, ${skill.content}, ${skill.status})
		on conflict (id) do update set
			name = excluded.name, description = excluded.description, content = excluded.content,
			status = excluded.status, updated_at = now()`;
	return { id, ...skill };
}

export async function setSkillStatus(tx: Tx, id: string, status: SkillStatus): Promise<boolean> {
	const result =
		await tx.sql`update skills set status = ${status}, updated_at = now() where id = ${id}`;
	return result.count === 1;
}
