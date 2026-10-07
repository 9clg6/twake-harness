import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
	export interface ProvidedContext {
		// Where the first Synapse of the run generates the configuration every Synapse copies
		synapseConfigDir: string;
	}
}

// Global setup of the run: the folder of its Synapse configuration, removed once the run is over
export async function setup(project: TestProject): Promise<() => Promise<void>> {
	const dir = await mkdtemp(join(tmpdir(), 'synapse-config-'));
	project.provide('synapseConfigDir', dir);
	return () => rm(dir, { recursive: true, force: true });
}
