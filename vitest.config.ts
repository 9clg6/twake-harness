import { readFile } from 'node:fs/promises';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// What a test file costs, roughly: each Synapse it starts, with a matrix role, weighs about ten
// files that drive the API alone
async function weightOf(file: TestSpecification): Promise<number> {
	const source = await readFile(file.moduleId, 'utf8');
	return 1 + 10 * (source.match(/startMatrixHarness\(|startConsentRoom\(/g)?.length ?? 0);
}

// Vitest gives each shard as many files as the next, picked by a hash of their path, so the slowest
// can land in the same shard. Here the files go, the heaviest first, each to the shard that weighs
// least so far: every shard makes the same split and runs its own part of it.
class BalancedShards extends BaseSequencer {
	override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
		const shard = this.ctx.config.shard;
		if (shard === undefined) return files;
		const weighted = await Promise.all(
			files.map(async (file) => ({ file, weight: await weightOf(file) }))
		);
		weighted.sort((a, b) => b.weight - a.weight || (a.file.moduleId < b.file.moduleId ? -1 : 1));
		const loads = Array.from({ length: shard.count }, () => 0);
		const mine: TestSpecification[] = [];
		for (const { file, weight } of weighted) {
			const lightest = loads.indexOf(Math.min(...loads));
			loads[lightest] = (loads[lightest] ?? 0) + weight;
			if (lightest === shard.index - 1) mine.push(file);
		}
		return mine;
	}
}

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		fileParallelism: false,
		sequence: { sequencer: BalancedShards },
		testTimeout: 120_000,
		hookTimeout: 60_000
	}
});
