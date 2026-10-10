import type { Db, Tx } from '../db/client.js';
import { getMessages, LOCALES, type Messages } from '../i18n/messages.js';
import { enqueueJobDroppingFailed } from '../jobs/queue.js';

// The longest name of an assistant, in characters
const MAX_NAME_LENGTH = 64;
const NAME = /^[^\p{C}]+$/u;

// The name every provisioned assistant had before it took its owner's
const FORMER_DEFAULT_NAME = 'Assistant';

export function isValidAssistantName(name: string): boolean {
	const trimmed = name.trim();
	return NAME.test(trimmed) && [...trimmed].length <= MAX_NAME_LENGTH;
}

// The first characters of a name, as many as the name of an assistant holds, none cut in half
function shortened(name: string): string {
	return [...name].slice(0, MAX_NAME_LENGTH).join('').trim();
}

// The owner an assistant is named after: their Matrix name, null when they have none, and their
// localpart
export interface Namesake {
	readonly name: string | null;
	readonly localpart: string;
}

// « Assistant de <first name> », after the owner's Matrix name; after their localpart when they
// have none, or when the name it gives could not be an assistant's
export function defaultNameFor(messages: Messages, owner: Namesake): string {
	const fromName =
		owner.name === null ? null : shortened(messages.defaultAssistantName(owner.name));
	return fromName !== null && isValidAssistantName(fromName)
		? fromName
		: shortened(messages.defaultAssistantName(owner.localpart));
}

// The default name an assistant had after a whole name before it took its owner's first name, cut
// as it was
function formerDefaultNameAfter(messages: Messages, name: string): string {
	return messages.formerDefaultAssistantName(name).slice(0, MAX_NAME_LENGTH);
}

// The names an assistant took from its owner's localpart, as it does when the homeserver gives the
// owner no other name, or their identifier for one, in either language: the default name of today
// and the one before it
export function namesAfterLocalpart(localpart: string): string[] {
	return LOCALES.flatMap((locale) => {
		const messages = getMessages(locale);
		return [
			defaultNameFor(messages, { name: null, localpart }),
			formerDefaultNameAfter(messages, localpart)
		];
	});
}

// The default names an assistant had before it took its owner's first name: « Assistant », the
// owner's whole Matrix name, in either language, or a name after their localpart
export function formerDefaultNames(owner: Namesake): string[] {
	const { name } = owner;
	const fromName =
		name === null ? [] : LOCALES.map((locale) => formerDefaultNameAfter(getMessages(locale), name));
	return [FORMER_DEFAULT_NAME, ...fromName, ...namesAfterLocalpart(owner.localpart)];
}

// Asks the matrix role to show the owner's assistant under its name: the job reads the name when it
// runs, so the last name set wins, and the jobs of one owner run one at a time. With
// renameIfFormerDefault, an assistant still under a former default name takes its owner's first
// name first.
export async function requestNaming(
	db: Db | Tx,
	owner: string,
	options: { readonly renameIfFormerDefault?: boolean } = {}
): Promise<void> {
	const payload =
		options.renameIfFormerDefault === true ? { owner, renameIfFormerDefault: true } : { owner };
	await enqueueJobDroppingFailed(db, { kind: 'name', payload, groupKey: `name:${owner}` });
}
