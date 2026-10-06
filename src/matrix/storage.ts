import type { IAppserviceStorageProvider, IFilterInfo, IStorageProvider } from 'matrix-bot-sdk';

import type { Db } from '../db/client.js';

// The appservice state lives in PostgreSQL so that a transaction delivered twice, to one replica
// or to another, is processed once, and what the SDK keeps per virtual user survives a restart.
export function makeAppserviceStorage(db: Db): IAppserviceStorageProvider {
	async function readFor(userId: string, key: string): Promise<string | null> {
		const rows = await db.sql<{ value: string }[]>`
			select value from matrix_user_storage where user_id = ${userId} and key = ${key}`;
		return rows[0]?.value ?? null;
	}
	async function storeFor(userId: string, key: string, value: string): Promise<void> {
		await db.sql`
			insert into matrix_user_storage (user_id, key, value) values (${userId}, ${key}, ${value})
			on conflict (user_id, key) do update set value = excluded.value`;
	}
	function storageForUser(userId: string): IStorageProvider {
		return {
			readValue: async (key: string): Promise<string | null | undefined> => readFor(userId, key),
			storeValue: async (key: string, value: string): Promise<void> => storeFor(userId, key, value),
			// The virtual users never sync, so these are stored for completeness only
			setSyncToken: async (token: string | null): Promise<void> => {
				if (token !== null) await storeFor(userId, 'syncToken', token);
			},
			getSyncToken: async (): Promise<string | null> => readFor(userId, 'syncToken'),
			setFilter: async (filter: unknown): Promise<void> => {
				await storeFor(userId, 'filter', JSON.stringify(filter));
			},
			getFilter: async (): Promise<IFilterInfo> => {
				const raw = await readFor(userId, 'filter');
				return raw === null ? { id: 0, filter: {} } : (JSON.parse(raw) as IFilterInfo);
			}
		};
	}
	return {
		addRegisteredUser: async (userId: string): Promise<void> => {
			await db.sql`insert into matrix_registered_users (user_id) values (${userId}) on conflict do nothing`;
		},
		isUserRegistered: async (userId: string): Promise<boolean> => {
			const rows = await db.sql`select 1 from matrix_registered_users where user_id = ${userId}`;
			return rows.length === 1;
		},
		setTransactionCompleted: async (transactionId: string): Promise<void> => {
			await db.sql`insert into matrix_transactions (id) values (${transactionId}) on conflict do nothing`;
		},
		isTransactionCompleted: async (transactionId: string): Promise<boolean> => {
			const rows = await db.sql`select 1 from matrix_transactions where id = ${transactionId}`;
			return rows.length === 1;
		},
		storageForUser
	};
}
