import type { ConsentLevel } from '../../src/consents/repository.js';
import { withPrincipal, type Db } from '../../src/db/client.js';

// Lets an owner's assistant use an application without asking, as the owner's consent would:
// for suites whose subject is not the consent itself
export async function grantConsent(
	db: Db,
	owner: string,
	domain: string,
	level: ConsentLevel
): Promise<void> {
	await withPrincipal(
		db,
		{ id: owner },
		(tx) => tx.sql`
			insert into consents (owner, domain, level, granted_by)
			values (${owner}, ${domain}, ${level}, 'api')
			on conflict do nothing`
	);
}
