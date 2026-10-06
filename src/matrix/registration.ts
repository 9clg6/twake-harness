import type { IAppserviceRegistration } from 'matrix-bot-sdk';

import type { Config } from '../config.js';

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assistantUserRegex(config: Config): string {
	return `@${escapeRegex(config.matrix.assistantPrefix)}.*:${escapeRegex(config.matrix.serverName)}`;
}

// One namespace for the assistants and the creator: Synapse pushes the events of a room only
// when a member matches a namespace, and the creator must hear what it is told. The SDK accepts
// a single user namespace, hence the alternation.
function namespaceUserRegex(config: Config): string {
	const server = escapeRegex(config.matrix.serverName);
	return `@(?:${escapeRegex(config.matrix.assistantPrefix)}.*|${escapeRegex(config.matrix.senderLocalpart)}):${server}`;
}

// The registration Synapse loads: the harness owns the assistants' identifiers exclusively and
// asks for to-device messages and device masquerading so encryption works without a sync loop.
export function buildRegistration(config: Config, url: string): IAppserviceRegistration {
	const registration: IAppserviceRegistration = {
		id: config.matrix.appserviceId,
		as_token: config.matrix.asToken,
		hs_token: config.matrix.hsToken,
		url,
		sender_localpart: config.matrix.senderLocalpart,
		namespaces: {
			users: [{ exclusive: true, regex: namespaceUserRegex(config) }],
			rooms: [],
			aliases: []
		},
		rate_limited: false,
		'de.sorunome.msc2409.push_ephemeral': true
	};
	return registration;
}

// The file Synapse loads, with the flags the SDK's type does not know about
export function buildRegistrationFile(config: Config, url: string): Record<string, unknown> {
	return { ...buildRegistration(config, url), 'org.matrix.msc3202': true };
}

export function creatorUserId(config: Config): string {
	return `@${config.matrix.senderLocalpart}:${config.matrix.serverName}`;
}

// The assistant of the owner whose account on our homeserver has this localpart
export function assistantUserId(config: Config, ownerLocalpart: string): string {
	return `@${config.matrix.assistantPrefix}${ownerLocalpart}:${config.matrix.serverName}`;
}

export function isAssistantUserId(config: Config, userId: string): boolean {
	return new RegExp(`^${assistantUserRegex(config)}$`).test(userId);
}
