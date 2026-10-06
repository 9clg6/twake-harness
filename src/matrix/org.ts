import type { FastifyBaseLogger } from 'fastify';

import { saveAssistant } from '../assistants/repository.js';
import type { Config } from '../config.js';
import { getMessages } from '../i18n/messages.js';
import { withPrincipal, type Db } from '../db/client.js';
import { ORGANIZATION_PRINCIPAL } from '../principals/principal.js';
import { ensurePrincipal } from '../principals/repository.js';
import type { MatrixAdmin } from './admin.js';

export function orgAgentUserId(config: Config): string {
	return `@${config.org.localpart}:${config.matrix.serverName}`;
}

export function isOrgMember(config: Config, userId: string): boolean {
	return config.org.members.includes(userId);
}

export function orgGreeting(config: Config): string {
	return getMessages(config.locale).orgGreeting(config.org.name);
}

export interface OrgAgentDeps {
	readonly config: Config;
	readonly db: Db;
	readonly admin: MatrixAdmin;
	readonly log: FastifyBaseLogger;
}

// The organization agent exists as long as it is enabled: one Matrix user in the namespace of
// the application service, and one assistant record owned by the organization principal, whose
// memory and skills are the organization's and nobody else's.
export async function ensureOrgAgent(deps: OrgAgentDeps): Promise<string> {
	const { config, db, admin, log } = deps;
	const userId = orgAgentUserId(config);
	await admin.registerUser(config.org.localpart);
	const named = await admin.setDisplayName(userId, config.org.name);
	await withPrincipal(db, { id: ORGANIZATION_PRINCIPAL }, async (tx) => {
		await ensurePrincipal(tx, { id: ORGANIZATION_PRINCIPAL });
		await saveAssistant(tx, {
			owner: ORGANIZATION_PRINCIPAL,
			userId,
			name: config.org.name,
			roomId: null
		});
	});
	log.info({ userId, named, members: config.org.members.length }, 'organization agent ready');
	return userId;
}
