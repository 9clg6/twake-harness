import { defineConfig } from 'vitest/config';

// The replay against a deployed harness: no database, no containers, two users' tokens
export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/dev/**/*.dev.ts'],
		fileParallelism: false,
		testTimeout: 120_000,
		hookTimeout: 60_000
	}
});
