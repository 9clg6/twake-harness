import type { ContractDefinition } from './openapi.js';
import type { PreviewAnswer } from './preview.js';
import { problemCode } from './problem.js';

// Whether the call answers the invitation for the whole series, as the model may write it of its
// own accord: only its owner's yes to that lets it
export function answersWholeSeries(
	contract: ContractDefinition,
	values: Record<string, unknown>
): boolean {
	const body = values['body'];
	return (
		contract.takesSeries &&
		typeof body === 'object' &&
		body !== null &&
		'series' in body &&
		body.series === true
	);
}

// A calendar contract answers an invitation that repeats, or whose copy holds several occurrences
// of a series, only for the whole series, once its owner said so: it refuses a call that does not
// say so with a 409 whose RFC 9457 problem says why in its code, and writes nothing. A copy of one
// occurrence alone it answers as an event, and a cancelled invitation it refuses before that, with
// a code of its own. Whether it refused the call so, and can be told to answer for the whole
// series: not a contract whose body does not take series, nor a call for the whole series
// already, whose refusal the model reads as data.
export function refusedOneOccurrence(
	contract: ContractDefinition,
	values: Record<string, unknown>,
	answer: Pick<PreviewAnswer, 'status' | 'body'>
): boolean {
	return (
		contract.takesSeries &&
		!answersWholeSeries(contract, values) &&
		answer.status === 409 &&
		problemCode(answer.body) === 'recurring_invitation'
	);
}

// The call again for every occurrence of the series, which only its owner's yes runs
export function wholeSeriesValues(values: Record<string, unknown>): Record<string, unknown> {
	const body = values['body'];
	const fields = typeof body === 'object' && body !== null ? body : {};
	return { ...values, body: { ...fields, series: true } };
}
