import { getMessages, LOCALES } from '../i18n/messages.js';
import { ALLOW_REACTION, REFUSE_REACTION } from './consent.js';

export type Answer = 'yes' | 'no';

// How an owner answered: with a reaction on the request, or in words
export type AnswerKind = 'reaction' | 'words';

// An owner may answer in any language the harness speaks, whatever language it asked in
const CATALOGS = LOCALES.map((locale) => getMessages(locale).consent);

const YES_REACTIONS = new Set([ALLOW_REACTION, ...CATALOGS.map((c) => c.buttons.yes)]);
const NO_REACTIONS = new Set([REFUSE_REACTION, ...CATALOGS.map((c) => c.buttons.no)]);
const YES_WORDS = new Set(CATALOGS.map((c) => c.yes));
const NO_WORDS = new Set(CATALOGS.map((c) => c.no));

// A reaction on a question: one of its buttons, or a bare ✅ or ❌
export function reactionAnswer(key: string): Answer | null {
	if (YES_REACTIONS.has(key)) return 'yes';
	if (NO_REACTIONS.has(key)) return 'no';
	return null;
}

// A message that is exactly yes or no, whatever its case and the punctuation that ends it
export function wordAnswer(text: string): Answer | null {
	const word = text
		.trim()
		.toLowerCase()
		.replace(/[\s.!…]+$/u, '');
	if (YES_WORDS.has(word)) return 'yes';
	if (NO_WORDS.has(word)) return 'no';
	return null;
}
