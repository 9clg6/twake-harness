import { z } from 'zod';

import type { ConsentLevel } from '../consents/consent.js';
import type { Locale } from '../i18n/messages.js';

// One text per language, by its code, such as en or fr
export type Texts = Readonly<Record<string, string>>;

// How the catalog describes an application to the owners, at the root of the OpenAPI document:
// its name, and what reading and writing cover there when it says
export interface DomainDescription {
	readonly name: Texts;
	readonly read?: Texts | undefined;
	readonly write?: Texts | undefined;
}

export type DomainDescriptions = ReadonlyMap<string, DomainDescription>;

// An entry of the catalog left out for its shape, by its domain, or null when the whole extension
// is, with what is wrong in it for the operator who fixes the catalog
export interface IgnoredDescription {
	readonly domain: string | null;
	readonly problem: string;
}

export interface DescribedDomains {
	readonly descriptions: DomainDescriptions;
	readonly ignored: readonly IgnoredDescription[];
}

// What an owner reads of an application in a question about one level: its name, and what the
// level covers there when the catalog says
export interface DomainLabel {
	readonly name: string;
	readonly covers: string | null;
}

// A question shows these texts inside its own sentences, so each is one line of bounded length:
// nothing the catalog writes can add lines that read as the harness's own
function oneLine(max: number): z.ZodString {
	return z
		.string()
		.trim()
		.min(1)
		.max(max)
		.regex(/^[^\r\n]*$/, 'must be one line');
}

const coversSchema = z.record(z.string(), oneLine(200));

const descriptionSchema = z.object({
	name: z.record(z.string(), oneLine(64)),
	read: coversSchema.optional(),
	write: coversSchema.optional()
});

const documentSchema = z.object({ 'x-twake-domains': z.unknown().optional() });

function problemOf(error: z.ZodError): string {
	return error.issues
		.map((issue) =>
			issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`
		)
		.join('; ');
}

// Reads x-twake-domains from the document like any data from outside: an entry of another shape
// is left out on its own, so that one mistake costs one application its words and never the
// catalog. A document that describes nothing describes no application.
export function readDomains(document: unknown): DescribedDomains {
	const descriptions = new Map<string, DomainDescription>();
	const parsed = documentSchema.safeParse(document);
	const raw = parsed.success ? parsed.data['x-twake-domains'] : undefined;
	if (raw === undefined) return { descriptions, ignored: [] };
	const entries = z.record(z.string(), z.unknown()).safeParse(raw);
	if (!entries.success) {
		return { descriptions, ignored: [{ domain: null, problem: problemOf(entries.error) }] };
	}
	const ignored: IgnoredDescription[] = [];
	for (const [domain, entry] of Object.entries(entries.data)) {
		const description = descriptionSchema.safeParse(entry);
		if (description.success) descriptions.set(domain, description.data);
		else ignored.push({ domain, problem: problemOf(description.error) });
	}
	return { descriptions, ignored };
}

// The application as a question names it to an owner who reads `locale`: the name the catalog
// gives it in that language, and what the level covers there when it says. An application the
// catalog does not name in that language goes by its id, never by another language's words.
export function labelOf(
	descriptions: DomainDescriptions,
	domain: string,
	level: ConsentLevel,
	locale: Locale
): DomainLabel {
	const description = descriptions.get(domain);
	const name = description?.name[locale];
	if (description === undefined || name === undefined) return { name: domain, covers: null };
	return { name, covers: description[level]?.[locale] ?? null };
}
