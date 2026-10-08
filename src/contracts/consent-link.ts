// The token broker's consent link bound to the owner it is for, named as the gateway names them
// to the broker (x-twake-on-behalf-of): the broker then spares an owner already signed in its
// forced re-login, and keeps a consent only from that very account. The link is always the
// deployment's own, never one an answer carries, a contract's or the broker's; its query and
// fragment stay, and an owner it already names is replaced.
export function makeOwnerConsentLink(link: string, owner: string): string {
	const url = new URL(link);
	url.searchParams.set('owner', owner);
	return url.toString();
}

// The same for a deployment that may give no link: none to bind, none to show
export function makeOptionalOwnerConsentLink(link: string | null, owner: string): string | null {
	return link === null ? null : makeOwnerConsentLink(link, owner);
}
