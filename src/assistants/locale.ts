import { withPrincipal, type Db } from '../db/client.js';
import { getMessages, type Locale, type Messages } from '../i18n/messages.js';
import { findAssistant, type AssistantRecord } from './repository.js';

// The language an owner reads: the one they chose for their assistant, or else the deployment's
export function localeOf(assistant: AssistantRecord | null, fallback: Locale): Locale {
	return assistant?.locale ?? fallback;
}

// The language an owner reads as it is now
export async function fetchOwnerLocale(db: Db, owner: string, fallback: Locale): Promise<Locale> {
	const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
	return localeOf(assistant, fallback);
}

// The fixed texts an owner reads, in their language as it is now
export async function fetchOwnerMessages(
	db: Db,
	owner: string,
	fallback: Locale
): Promise<Messages> {
	return getMessages(await fetchOwnerLocale(db, owner, fallback));
}
