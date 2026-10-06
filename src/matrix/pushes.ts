import type { FastifyBaseLogger } from 'fastify';
import {
	Appservice,
	type IAppserviceOptions,
	type IAppserviceStorageProvider,
	type Intent
} from 'matrix-bot-sdk';

// The fields of a pushed transaction the SDK sets the encryption of their users up for (MSC2409
// for the to-device and ephemeral events, MSC3202 for the key counts), under the names it reads
const TO_DEVICE = 'de.sorunome.msc2409.to_device';
const EPHEMERAL = 'de.sorunome.msc2409.ephemeral';
const ONE_TIME_KEYS = 'org.matrix.msc3202.device_one_time_keys_count';
const ONE_TIME_KEYS_BEFORE_SYNAPSE_1_73 = 'org.matrix.msc3202.device_one_time_key_counts';
const FALLBACK_KEYS = 'org.matrix.msc3202.device_unused_fallback_key_types';

// What the SDK's handler of a push reads and writes, as express hands them to it
export interface PushRequest {
	body?: unknown;
	readonly params?: Readonly<Record<string, string | undefined>>;
}
export interface PushResponse {
	status(code: number): { json(body: unknown): unknown };
}
type TransactionHandler = (this: Appservice, req: PushRequest, res: PushResponse) => Promise<void>;
type AuthCheck = (this: Appservice, req: PushRequest) => boolean;

export interface PushDeps {
	readonly log: FastifyBaseLogger;
	readonly storage: IAppserviceStorageProvider;
	readonly ensureEncryption: (intent: Intent) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eventsOf(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recipientOf(event: Record<string, unknown>): string | null {
	const userId = event['to_user_id'];
	return typeof userId === 'string' ? userId : null;
}

// An ephemeral event the SDK treats as encrypted, under the type it reads, as MSC2409 renamed it
function isEncryptedEphemeral(event: Record<string, unknown>): boolean {
	return (event['edu_type'] ?? event['type']) === 'm.room.encrypted';
}

function oneTimeKeysOf(body: Record<string, unknown>): unknown {
	return body[ONE_TIME_KEYS] ?? body[ONE_TIME_KEYS_BEFORE_SYNAPSE_1_73];
}

// The users whose encryption the SDK sets up while it processes a push, as it picks them: those its
// to-device events, and its encrypted ephemeral ones, are for, and those it reports the one-time and
// fallback keys of
export function usersSetUpBy(body: Record<string, unknown>): string[] {
	const users = new Set<string>();
	for (const event of eventsOf(body[TO_DEVICE])) {
		const userId = recipientOf(event);
		if (userId !== null) users.add(userId);
	}
	for (const event of eventsOf(body[EPHEMERAL]).filter(isEncryptedEphemeral)) {
		const userId = recipientOf(event);
		if (userId !== null) users.add(userId);
	}
	for (const counts of [oneTimeKeysOf(body), body[FALLBACK_KEYS]]) {
		if (isRecord(counts)) for (const userId of Object.keys(counts)) users.add(userId);
	}
	return [...users];
}

// The push without what the SDK would hand to the encryption of these users. Their to-device events
// stay in their devices' inboxes, which an assistant reads again when a message fails to decrypt.
export function withoutKeyUpdatesOf(
	body: Record<string, unknown>,
	userIds: ReadonlySet<string>
): Record<string, unknown> {
	const isFor = (event: Record<string, unknown>): boolean => {
		const userId = recipientOf(event);
		return userId !== null && userIds.has(userId);
	};
	const kept: Record<string, unknown> = { ...body };
	if (Array.isArray(body[TO_DEVICE])) {
		kept[TO_DEVICE] = eventsOf(body[TO_DEVICE]).filter((event) => !isFor(event));
	}
	if (Array.isArray(body[EPHEMERAL])) {
		kept[EPHEMERAL] = eventsOf(body[EPHEMERAL]).filter(
			(event) => !(isEncryptedEphemeral(event) && isFor(event))
		);
	}
	for (const field of [ONE_TIME_KEYS, ONE_TIME_KEYS_BEFORE_SYNAPSE_1_73, FALLBACK_KEYS]) {
		const counts = body[field];
		if (isRecord(counts)) {
			kept[field] = Object.fromEntries(
				Object.entries(counts).filter(([userId]) => !userIds.has(userId))
			);
		}
	}
	return kept;
}

function isTransactionHandler(value: unknown): value is TransactionHandler {
	return typeof value === 'function';
}

function isAuthCheck(value: unknown): value is AuthCheck {
	return typeof value === 'function';
}

// matrix-bot-sdk 0.8 processes each transaction Synapse pushes inside `new Promise(async (resolve) =>
// …)`: an error thrown in there never settles that promise. The SDK answers a push only once its
// promise settles, and hands the same promise to every retry of the transaction, while Synapse pushes
// the transactions of an application service one at a time and in order: one throw left every later
// push undelivered, for every assistant, until a restart. What throws in there is the setup of the
// encryption of a user the push names, which the SDK runs on the way. Those users are set up here
// first, and the key updates of one whose setup failed are left out of the push, so that the SDK
// never sets anyone up itself. Refusing the push instead would save nothing: Synapse pushes a failed
// transaction again with its room events only.
export function makePushedAppservice(options: IAppserviceOptions, deps: PushDeps): Appservice {
	const sdkHandler: unknown = Reflect.get(Appservice.prototype, 'onTransaction');
	const sdkAuthCheck: unknown = Reflect.get(Appservice.prototype, 'isAuthed');
	if (!isTransactionHandler(sdkHandler) || !isAuthCheck(sdkAuthCheck)) {
		throw new Error('matrix-bot-sdk no longer handles pushed transactions as the harness expects');
	}
	const handleTransaction: TransactionHandler = sdkHandler;
	const isAuthed: AuthCheck = sdkAuthCheck;

	async function failedSetupsOf(
		appservice: Appservice,
		body: Record<string, unknown>
	): Promise<string[]> {
		const users = usersSetUpBy(body);
		const setups = await Promise.allSettled(
			users.map((userId) => deps.ensureEncryption(appservice.getIntentForUserId(userId)))
		);
		return users.filter((_, i) => setups[i]?.status === 'rejected');
	}

	async function onTransaction(
		this: Appservice,
		req: PushRequest,
		res: PushResponse
	): Promise<void> {
		const txnId = req.params?.['txnId'];
		const body = req.body;
		if (
			txnId !== undefined &&
			isRecord(body) &&
			isAuthed.call(this, req) &&
			!(await deps.storage.isTransactionCompleted(txnId))
		) {
			const failed = await failedSetupsOf(this, body);
			if (failed.length > 0) {
				deps.log.error({ txnId, userIds: failed }, 'key updates left out of a push');
				req.body = withoutKeyUpdatesOf(body, new Set(failed));
			}
		}
		await handleTransaction.call(this, req, res);
	}

	// The SDK's constructor takes its handler from the prototype, which its types keep private
	class PushedAppservice extends Appservice {}
	Reflect.defineProperty(PushedAppservice.prototype, 'onTransaction', {
		value: onTransaction,
		writable: true,
		configurable: true
	});
	return new PushedAppservice(options);
}
