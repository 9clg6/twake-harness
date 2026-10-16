# An assistant hears of Twake Chat only where it is admitted

An owner's assistant learns that someone mentions or writes to its owner in Twake Chat only in the rooms the harness is already admitted to: the clear rooms its listener `@twake-assistant` is a member of, and the listened conversations, where everyone said yes. It never reads Chat with its owner's keys or as one of their devices. Only a member that holds a room's keys can tell that an encrypted message mentions someone, since the homeserver sees no mention there (`m.mentions` is encrypted with the content, MSC3952). Reading as the owner would make the assistant a reader of all their conversations, whose other members never said yes, which is what a listened conversation promises them.

## Considered Options

- **Read as one of the owner's devices**, with their keys. Every mention and every direct message would be seen. Rejected: the other members of those rooms never agreed, and every conversation of the owner would reach the harness.
- **An event on the platform's activity exchange** for each message or mention, from ToM-Bridge, as the platform's ADR 006 planned with `message.posted` and `member.mentioned`. Rejected: the bridge reads no encrypted room either, and the harness already receives the clear rooms through its listener.
- **No Chat at all**, since Twake Chat notifies its users already. Rejected: the assistant could not act on what is asked of its owner.

## Consequences

- A mention in an encrypted room the owner's assistant was not brought into stays invisible to it, and so does a direct message written to the owner outside a listened conversation: twake-space-chat encrypts every direct conversation.
- Clear rooms, a space's own rooms among them, are covered while the listener is a member of them. Removing it from a room ends this there.
