import { z } from 'zod';

import type { ConsentLevel } from '../consents/consent.js';
import { LOCALES, type Locale } from '../i18n/messages.js';

// One text per language the harness speaks, by its code, such as en or fr
export type Texts = Readonly<Partial<Record<Locale, string>>>;

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
// level covers there when the catalog says, both escaped for the Markdown the question is
export interface DomainLabel {
	readonly name: string;
	readonly covers: string | null;
}

// A question is the harness's own text, which the chat renders as Markdown with HTML
// (makeRichText): what the catalog writes there must read as plain words on one line. These are
// what would read as anything else: a line or paragraph break, or any control character; a
// character Markdown or HTML gives a meaning to in the middle of a line; and anything that looks
// like a link, an address or a domain name, which a chat client may also link on its own.
const BREAK = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const MARKUP = /[\\`*_~[\]<>&]/;
const LINK = /[a-z][a-z0-9+.-]*:\S|\S@\S|[\p{L}\p{N}]\.[\p{L}\p{N}]/iu;

function plainWords(max: number): z.ZodString {
	return z
		.string()
		.trim()
		.min(1)
		.max(max)
		.refine((text) => !BREAK.test(text), 'must be one line, without control characters')
		.refine((text) => !MARKUP.test(text), 'must hold no markup character')
		.refine((text) => !LINK.test(text), 'must hold no link, address or domain name');
}

// What goes into a question is escaped once more, should anything get past the parse. An
// underscore inside a word is never emphasis, so a domain's id such as search_emails stays as it
// is written.
function escaped(text: string): string {
	return text
		.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
		.replace(/[\\`*~[\]<>&]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, (markup) => `\\${markup}`);
}

// An entry holds what the README says and nothing else: a key it does not know, such as a
// misspelt level or a language the harness does not speak, is a mistake to warn about rather
// than words to drop in silence
const nameSchema = z.partialRecord(z.enum(LOCALES), plainWords(64));
const coversSchema = z.partialRecord(z.enum(LOCALES), plainWords(200));

const descriptionSchema = z.strictObject({
	name: nameSchema,
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
	if (description === undefined || name === undefined)
		return { name: escaped(domain), covers: null };
	const covers = description[level]?.[locale];
	return { name: escaped(name), covers: covers === undefined ? null : escaped(covers) };
}
