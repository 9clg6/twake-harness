import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '../config.js';

// What Twake Space shows its user in its notifications: the proposal, with the id of the call that
// one click on a button of it answers
export interface SpaceSuggestion {
	readonly matrixUserId: string;
	// The pending call's id, so that a suggestion is created once
	readonly externalId: string;
	// The proposal sentence, at most 500 characters
	readonly text: string;
	readonly pendingCallId: string;
	// The channel the suggestion comes from
	readonly matrixRoomId: string;
}

export type SpaceOutcome = 'created' | 'off' | 'failed';

export interface SpaceNotifications {
	suggest(suggestion: SpaceSuggestion): Promise<SpaceOutcome>;
}

export interface SpaceNotificationsOptions {
	readonly apiUrl: URL;
	// A tws_ API token with the scope notifications:write
	readonly apiToken: string;
	readonly log: FastifyBaseLogger;
	readonly fetchImpl?: typeof fetch;
	readonly timeoutMs?: number;
}

export const MAX_SUGGESTION_TEXT = 500;

// Posts a suggestion to Twake Space. A 200 with a null id means the user turned suggestions off in
// Space: nothing was created, and that is no failure. Failures are logged with a status, never
// with the text.
export function makeSpaceNotifications(options: SpaceNotificationsOptions): SpaceNotifications {
	const fetchImpl = options.fetchImpl ?? fetch;
	const base = options.apiUrl.href.endsWith('/') ? options.apiUrl.href : `${options.apiUrl.href}/`;
	const url = new URL('notifications/suggestions', base);
	return {
		async suggest(suggestion) {
			const { pendingCallId } = suggestion;
			try {
				const response = await fetchImpl(url, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						authorization: `Bearer ${options.apiToken}`
					},
					body: JSON.stringify({
						...suggestion,
						text: suggestion.text.slice(0, MAX_SUGGESTION_TEXT)
					}),
					signal: AbortSignal.timeout(options.timeoutMs ?? 10_000)
				});
				if (response.status === 201) return 'created';
				if (response.status === 200) {
					const body: unknown = await response.json().catch(() => null);
					const off = typeof body === 'object' && body !== null && Reflect.get(body, 'id') === null;
					return off ? 'off' : 'created';
				}
				// 404 unknown_user: another organization or homeserver; 403: not an API token
				options.log.warn({ pendingCallId, status: response.status }, 'space suggestion refused');
				return 'failed';
			} catch (err: unknown) {
				options.log.warn(
					{ pendingCallId, reason: err instanceof Error ? err.name : 'error' },
					'space suggestion not sent'
				);
				return 'failed';
			}
		}
	};
}

// Twake Space's notifications as the deployment sets them, or null: with no SPACE_API_URL, a
// suggestion reaches the assistant's room alone
export function spaceFromConfig(config: Config, log: FastifyBaseLogger): SpaceNotifications | null {
	const { space } = config.suggestions;
	return space === null
		? null
		: makeSpaceNotifications({ apiUrl: space.apiUrl, apiToken: space.apiToken, log });
}
