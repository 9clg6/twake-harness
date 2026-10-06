import { z } from 'zod';

import { withPrincipal, type Db } from '../db/client.js';
import type { LlmToolDefinition } from '../llm/client.js';
import {
	addMemoryEntry,
	removeMemoryEntry,
	replaceMemoryEntry,
	toMemoryTarget
} from '../memory/repository.js';
import { findSession, listSessionIds } from '../sessions/repository.js';
import {
	findSkill,
	insertSkill,
	listSkills,
	searchSkills,
	toSkillMarkdown
} from '../skills/repository.js';

export const ACCESS_DENIED = { error: 'access denied' } as const;

export interface ToolOutcome {
	// What the model reads back
	readonly result: unknown;
	// When set, the turn ends with this text as the answer to the user
	readonly final?: string;
	// Set when the caller tried to reach something that is not theirs
	readonly denied?: boolean;
}

export interface ToolContext {
	readonly principalId: string;
	readonly actions: readonly string[];
	readonly db: Db;
}

export interface Tool {
	readonly definition: LlmToolDefinition;
	// The argument keys the tool accepts; anything else is refused before it runs
	readonly argumentKeys: readonly string[];
	readonly requiredAction: string | null;
	run(args: unknown, context: ToolContext): Promise<ToolOutcome>;
}

export interface ToolRegistry {
	readonly definitions: readonly LlmToolDefinition[];
	find(name: string): Tool | null;
}

// Static tools, plus a source of tools that may change over time, such as the contract catalog
export function makeToolRegistry(
	tools: readonly Tool[],
	extra: () => readonly Tool[] = () => []
): ToolRegistry {
	const byName = new Map(tools.map((tool) => [tool.definition.function.name, tool]));
	return {
		get definitions() {
			return [...tools, ...extra()].map((tool) => tool.definition);
		},
		find: (name) =>
			byName.get(name) ?? extra().find((tool) => tool.definition.function.name === name) ?? null
	};
}

function hasOnlyKeys(args: unknown, keys: readonly string[]): args is Record<string, unknown> {
	return (
		typeof args === 'object' &&
		args !== null &&
		!Array.isArray(args) &&
		Object.keys(args).every((key) => keys.includes(key))
	);
}

// Identity never travels in tool arguments: a tool that receives an unknown key, an owner, a
// path or a profile is refused before it runs, whoever the caller is.
export async function runTool(
	tool: Tool,
	args: unknown,
	context: ToolContext
): Promise<ToolOutcome> {
	if (!hasOnlyKeys(args, tool.argumentKeys)) return { result: ACCESS_DENIED, denied: true };
	if (tool.requiredAction !== null && !context.actions.includes(tool.requiredAction)) {
		return { result: ACCESS_DENIED, denied: true };
	}
	return tool.run(args, context);
}

const clarifyArgs = z.object({ question: z.string().min(1) });

// Asking the user a question ends the turn: the question is the answer.
export const clarifyTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'clarify',
			description:
				'Ask the user one short question when the request is ambiguous and you cannot proceed without the answer.',
			parameters: {
				type: 'object',
				properties: { question: { type: 'string', description: 'The question to ask' } },
				required: ['question'],
				additionalProperties: false
			}
		}
	},
	argumentKeys: ['question'],
	requiredAction: null,
	run: async (args) => {
		const parsed = clarifyArgs.safeParse(args);
		if (!parsed.success) return { result: { error: 'question is required' } };
		return { result: { asked: true }, final: parsed.data.question };
	}
};

const memoryArgs = z.object({
	action: z.enum(['add', 'replace', 'remove']),
	target: z.string().optional(),
	content: z.string().optional(),
	old_text: z.string().optional(),
	new_text: z.string().optional()
});

export const memoryTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'memory',
			description:
				"Persist what is worth remembering across conversations. target 'user' holds who the user is and how they like answers; target 'memory' holds your own notes. Entries are short, one fact each.",
			parameters: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['add', 'replace', 'remove'] },
					target: { type: 'string', enum: ['memory', 'user'] },
					content: {
						type: 'string',
						description: 'The entry to add, or the new text of a replace'
					},
					old_text: { type: 'string', description: 'The exact entry to replace or remove' },
					new_text: { type: 'string', description: 'The new text of a replace' }
				},
				required: ['action'],
				additionalProperties: false
			}
		}
	},
	argumentKeys: ['action', 'target', 'content', 'old_text', 'new_text'],
	requiredAction: 'memory.write_own',
	run: async (args, context) => {
		const parsed = memoryArgs.safeParse(args);
		if (!parsed.success) return { result: { success: false, error: 'invalid arguments' } };
		const target = toMemoryTarget(parsed.data.target ?? 'memory');
		if (target === null) return { result: ACCESS_DENIED, denied: true };
		const { action, content, old_text: oldText, new_text: newText } = parsed.data;
		const result = await withPrincipal(context.db, { id: context.principalId }, async (tx) => {
			if (action === 'add') return addMemoryEntry(tx, context.principalId, target, content ?? '');
			if (oldText === undefined) return { success: false as const, error: 'old_text is required' };
			if (action === 'remove') return removeMemoryEntry(tx, context.principalId, target, oldText);
			return replaceMemoryEntry(tx, context.principalId, target, oldText, newText ?? content ?? '');
		});
		return { result };
	}
};

