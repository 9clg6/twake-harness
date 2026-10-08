import { expect } from 'vitest';

import type { TestClient } from './client.js';
import type { MatrixUser, TestSynapse } from './synapse.js';

// The service client ToM gets its tokens as
export const PROVISIONER = 'tom-bots';

// What the provisioner hands the owner's client once the assistant is ready
export interface ProvisionedAssistant {
	readonly userId: string;
	readonly deviceId: string;
	readonly masterKey: string;
}

// The assistant as its owner reads it
export interface OwnedAssistant {
	readonly userId: string;
	readonly name: string;
	readonly roomId: string | null;
}

// The owner's assistant on the provisioning API, the owner named by their Matrix identifier
export function provisioningPath(owner: string): string {
	return `/v1/provisioning/assistants/${encodeURIComponent(owner)}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The owner's assistant once the provisioner's call answers with it, asked again after each 503 as
// ToM tells the owner's client to; any other answer fails at once
export async function provisionUntilReady(
	api: TestClient,
	owner: string
): Promise<ProvisionedAssistant> {
	for (let i = 0; i < 120; i += 1) {
		const res = await api.put<ProvisionedAssistant>(PROVISIONER, provisioningPath(owner), {});
		if (res.status === 200) return res.body;
		expect(res.status).toBe(503);
		await sleep(250);
	}
	throw new Error(`the assistant of ${owner} never became ready`);
}

// A new user of the homeserver under the Matrix name given, with the assistant a provisioner asks
// for them, ready or not, as they read it themselves
export async function provisioned(
	harness: { readonly synapse: TestSynapse; readonly api: TestClient },
	localpart: string,
	displayName: string
): Promise<{ owner: MatrixUser; assistant: OwnedAssistant }> {
	const owner = await harness.synapse.registerUser(localpart, displayName);
	const asked = await harness.api.put(PROVISIONER, provisioningPath(owner.userId), {});
	expect([200, 503]).toContain(asked.status);
	const mine = await harness.api.get<OwnedAssistant>(
		`${localpart}@test.local`,
		'/v1/assistants/me'
	);
	expect(mine.status).toBe(200);
	return { owner, assistant: mine.body };
}
