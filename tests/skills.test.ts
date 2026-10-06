import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient, type TestClient } from './helpers/client.js';
import type { ChatRequest, ToolCall } from './helpers/fake-apisix.js';

function toolCall(name: string, args: unknown): ToolCall[] {
	return [
		{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
	];
}

async function grantAdmin(h: TestHarness, sub: string): Promise<void> {
	await h.db.sql.begin(async (sql) => {
		await sql`select set_config('app.principal', ${sub}, true)`;
		await sql`insert into principals (id, actions) values (${sub}, '["chat","skills.read_own","skills.admin","memory.read_own","sessions.read_own"]'::jsonb)
			on conflict (id) do update set actions = excluded.actions`;
	});
}

describe('skills: libraries, discovery, proposals and approval', () => {
	let h: TestHarness;
	let c: TestClient;
	beforeAll(async () => {
		h = await startTestHarness();
		c = makeClient(h);
	});
	afterAll(async () => {
		await h.close();
	});
	beforeEach(() => {
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.script = () => ({ content: 'ok' });
	});

	it('lets a user write a skill and lists only their own and the organization ones', async () => {
		const mine = await c.post<{ id: string }>('romain', '/v1/skills', {
			name: 'Private skill',
			description: 'How Romain likes his reports',
			content: '# Private skill for romain\nShort, bullet points.'
		});
		expect(mine.status).toBe(201);
		expect(mine.body.id).toBe('romain-private-skill');
		await c.post('quentin', '/v1/skills', {
			name: 'Private skill',
			description: 'Quentin way',
			content: '# Private skill for quentin'
		});
		expect((await c.get<{ skills: string[] }>('romain', '/v1/skills')).body.skills).toEqual([
			'romain-private-skill'
		]);
		expect((await c.get<{ skills: string[] }>('quentin', '/v1/skills')).body.skills).toEqual([
			'quentin-private-skill'
		]);
	});

	it('foreign skill denied, through the API and the tool, and identity override denied', async () => {
		expect((await c.get('romain', '/v1/skills/quentin-private-skill')).status).toBe(404);
		expect(
			(await c.tool('romain', 'scoped_skills_read', { skill_id: 'quentin-private-skill' })).status
		).toBe(404);
		expect((await c.tool('romain', 'scoped_skills_list', { user_id: 'quentin' })).status).toBe(404);
		const own = await c.tool<{ content: string }>('romain', 'scoped_skills_read', {
			skill_id: 'romain-private-skill'
		});
		expect(own.status).toBe(200);
		expect(own.body.content).toContain('name: Private skill');
		expect(own.body.content).toContain('Private skill for romain');
	});

	it('the model sees the skills index in its prompt and reads its own skill through the tool worker', async () => {
		h.apisix.llm.script = (request: ChatRequest, index: number) =>
			index === 0
				? { toolCalls: toolCall('scoped_skills_read', { skill_id: 'romain-private-skill' }) }
				: { content: `read: ${request.messages.find((m) => m.role === 'tool')?.content ?? ''}` };
		const res = await c.post<{ answer: string; session_id: string }>('romain', '/v1/chat', {
			message: 'use my skill'
		});
		expect(res.body.answer).toContain('Private skill for romain');
		const system = h.apisix.llm.calls[0]?.request.messages[0]?.content ?? '';
		expect(system).toContain('romain-private-skill (yours): How Romain likes his reports');
		expect(system).not.toContain('quentin-private-skill');
		const transcript = await c.get<{ messages: { role: string; content: string }[] }>(
			'romain',
			`/v1/sessions/${res.body.session_id}`
		);
		expect(
			transcript.body.messages.some(
				(m) => m.role === 'tool' && m.content.includes('Private skill for romain')
			)
		).toBe(true);
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.script = (_request: ChatRequest, index: number) =>
			index === 0
				? { toolCalls: toolCall('scoped_skills_read', { skill_id: 'quentin-private-skill' }) }
				: { content: 'cannot' };
		const foreign = await c.post<{ answer: string; session_id: string }>('romain', '/v1/chat', {
			message: 'read quentin skill'
		});
		const t2 = await c.get<{ messages: { role: string; content: string }[] }>(
			'romain',
			`/v1/sessions/${foreign.body.session_id}`
		);
		expect(
			t2.body.messages.some((m) => m.role === 'tool' && m.content.includes('access denied'))
		).toBe(true);
	});

	it('a proposal of the model waits for approval, then is used on the next matching turn', async () => {
		h.apisix.llm.script = (_request: ChatRequest, index: number) =>
			index === 0
				? {
						toolCalls: toolCall('skills_propose', {
							name: 'Weekly digest',
							description: 'Summarize the week for Romain',
							content: 'List the three most important items.'
						})
					}
				: { content: 'proposed' };
		await c.post('romain', '/v1/chat', { message: 'remember how to do my digest' });
		const proposals = await c.get<{ proposals: { id: string; status: string }[] }>(
			'romain',
			'/v1/skills/proposals'
		);
		expect(proposals.body.proposals.map((p) => p.id)).toEqual(['romain-weekly-digest']);
		expect((await c.get<{ skills: string[] }>('romain', '/v1/skills')).body.skills).not.toContain(
			'romain-weekly-digest'
		);
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.script = () => ({ content: 'ok' });
		await c.post('romain', '/v1/chat', { message: 'digest please' });
		expect(h.apisix.llm.calls[0]?.request.messages[0]?.content ?? '').not.toContain(
			'romain-weekly-digest'
		);
		expect(
			(await c.post('romain', '/v1/skills/proposals/romain-weekly-digest/approve', {})).status
		).toBe(200);
		expect(
			(await c.post('quentin', '/v1/skills/proposals/romain-weekly-digest/approve', {})).status
		).toBe(404);
		h.apisix.llm.calls.length = 0;
		await c.post('romain', '/v1/chat', { message: 'digest please' });
		expect(h.apisix.llm.calls[0]?.request.messages[0]?.content ?? '').toContain(
			'romain-weekly-digest (yours): Summarize the week for Romain'
		);
	});

	it('organization skills are readable by everyone and written by administrators only', async () => {
		expect(
			(
				await c.post('romain', '/v1/org/skills', {
					name: 'Tone',
					description: 'How we write',
					content: 'Be brief.'
				})
			).status
		).toBe(403);
		await grantAdmin(h, 'admin');
		const created = await c.post<{ id: string }>('admin', '/v1/org/skills', {
			name: 'Tone',
			description: 'How we write',
			content: 'Be brief.'
		});
		expect(created.status).toBe(201);
		expect(created.body.id).toBe('org-tone');
		expect((await c.get<{ skills: string[] }>('quentin', '/v1/skills')).body.skills).toContain(
			'org-tone'
		);
		expect(
			(await c.get<{ content: string }>('quentin', '/v1/skills/org-tone')).body.content
		).toContain('Be brief.');
		h.apisix.llm.calls.length = 0;
		await c.post('quentin', '/v1/chat', { message: 'hello' });
		expect(h.apisix.llm.calls[0]?.request.messages[0]?.content ?? '').toContain(
			'org-tone (organization): How we write'
		);
	});

	it('promotion copies a proposal into the organization library and leaves the user library unchanged', async () => {
		await c.tool('quentin', 'skills_propose', {
			name: 'Triage',
			description: 'Sort incoming requests',
			content: 'Three buckets.'
		});
		expect(
			(
				await c.get<{ proposals: { id: string }[] }>('admin', '/v1/skills/proposals')
			).body.proposals.map((p) => p.id)
		).toContain('quentin-triage');
		expect((await c.post('romain', '/v1/org/skills/promote/quentin-triage', {})).status).toBe(403);
		const promoted = await c.post<{ id: string }>(
			'admin',
			'/v1/org/skills/promote/quentin-triage',
			{}
		);
		expect(promoted.status).toBe(201);
		expect(promoted.body.id).toBe('org-triage');
		expect((await c.get<{ skills: string[] }>('romain', '/v1/skills')).body.skills).toContain(
			'org-triage'
		);
		const quentinProposals = await c.get<{ proposals: { id: string; status: string }[] }>(
			'quentin',
			'/v1/skills/proposals'
		);
		expect(quentinProposals.body.proposals.map((p) => p.id)).toEqual(['quentin-triage']);
		expect((await c.get<{ skills: string[] }>('quentin', '/v1/skills')).body.skills).not.toContain(
			'quentin-triage'
		);
	});

	it('search finds skills by words of their description, only among what the user may read', async () => {
		const found = await c.tool<{ skills: { id: string }[] }>('romain', 'skills_search', {
			query: 'reports'
		});
		expect(found.body.skills.map((s) => s.id)).toEqual(['romain-private-skill']);
		const none = await c.tool<{ skills: { id: string }[] }>('romain', 'skills_search', {
			query: 'Quentin way'
		});
		expect(none.body.skills).toEqual([]);
	});
});
