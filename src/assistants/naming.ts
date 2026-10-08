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

// The default names an assistant had before it took its owner's first name: « Assistant », then
// the owner's whole Matrix name, or their localpart, in either language, cut as they were
export function formerDefaultNames(owner: Namesake): string[] {
	const names = owner.name === null ? [owner.localpart] : [owner.name, owner.localpart];
	const fromOwner = LOCALES.flatMap((locale) =>
		names.map((name) =>
			getMessages(locale).formerDefaultAssistantName(name).slice(0, MAX_NAME_LENGTH)
		)
	);
	return [FORMER_DEFAULT_NAME, ...fromOwner];
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
