import { expect } from 'vitest';

import type { TestClient } from './client.js';

// The service client ToM gets its tokens as
export const PROVISIONER = 'tom-bots';

// What the provisioner hands the owner's client once the assistant is ready
export interface ProvisionedAssistant {
	readonly userId: string;
	readonly deviceId: string;
	readonly masterKey: string;
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
