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

// The HTML an answer's Markdown renders to, for Matrix clients: its tags all closed within it, so
// that a container the harness puts it in holds it whole
export function renderMarkdown(text: string): string {
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
