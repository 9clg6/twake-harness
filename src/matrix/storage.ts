import type { IAppserviceStorageProvider } from 'matrix-bot-sdk';

import type { Db } from '../db/client.js';

// The appservice state lives in PostgreSQL so that a transaction delivered twice, to one replica
// or to another, is processed once.
export function makeAppserviceStorage(db: Db): IAppserviceStorageProvider {
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
		}
	};
}
