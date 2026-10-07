import { getMessages, LOCALES } from '../i18n/messages.js';
import { ALLOW_REACTION, REFUSE_REACTION } from './consent.js';

export type Answer = 'yes' | 'no';

// How an owner answered: with a reaction on the request or in words, in the chat, or through the
// API
export type AnswerKind = 'reaction' | 'words' | 'api';

// An owner may answer in any language the harness speaks, whatever language it asked in
const CATALOGS = LOCALES.map((locale) => getMessages(locale).consent);

const YES_WORDS = new Set(CATALOGS.map((c) => c.yes));
const NO_WORDS = new Set(CATALOGS.map((c) => c.no));

// A reaction on a question, a bare ✅ or ❌, from a client that encrypts its reactions
export function reactionAnswer(key: string): Answer | null {
	if (key === ALLOW_REACTION) return 'yes';
	if (key === REFUSE_REACTION) return 'no';
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
