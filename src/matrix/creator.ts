// What the creator user answers in a direct message. The create flow comes with the next ticket.
export const CREATOR_COMMANDS: readonly { readonly command: string; readonly help: string }[] = [
	{ command: '/newbot', help: 'create your assistant' },
	{ command: '/mybot', help: 'show your assistant' },
	{ command: '/rename <name>', help: 'rename your assistant' },
	{ command: '/delete', help: 'delete your assistant' },
	{ command: '/recover', help: 'recover the encryption keys of your assistant' },
	{ command: '/help', help: 'this list' }
];

export function helpText(): string {
	return [
		'I create and manage your Twake Space assistant. Commands:',
		...CREATOR_COMMANDS.map((c) => `${c.command}: ${c.help}`)
	].join('\n');
}

export type CreatorCommand =
	{ readonly kind: 'help' } | { readonly kind: 'unknown'; readonly text: string };

export function parseCreatorCommand(body: string): CreatorCommand {
	const text = body.trim();
	const word = text.split(/\s+/)[0]?.toLowerCase() ?? '';
	if (word === '/help' || word === 'help' || word === 'aide' || word === '/start')
		return { kind: 'help' };
	return { kind: 'unknown', text };
}