export const sessionsListTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'scoped_sessions_list',
			description: 'List the identifiers of your own past conversations.',
			parameters: { type: 'object', properties: {}, additionalProperties: false }
		}
	},
	argumentKeys: [],
	requiredAction: 'sessions.read_own',
	run: async (_args, context) => ({
		result: {
			sessions: await withPrincipal(context.db, { id: context.principalId }, (tx) =>
				listSessionIds(tx)
			)
		}
	})
};

const sessionReadArgs = z.object({ session_id: z.string() });

export const sessionsReadTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'scoped_sessions_read',
			description: 'Read the transcript of one of your own past conversations.',
			parameters: {
				type: 'object',
				properties: { session_id: { type: 'string' } },
				required: ['session_id'],
				additionalProperties: false
			}
		}
	},
	argumentKeys: ['session_id'],
	requiredAction: 'sessions.read_own',
	run: async (args, context) => {
		const parsed = sessionReadArgs.safeParse(args);
		if (!parsed.success) return { result: ACCESS_DENIED, denied: true };
		const session = await withPrincipal(context.db, { id: context.principalId }, (tx) =>
			findSession(tx, parsed.data.session_id)
		);
		return session === null
			? { result: ACCESS_DENIED, denied: true }
			: { result: { messages: session.messages } };
	}
};

export const skillsListTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'scoped_skills_list',
			description: 'List the skills available to you: your own and those of the organization.',
			parameters: { type: 'object', properties: {}, additionalProperties: false }
		}
	},
	argumentKeys: [],
	requiredAction: 'skills.read_own',
	run: async (_args, context) => ({
		result: {
			skills: await withPrincipal(context.db, { id: context.principalId }, (tx) => listSkills(tx))
		}
	})
};

const skillSearchArgs = z.object({ query: z.string().min(1).max(200) });

export const skillsSearchTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'skills_search',
			description:
				"Find skills by words of their name or description, among yours and the organization's.",
			parameters: {
				type: 'object',
				properties: { query: { type: 'string' } },
				required: ['query'],
				additionalProperties: false
			}
		}
	},
	argumentKeys: ['query'],
	requiredAction: 'skills.read_own',
	run: async (args, context) => {
		const parsed = skillSearchArgs.safeParse(args);
		if (!parsed.success) return { result: { error: 'query is required' } };
		return {
			result: {
				skills: await withPrincipal(context.db, { id: context.principalId }, (tx) =>
					searchSkills(tx, parsed.data.query)
				)
			}
		};
	}
};

const skillReadArgs = z.object({ skill_id: z.string().min(1) });

export const skillsReadTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'scoped_skills_read',
			description: 'Read a skill by its id and follow its instructions for the task at hand.',
			parameters: {
				type: 'object',
				properties: { skill_id: { type: 'string' } },
				required: ['skill_id'],
				additionalProperties: false
			}
		}
	},
	argumentKeys: ['skill_id'],
	requiredAction: 'skills.read_own',
	run: async (args, context) => {
		const parsed = skillReadArgs.safeParse(args);
		if (!parsed.success) return { result: ACCESS_DENIED, denied: true };
		const skill = await withPrincipal(context.db, { id: context.principalId }, (tx) =>
			findSkill(tx, parsed.data.skill_id)
		);
		if (skill === null || skill.status !== 'active') return { result: ACCESS_DENIED, denied: true };
		return { result: { id: skill.id, content: toSkillMarkdown(skill) } };
	}
};

const skillProposeArgs = z.object({
	name: z.string().min(1).max(80),
	description: z.string().min(1).max(500),
	content: z.string().min(1).max(20_000)
});

// What the assistant learns becomes a proposal its owner approves before it is ever used
export const skillsProposeTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'skills_propose',
			description:
				'Propose a new skill from what you learned: a reusable way of doing something for this user. It waits for the user to approve it.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					description: { type: 'string', description: 'When to use it, in one sentence' },
					content: { type: 'string', description: 'The instructions, in Markdown' }
				},
				required: ['name', 'description', 'content'],
				additionalProperties: false
			}
		}
	},
	argumentKeys: ['name', 'description', 'content'],
	requiredAction: 'skills.read_own',
	run: async (args, context) => {
		const parsed = skillProposeArgs.safeParse(args);
		if (!parsed.success) return { result: { error: 'name, description and content are required' } };
		const skill = await withPrincipal(context.db, { id: context.principalId }, (tx) =>
			insertSkill(tx, {
				scope: 'user',
				owner: context.principalId,
				status: 'proposed',
				...parsed.data
			})
		);
		return { result: { proposed: skill.id, status: 'proposed' } };
	}
};
