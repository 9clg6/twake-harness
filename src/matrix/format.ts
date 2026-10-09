import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

// A text message with its rendering, as Matrix clients show formatted messages
export interface RichText {
	readonly msgtype: 'm.text';
	readonly body: string;
	readonly format: 'org.matrix.custom.html';
	readonly formatted_body: string;
}

// The HTML a Matrix client may render (client-server API, m.room.message, org.matrix.custom.html)
const ALLOWED_TAGS: readonly string[] = [
	'font',
	'del',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'blockquote',
	'p',
	'a',
	'ul',
	'ol',
	'sup',
	'sub',
	'li',
	'b',
	'i',
	'u',
	'strong',
	'em',
	'strike',
	'code',
	'hr',
	'br',
	'div',
	'table',
	'thead',
	'tbody',
	'tr',
	'th',
	'td',
	'caption',
	'pre',
	'span',
	'img',
	'details',
	'summary'
];

// Raw HTML whose content is code, not text: it vanishes whole instead of showing
const DROPPED_TAGS: readonly string[] = [
	'script',
	'style',
	'iframe',
	'object',
	'embed',
	'noscript',
	'template',
	'svg',
	'math',
	'frame',
	'frameset',
	'applet'
];

const RECOGNISED_TAGS = new Set([...ALLOWED_TAGS, ...DROPPED_TAGS]);
const RAW_TAG = /<\/?([A-Za-z][A-Za-z0-9-]*)[^<>]*>/g;
const LINK_SCHEMES = /^(https?:|mailto:)/i;

const markdown = new MarkdownIt({ html: true, linkify: true, breaks: true });
// Only an address with a scheme becomes a link, and an e-mail address a mailto one: a file name
// whose extension is a domain, such as notes-demo.md, stays text. linkify-it 6 does so by default,
// whereas its version 5 linked any name that ends like a domain.
markdown.linkify.set({ fuzzyLink: false, fuzzyEmail: true });

// The model writes placeholders such as <name> far more often than HTML: a tag neither rendered nor
// dropped is shown as the text it is, instead of being parsed as an element and lost
function escapeUnrecognisedTags(html: string): string {
	return html.replace(RAW_TAG, (tag: string, name: string) =>
		RECOGNISED_TAGS.has(name.toLowerCase()) ? tag : markdown.utils.escapeHtml(tag)
	);
}
markdown.renderer.rules.html_inline = (tokens, idx) =>
	escapeUnrecognisedTags(tokens[idx]?.content ?? '');
markdown.renderer.rules.html_block = (tokens, idx) =>
	escapeUnrecognisedTags(tokens[idx]?.content ?? '');

// An answer comes from the model, which reads untrusted contract data: only the Matrix subset
// survives, links stay on the web or mail, and images only from the homeserver's media, so no
// answer can load a remote image (a tracking pixel) in the owner's client
const SANITIZE: sanitizeHtml.IOptions = {
	allowedTags: [...ALLOWED_TAGS],
	allowedAttributes: {
		font: ['data-mx-bg-color', 'data-mx-color', 'color'],
		span: ['data-mx-bg-color', 'data-mx-color', 'data-mx-spoiler', 'data-mx-maths'],
		div: ['data-mx-maths'],
		a: ['name', 'target', 'href'],
		img: ['width', 'height', 'alt', 'title', 'src'],
		ol: ['start'],
		code: ['class']
	},
	allowedClasses: { code: ['language-*'] },
	allowedSchemes: ['http', 'https', 'mailto'],
	allowedSchemesByTag: { img: ['mxc'] },
	allowedSchemesAppliedToAttributes: ['href', 'src'],
	allowProtocolRelative: false,
	nonTextTags: [...DROPPED_TAGS],
	transformTags: {
		// markdown-it writes strikethrough as <s>, which the Matrix subset spells <del>
		s: 'del',
		// A relative or scheme-less href leads nowhere in a chat client: the text stays, not the link
		a: (tagName: string, attribs: sanitizeHtml.Attributes) => {
			const { href, ...rest } = attribs;
			return {
				tagName,
				attribs: href !== undefined && LINK_SCHEMES.test(href.trim()) ? { ...rest, href } : rest
			};
		}
	},
	exclusiveFilter: (frame) => frame.tag === 'img' && !/^mxc:\/\//i.test(frame.attribs['src'] ?? '')
};

// A single paragraph needs no wrapper: clients would only add a margin around a one-liner
function unwrapSingleParagraph(html: string): string {
	const match = /^<p>([\s\S]*)<\/p>$/.exec(html);
	const inner = match?.[1];
	return inner !== undefined && !inner.includes('<p>') ? inner : html;
}

// The model's words as the harness quotes them in its own requests: their Markdown, without their
// HTML nor anything that acts. Twake Chat opens a link on a touch without asking, and the model may
// repeat what a received mail told it to write: a link shows its text alone, an address or an
// e-mail address stays text, and a heading is a paragraph. An image shows its description, as the
// client would fetch it, telling the server it comes from when its owner read the request.
const quotedMarkdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
quotedMarkdown.renderer.rules.link_open = () => '';
quotedMarkdown.renderer.rules.link_close = () => '';
quotedMarkdown.renderer.rules.image = (tokens, idx, options, env, renderer) =>
	quotedMarkdown.utils.escapeHtml(
		renderer.renderInlineAsText(tokens[idx]?.children ?? [], options, env)
	);
quotedMarkdown.renderer.rules.heading_open = () => '<p>';
quotedMarkdown.renderer.rules.heading_close = () => '</p>\n';

// The filter of the quote: an answer's, without links, images or headings, whose text stays
const QUOTED_SANITIZE: sanitizeHtml.IOptions = {
	...SANITIZE,
	allowedTags: ALLOWED_TAGS.filter((tag) => tag !== 'a' && tag !== 'img' && !/^h[1-6]$/.test(tag))
};

// The HTML the model's words take in a request of the harness: every tag of it closed within it,
// so that the quote the harness puts it in holds it whole
export function renderQuotedMarkdown(text: string): string {
	return unwrapSingleParagraph(sanitizeHtml(quotedMarkdown.render(text), QUOTED_SANITIZE).trim());
}

// A text as HTML shows it, word for word: what someone wrote never becomes markup
export function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A text the harness laid out itself, as plain text and as HTML, such as its request about a call:
// its HTML goes through the same filter as an answer's
export function makeLaidOutText(body: string, html: string): RichText {
	return {
		msgtype: 'm.text',
		body,
		format: 'org.matrix.custom.html',
		formatted_body: sanitizeHtml(html, SANITIZE).trim()
	};
}

// The HTML an answer's Markdown renders to, for Matrix clients
function renderMarkdown(text: string): string {
	return unwrapSingleParagraph(sanitizeHtml(markdown.render(text), SANITIZE).trim());
}

// The markdown stays the plain body, for clients that show no HTML and for notifications
export function makeRichText(text: string): RichText {
	return {
		msgtype: 'm.text',
		body: text,
		format: 'org.matrix.custom.html',
		formatted_body: renderMarkdown(text)
	};
}
