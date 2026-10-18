import type { ReadMessage } from './messages.js';
import type { ReadReceipt } from './receipts.js';

// The assistant that read a message of a listened conversation, for its owner alone
export interface ReadingAssistant {
	readonly owner: string;
	readonly userId: string;
}

// What reads the messages and the read receipts the matrix role reads: the messages of the channels
// the listener is in, for whoever they concern, and those of the listened conversations, once for
// each assistant that reads them, for its owner alone; the receipts of any room an account of the
// harness is in
export interface Subscriber {
	// What names it in the logs
	readonly name: string;
	message?(message: ReadMessage, assistant: ReadingAssistant | null): Promise<void>;
	receipt?(receipt: ReadReceipt): Promise<void>;
}
