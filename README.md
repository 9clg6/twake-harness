# twake-harness

The Twake Space agent harness: one shared service, written in TypeScript, that gives every user of a Twake Workplace platform a personal assistant in Twake Chat, and gives the organization an analysis agent.

- Isolation between users is enforced in code and in the database, not by separate pods.
- Assistants are created by their owner from Twake Chat, through a creator conversation, with nothing to configure.
- Each assistant has memory, skills and self-learning, and acts in the applications with its owner's rights, through the platform's API gateway, asking before it acts.
- The service reaches the outside world only through APISIX, but for its PostgreSQL database and, from the worker role alone, the RabbitMQ broker over AMQP; it keeps the assistants' encryption secrets in the platform's OpenBao, and logs every action with its metadata at `info`, the conversation itself (prompt, answer, reasoning, tool arguments and results) only at `debug`, so the messages it decrypts stay out of production logs; of the arguments of a call, only the `from` and `days` of a `list_calendar_events`, in the shape the contract takes them, reach `info` (see Time zone).

The reference documentation, from the roles to the configuration, is in [`docs/`](docs/README.md).
