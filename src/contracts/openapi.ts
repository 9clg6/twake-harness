import { z } from 'zod';

import type { ConsentLevel } from '../consents/consent.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface ContractParameter {
	readonly name: string;
	readonly location: 'path' | 'query';
	readonly required: boolean;
	readonly schema: Record<string, unknown>;
	readonly description: string | null;
}

export interface ContractDefinition {
	// The versioned contract, such as calendar.freebusy.read.v1: the first tag of the operation,
	// or its operationId when it has no tag
	readonly id: string;
	// The application the contract belongs to, the first segment of its id, such as calendar:
	// what its owner allows the assistant to use, together with the level
	readonly domain: string;
	readonly level: ConsentLevel;
	// What the model calls: the operationId, a verb such as read_freebusy, in the alphabet a model
	// tool name allows
	readonly toolName: string;
	readonly method: HttpMethod;
	readonly pathTemplate: string;
	readonly description: string;
	readonly parameters: readonly ContractParameter[];
	readonly bodySchema: Record<string, unknown> | null;
}

const parameterSchema = z.object({
	name: z.string().min(1),
	in: z.enum(['path', 'query', 'header', 'cookie']),
	required: z.boolean().optional(),
	description: z.string().optional(),
	schema: z.record(z.string(), z.unknown()).optional()
});

const operationSchema = z.object({
	operationId: z.string().min(1).optional(),
	tags: z.array(z.string()).optional(),
	summary: z.string().optional(),
	description: z.string().optional(),
	parameters: z.array(parameterSchema).optional(),
	requestBody: z
		.object({
			content: z.record(
				z.string(),
				z.object({ schema: z.record(z.string(), z.unknown()).optional() })
			)
		})
		.optional()
});

const documentSchema = z.object({
	openapi: z.string().optional(),
	servers: z.array(z.object({ url: z.string() })).optional(),
	paths: z.record(z.string(), z.record(z.string(), z.unknown()))
});

// Where the document says its operations live: the path its first server names, which the calls
// join under the gateway's address, and the origin that server names when it is an absolute URL.
// Without a server, OpenAPI puts the operations at the root, so the paths are used as written.
export interface ContractServer {
	readonly path: string;
	readonly origin: string | null;
}

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

export function readServer(document: unknown): ContractServer {
	const parsed = documentSchema.safeParse(document);
	const url = parsed.success ? parsed.data.servers?.[0]?.url : undefined;
	if (url === undefined || url.length === 0) return { path: '', origin: null };
	if (ABSOLUTE_URL.test(url)) {
		const absolute = new URL(url);
		return { path: absolute.pathname, origin: absolute.origin };
	}
	return { path: url.replace(/^\.\//, ''), origin: null };
}

const METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

export function toToolName(operationId: string): string {
	return operationId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// Reads the curated OpenAPI APISIX serves and keeps one contract per operation that has an id.
// Operations without an id, and header or cookie parameters, are left out on purpose: a
// contract is called by its name and nothing travels in headers but what APISIX adds. The
// contracts service names each operation with a verb (operationId) and the versioned contract it
// belongs to with its first tag; the model sees the verb, everything else names the contract.
export function parseContracts(document: unknown): ContractDefinition[] {
	const parsed = documentSchema.safeParse(document);
	if (!parsed.success) throw new Error('the OpenAPI document has an unexpected shape');
	const contracts: ContractDefinition[] = [];
	for (const [pathTemplate, item] of Object.entries(parsed.data.paths)) {
		for (const method of METHODS) {
			const raw = item[method];
			if (raw === undefined) continue;
			const operation = operationSchema.safeParse(raw);
			if (!operation.success || operation.data.operationId === undefined) continue;
			const parameters: ContractParameter[] = (operation.data.parameters ?? [])
				.filter((p) => p.in === 'path' || p.in === 'query')
				.map((p) => ({
					name: p.name,
					location: p.in === 'path' ? 'path' : 'query',
					required: p.in === 'path' ? true : (p.required ?? false),
					schema: p.schema ?? { type: 'string' },
					description: p.description ?? null
				}));
			const body = operation.data.requestBody?.content['application/json']?.schema ?? null;
			const contractName = operation.data.tags?.find((tag) => tag.length > 0);
			const id = contractName ?? operation.data.operationId;
			contracts.push({
				id,
				domain: id.split('.')[0] ?? id,
				// A GET reads; every other method writes
				level: method === 'get' ? 'read' : 'write',
				toolName: toToolName(operation.data.operationId),
				method,
				pathTemplate,
				description:
					operation.data.description ?? operation.data.summary ?? operation.data.operationId,
				parameters,
				bodySchema: body
			});
		}
	}
	return contracts;
}

// The JSON schema the model sees: one property per path or query parameter, plus `body`
export function toolParametersOf(contract: ContractDefinition): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const parameter of contract.parameters) {
		properties[parameter.name] =
			parameter.description === null
				? parameter.schema
				: { ...parameter.schema, description: parameter.description };
		if (parameter.required) required.push(parameter.name);
	}
	if (contract.bodySchema !== null) {
		properties['body'] = contract.bodySchema;
		required.push('body');
	}
	return { type: 'object', properties, required, additionalProperties: false };
}
