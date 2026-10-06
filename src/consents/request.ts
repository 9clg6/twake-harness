import MarkdownIt from 'markdown-it';

import type { DomainLabel } from '../contracts/domains.js';
import type { Messages } from '../i18n/messages.js';
import type { ConsentLevel, WaitReason } from './consent.js';

// A call the harness froze, as its request to the owner tells of it
export interface RequestedCall {
	// The application as its owner reads it, from labelOf: its name, and what the call's level
	// covers there when the catalog says
	readonly application: DomainLabel;
	readonly level: ConsentLevel;
	// Every reason the call waits for, all answered by one yes
	readonly reasons: readonly WaitReason[];
	// The call as it was frozen, which may hold what a third party wrote
	readonly arguments: unknown;
	// What its contract said the call would do, from its preview, which its owner reads in place of
	// the call, and nothing else ever shows; null for a contract that offers none. It is that
	// application's data, which may hold what a third party wrote.
	readonly summary: string | null;
	// What the model wrote alongside the call, or null when it wrote nothing
	readonly said: string | null;
}

// The harness's request to an owner about a call it froze, in the parts their client shows apart,
// in this order. Only the question, the labels and how to answer are the harness's own words, and
// the parts stay apart wherever the request goes, so that the API can show the question without
// the call.
export interface OwnerRequest {
	// What the model wrote alongside the call, under the harness's label for it, or null when it
	// wrote nothing
	readonly said: { readonly label: string; readonly text: string } | null;
	// The harness's question, in Markdown: the application named as the catalog does
	readonly question: string;
	// The call as it was frozen, whole, as indented JSON: what its owner reads of it when its
	// contract offers no preview, and what the conversation keeps of it either way
	readonly call: string;
	// What its contract said the call would do, under the harness's label for it, in Markdown,
	// which names the application: what its owner reads in the call's place; null for a contract
	// that offers no preview
	readonly summary: { readonly label: string; readonly text: string } | null;
	readonly howToAnswer: string;
}

// The most a request quotes of what the model wrote: its words, never what runs
const SAID_LENGTH = 2_000;

// The most a call, or the summary shown in its place, may take in the message that shows it, as
// plain text and as HTML together: with the rest of the request, well within what one Matrix
// event carries
export const CALL_BYTES = 16_384;

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, 'utf8');
}

function linesOf(text: string): string[] {
	return text.split(/\r\n|[\n\r\u0085\u2028\u2029]/);
}

// The harness's question for the reasons a call waits for: a first use asks about the
// application; a high-risk write, or a write that a turn an event started prepared, about that
// very call; and the first of either in its application about both
function questionFor(call: RequestedCall, consent: Messages['consent']): string {
	const { name, covers } = call.application;
	const firstUse = call.reasons.includes('consent');
	// A high-risk write asks every time, whoever started the turn: its question also holds for one
	// that a turn an event started prepared
	if (call.reasons.includes('high_risk')) {
		return firstUse ? consent.firstHighRisk(name, covers) : consent.highRisk(name);
	}
	if (call.reasons.includes('event_turn')) {
		return firstUse ? consent.firstEventWrite(name, covers) : consent.eventWrite(name);
	}
	return call.level === 'read' ? consent.firstRead(name, covers) : consent.firstWrite(name, covers);
}

// The request about a frozen call, or null when the call, or its summary, is too large to show
// whole in one message: an owner is never asked about a call they cannot see whole
export function makeOwnerRequest(call: RequestedCall, messages: Messages): OwnerRequest | null {
	const frozen = JSON.stringify(call.arguments, null, 2) ?? 'null';
	const shown = call.summary ?? frozen;
	if (byteLength(shown) + byteLength(escapeHtml(shown)) > CALL_BYTES) return null;
	const { consent } = messages;
	const said = Array.from(call.said?.trim() ?? '');
	return {
		said:
			said.length === 0
				? null
				: {
						label: consent.said,
						text:
							said.length > SAID_LENGTH ? `${said.slice(0, SAID_LENGTH).join('')}…` : said.join('')
					},
		question: questionFor(call, consent),
		call: frozen,
		summary:
			call.summary === null
				? null
				: { label: consent.described(call.application.name), text: call.summary },
		howToAnswer: consent.howToAnswer
	};
}

// A text that is not the harness's, quoted line by line under the harness's label for it, so that
// none of its lines passes for the harness's own
function quoted(label: string, text: string): string {
	return [label, ...linesOf(text).map((line) => `> ${line}`.trimEnd())].join('\n');
}

// The request as plain text: the body of its message, and what the API answers. The model's
// words, and what an application said of the call, are quoted under the harness's labels.
export function requestText(request: OwnerRequest): string {
	const { said, summary } = request;
	return [
		...(said === null ? [] : [quoted(said.label, said.text)]),
		request.question,
		summary === null ? request.call : quoted(summary.label, summary.text),
		request.howToAnswer
	].join('\n\n');
}

// The request as the conversation keeps it, which later turns of the model read: the call as it
// was frozen, never what its application said of it. That is the application's data, which may
// hold what a third party wrote, and only its owner reads it.
export function conversationText(request: OwnerRequest): string {
	return requestText({ ...request, summary: null });
}

// The harness's own Markdown: no HTML of its own, and no link it did not write
const QUESTION_MARKDOWN = new MarkdownIt({ html: false, linkify: false, breaks: true });

// The request as HTML, laid out by the harness. The model's words are plain text in a quote under
// the harness's label, never rendered: no heading, table, image or link they hold can stand out
// against the question or its buttons. The call, or its contract's summary under the harness's
// label, is code, and only the question and that label are rendered, from the harness's own
// Markdown.
export function requestHtml(request: OwnerRequest): string {
	const { said, summary } = request;
	const quoted =
		said === null
			? []
			: [
					`<p>${escapeHtml(said.label)}</p>`,
					`<blockquote>${linesOf(said.text).map(escapeHtml).join('<br />')}</blockquote>`
				];
	return [
		...quoted,
		QUESTION_MARKDOWN.render(request.question).trim(),
		...(summary === null
			? [`<pre><code class="language-json">${escapeHtml(request.call)}</code></pre>`]
			: [
					QUESTION_MARKDOWN.render(summary.label).trim(),
					`<pre><code>${escapeHtml(summary.text)}</code></pre>`
				]),
		`<p>${escapeHtml(request.howToAnswer)}</p>`
	].join('\n');
}
