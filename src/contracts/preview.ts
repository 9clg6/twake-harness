import { z } from 'zod';

import { problemOf } from './domains.js';

// The header that asks a contract what a call would do, without doing it, and that its answer
// carries back to say it did only that; and the one that carries, on the call its owner allowed,
// the digest of the preview they were shown
export const PREVIEW_HEADER = 'x-twake-preview';
export const PREVIEW_DIGEST_HEADER = 'x-twake-preview-digest';

// What a contract says a call would do: words its owner reads in place of the call, and a digest
// of what the call would act on, which the contract checks again when the call runs
export interface Preview {
	readonly summary: string;
	readonly digest: string;
}

// Line feeds and tabs lay a summary out. Any other control character, and any format character,
// such as one that turns text right to left or one nobody sees, is no text to show an owner: it
// could make the summary read as something it does not say.
const UNSHOWN = /(?![\n\t])\p{Cc}|\p{Cf}/u;

// The digest goes back to the contract in a header: a short opaque token, of characters no header
// gives a meaning to
const DIGEST = /^[A-Za-z0-9+/=._:-]{1,256}$/;

const previewSchema = z.object({
	summary: z
		.string()
		.trim()
		.min(1)
		.refine(
			(text) => !UNSHOWN.test(text),
			'must hold no control or format character but line feeds and tabs'
		),
	digest: z.string().regex(DIGEST, 'must be 1 to 256 letters, digits or + / = . _ : -')
});

// A contract's answer to a preview: its status, 0 when none came; the preview header it carries
// back, if any; and its body
export interface PreviewAnswer {
	readonly status: number;
	readonly echoed: string | null;
	readonly body: unknown;
}

// What a contract's answer to a preview tells the harness
export type PreviewReading =
	// What the call would do, which the contract did not do
	| { readonly kind: 'preview'; readonly preview: Preview }
	// A success that is no preview: the contract did what the call asks, for all the harness knows,
	// as one that takes the preview header for nothing would
	| { readonly kind: 'acted'; readonly problem: string }
	// An error: the contract refused or failed the call
	| { readonly kind: 'refused'; readonly problem: string }
	// No answer, in time or at all: whether the contract did anything is unknown
	| { readonly kind: 'unanswered' };

// Reads a contract's answer to a preview as any data from outside. Only a 200 that carries the
// preview header back, with a summary and a digest, is a preview: any other success is taken for
// the call itself, done, so that a contract that ignores the header never passes for one that did
// nothing.
export function readPreview(answer: PreviewAnswer): PreviewReading {
	const { status } = answer;
	if (status === 0) return { kind: 'unanswered' };
	if (status < 200 || status > 299) return { kind: 'refused', problem: `status ${status}` };
	if (status !== 200) return { kind: 'acted', problem: `status ${status}` };
	if (answer.echoed !== 'true') {
		return { kind: 'acted', problem: `the answer does not carry ${PREVIEW_HEADER}: true` };
	}
	const parsed = previewSchema.safeParse(answer.body);
	return parsed.success
		? { kind: 'preview', preview: parsed.data }
		: { kind: 'acted', problem: problemOf(parsed.error) };
}
