import { z } from 'zod';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface ContractParameter {
	readonly name: string;
	readonly location: 'path' | 'query';
	readonly required: boolean;
	readonly schema: Record<string, unknown>;
	readonly description: string | null;
}

export interface ContractDefinition {
	// The contract id, the operationId of the OpenAPI, such as calendar.freebusy.read.v1
	readonly id: string;
	// The same, in the alphabet a model tool name allows
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
	paths: z.record(z.string(), z.record(z.string(), z.unknown()))
});

const METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

export function toToolName(contractId: string): string {
	return contractId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// Reads the curated OpenAPI APISIX serves and keeps one contract per operation that has an id.
// Operations without an id, and header or cookie parameters, are left out on purpose: a
// contract is called by its name and nothing travels in headers but what APISIX adds.
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
			contracts.push({
				id: operation.data.operationId,
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
