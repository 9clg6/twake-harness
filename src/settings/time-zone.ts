import type { TimeZone } from '../agent/clock.js';
import { withPrincipal, type Db } from '../db/client.js';
import { findOwnerTimeZone } from './repository.js';

// The zone an owner's turns state the present in, as it is now: the one of their calendar, once a
// read of it named one, or else the deployment's
export async function fetchOwnerTimeZone(
	db: Db,
	owner: string,
	fallback: TimeZone
): Promise<TimeZone> {
	const zone = await withPrincipal(db, { id: owner }, (tx) => findOwnerTimeZone(tx, owner));
	return zone ?? fallback;
}
