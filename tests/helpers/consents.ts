import type { ConsentLevel } from '../../src/consents/consent.js';
import { grantConsent as grant } from '../../src/consents/repository.js';
import { withPrincipal, type Db } from '../../src/db/client.js';

// Lets an owner's assistant use an application without asking, as the owner's consent would:
// for suites whose subject is not the consent itself
export async function grantConsent(
	db: Db,
	owner: string,
	domain: string,
	level: ConsentLevel
): Promise<void> {
	await withPrincipal(db, { id: owner }, (tx) => grant(tx, owner, domain, level, 'api'));
}

// Takes an application back from an owner's assistant, for a suite that needs a first use again
export async function withdrawConsent(
	db: Db,
	owner: string,
	domain: string,
	level: ConsentLevel
): Promise<void> {
	await withPrincipal(
		db,
		{ id: owner },
		(tx) =>
			tx.sql`delete from consents where owner = ${owner} and domain = ${domain} and level = ${level}`
	);
}
