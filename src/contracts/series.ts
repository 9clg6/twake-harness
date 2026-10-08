import type { ContractDefinition } from './openapi.js';

// A calendar contract answers a recurring invitation, or one occurrence of a series, only for the
// whole series, once its owner said so: it refuses a call that does not say so with a 409 whose
// RFC 9457 problem says why in its code, and writes nothing
function refusesOneOccurrence(answer: {
	readonly status: number;
	readonly body: unknown;
}): boolean {
	const { status, body } = answer;
	return (
		status === 409 &&
		typeof body === 'object' &&
		body !== null &&
		'code' in body &&
		body.code === 'recurring_invitation'
	);
}

// Whether a call to the contract can say it answers for the whole series: its body takes series,
// as the catalog shows it. One that cannot refuses a recurring invitation all the same.
function takesSeries(contract: ContractDefinition): boolean {
	const properties = contract.bodySchema?.['properties'];
	return typeof properties === 'object' && properties !== null && 'series' in properties;
}

// The call again for every occurrence of the series, which its owner's yes runs, when its contract
// refused it for one and can be told so; null for any other answer, for a contract that cannot be
// told so, and for a call for the whole series already that its contract refused all the same,
// which the model reads as data
export function forWholeSeries(
	contract: ContractDefinition,
	values: Record<string, unknown>,
	answer: { readonly status: number; readonly body: unknown }
): Record<string, unknown> | null {
	const body = values['body'];
	const fields = typeof body === 'object' && body !== null ? body : {};
	if (
		!takesSeries(contract) ||
		!refusesOneOccurrence(answer) ||
		('series' in fields && fields.series === true)
	) {
		return null;
	}
	return { ...values, body: { ...fields, series: true } };
}
