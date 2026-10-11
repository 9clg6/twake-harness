import { fetchOwnerMessages } from '../assistants/locale.js';
import type { Tool } from '../agent/tools.js';
import type { Config } from '../config.js';
import type { Tx } from '../db/client.js';

// The tool the question about sharing an invitee's availability with colleagues is frozen under,
// and the contract its frozen call carries: like a suggestion's question, it is no tool of the
// model's nor of the API's, and only the replay of its call runs it
export const AVAILABILITY_SHARING_TOOL = 'share_availability';
export const AVAILABILITY_SHARING_CALL = 'harness.share_availability';

// The refusal an invitee kept of the harness's question about sharing their availability with
// colleagues. While it stands, the harness asks them nothing more: the sharing is theirs to grant
// on the agreements page, and taking it back there keeps the refusal again. A yes to the question,
// and the owner's /delete, erase it.

// Whether the invitee refused the sharing, under their own principal
export async function hasRefusedAvailabilitySharing(tx: Tx, owner: string): Promise<boolean> {
	const rows = await tx.sql`
		select 1 from availability_sharing_refusals where owner = ${owner} limit 1`;
	return rows.length > 0;
}

// Keeps the invitee's refusal, once: a refusal already kept stays as it was
export async function refuseAvailabilitySharing(tx: Tx, owner: string): Promise<void> {
	await tx.sql`
		insert into availability_sharing_refusals (owner) values (${owner})
		on conflict (owner) do nothing`;
}

// The invitee let their assistant share their availability, took that sharing back, or their
// assistant was erased: the refusal, if any, goes
export async function clearAvailabilitySharingRefusal(tx: Tx, owner: string): Promise<void> {
	await tx.sql`delete from availability_sharing_refusals where owner = ${owner}`;
}

// What the invitee's yes to the question runs, once it let their assistant share their availability:
// the words that end their turn. It is no tool of the model's nor of the API's, which never find it:
// the replay of the call frozen as AVAILABILITY_SHARING_CALL alone runs it.
export function makeAvailabilitySharingTool(deps: { readonly config: Config }): Tool {
	return {
		definition: {
			type: 'function',
			function: {
				name: AVAILABILITY_SHARING_TOOL,
				description: "Lets the colleague's request go on with the invitee's free slots.",
				parameters: { type: 'object', properties: {}, additionalProperties: false }
			}
		},
		argumentKeys: [],
		requiredAction: null,
		frozenAs: AVAILABILITY_SHARING_CALL,
		run: async (_args, context) => {
			const { suggestions } = await fetchOwnerMessages(
				context.db,
				context.principalId,
				deps.config.locale
			);
			return { result: { success: true }, final: suggestions.availabilitySharing.granted };
		}
	};
}
