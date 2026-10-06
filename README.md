# twake-harness

The Twake Space agent harness: one shared service, written in TypeScript, that gives every user of a Twake Workplace platform a personal assistant in Twake Chat, and gives the organization an analysis agent.

- Isolation between users is enforced in code and in the database, not by separate pods.
- Assistants are created by their owner from Twake Chat, through a creator conversation, with nothing to configure.
- Each assistant has memory, skills and self-learning, and acts in the applications with its owner's rights, through the platform's API gateway, asking before it acts.
- The service reaches the outside world only through APISIX, keeps the assistants' encryption secrets in the platform's OpenBao, and logs every action with its metadata at `info`, the conversation itself (prompt, answer, reasoning, tool arguments and results) only at `debug`, so the messages it decrypts stay out of production logs.

## Where things are

- Specification: issue #101 of the deployment project, https://ci.linagora.com/linagora/lrs/saas/deployments/twake/twake-workplace-cozy-apps/-/work_items/101
- Tickets: #102 to #121 of the same project.
- Deployment: the `agent-harness` release of that project, on the dev cluster, from the chart in `charts/twake-harness` published as an OCI package next to the image, `ghcr.io/linagora/twake-harness`.

## Stack and conventions

Aligned with `twake-workplace-common-settings` wherever it has an opinion: TypeScript in strict mode as ES modules, npm, Vitest, Drizzle with postgres.js, zod, ESLint flat config and Prettier with tabs. The HTTP layer is Fastify: common-settings is a SvelteKit application and carries no backend framework, Fastify is the server already used in Twake backends, and its pino logger writes the JSON lines with a request id that the spec requires. Node 22.

Code follows the Twake JavaScript and TypeScript conventions: named exports only, explicit types on exported symbols, `unknown` for external data, no enums, `#` for private members, comments only for business reasons.

## Develop

```sh
docker compose up -d postgres
npm ci
npm test
npm run lint
npm run typecheck
```

Tests drive the service through its HTTP boundary against the real PostgreSQL of the compose file, as a non-superuser role so that row-level security applies, and mint identities with a local signer.

## Configuration

| Variable                       | Meaning                                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HARNESS_ROLE`                 | `api`, `matrix` or `worker`                                                                                                                                     |
| `HOST`, `PORT`                 | listening address, `0.0.0.0:8080` by default                                                                                                                    |
| `DATABASE_URL`                 | PostgreSQL connection string of a plain role, never a superuser                                                                                                 |
| `AUTH_JWKS_URL`                | JWKS of the OIDC provider the access tokens come from                                                                                                           |
| `AUTH_ISSUER`, `AUTH_AUDIENCE` | expected `iss` and `aud` of the access tokens                                                                                                                   |
| `LOG_LEVEL`                    | pino level, `info` by default                                                                                                                                   |
| `ASSISTANT_LOCALE`             | language of the assistants' and creator's texts, `en` or `fr`                                                                                                   |
| `ASSISTANT_TIMEZONE`           | IANA zone of the present each turn states, `UTC` by default                                                                                                     |
| `LLM_MAX_TOKENS`               | token budget of one model call, `8192` by default; a call that ran out while thinking, with nothing written, is retried once at twice the budget, at most 32768 |
| `ADMISSION_MAX_INFLIGHT`       | turns in flight on one replica, `32` by default                                                                                                                 |
| `ADMISSION_USER_QUEUE`         | turns a user may wait for on a full replica, `2` by default, `0` for none                                                                                       |
| `ADMISSION_USER_PER_MINUTE`    | turns one user may start per minute, `10` by default                                                                                                            |
| `ADMISSION_USER_DAILY_TOKENS`  | tokens one user may spend per day, `200000` by default                                                                                                          |
| `ADMISSION_GLOBAL_PER_MINUTE`  | turns the whole harness may start per minute, `400` by default                                                                                                  |

Migrations in `migrations/` run at start, under an advisory lock so replicas do not race.

## Roles

One image, one role per deployment, chosen by `HARNESS_ROLE`:

- `api` serves the HTTP API behind APISIX.
- `worker` runs the daily curation: for every owner, under their own principal, it merges duplicate memory entries and turns a request made the same way in three conversations or more into a skill proposal for that owner. It serves its health check and nothing else.
- `matrix` is the Matrix application service: it receives what Synapse pushes, answers as the creator user and the assistants, and calls Synapse through the `matrix` route of APISIX. `npm run matrix:registration` prints the registration file Synapse loads, given `MATRIX_APPSERVICE_URL`, the APISIX route Synapse pushes to.

The Matrix tests start a real Synapse in a container, so Docker is needed to run them.

### Behind the gateway

The api role is meant to sit behind APISIX only. With `GATEWAY_SHARED_SECRET` set, every request of the API must carry that value in `x-twake-gateway`, which the gateway injects on what it forwards; anything else gets a 403 before any identity work, while the health check and the metrics stay open to the cluster. The gateway writes the audit record of every contract call, one per call (agent, user, contract, method, path, status); the harness forwards the correlation id of the turn in `x-correlation-id`, so the record links back to it, and posts no record of its own.

### Replaying against dev

`npm run test:dev` replays the prototype's black-box checks (identity, default rights, memory and session isolation, identity override, two users at once) against a deployed harness through its gateway, with no database or container: set `HARNESS_BASE_URL` to the api route (for instance `https://apisix.dev.twake.lin-saas.com/agents`) and `HARNESS_TOKEN_A` and `HARNESS_TOKEN_B` to the access tokens of two users carrying the `twake-harness` audience. The results land in `dev-results/vitest.json`, to keep with the pilot. Without those variables the suite is skipped.

### Jobs between roles

The roles hand work to each other through the `jobs` table: a Matrix message becomes a `turn` for the api role, its answer a `send` for the matrix role. Any replica claims any job (`for update skip locked`), so the api role scales horizontally; the chart ships a horizontal autoscaler for it (`autoscaling.enabled`), never below one replica. A job carries a dedup key, so an event Synapse delivers twice makes one turn, and a group key: the turns of one owner and the answers of one room run one at a time, in the order they were queued, whichever replica takes them. A job still running after its lease (fifteen minutes) is handed back to the queue, as its replica is taken for gone.

### Admission

A turn is admitted before any model call. The turns per minute of a user, those of the whole harness and the daily tokens of a user are counted in the database, so the limits hold whatever the number of replicas; the turns in flight, the queue of a full replica and the slots a user holds in it are each replica's own, as are the counters of `/metrics`. A refused turn gets a 429 with its reason.

The limits are the `ADMISSION_*` variables of the configuration. The chart sets each one from its `config.admission*` value (`admissionMaxInflight`, `admissionUserQueue`, `admissionUserPerMinute`, `admissionUserDailyTokens`, `admissionGlobalPerMinute`) only when that value is set, as a whole number. One turn that calls several contracts can use tens of thousands of tokens, since every model call sends the conversation again, so a deployment where people test often may need a larger daily budget per user.

### Encryption

The assistants' rooms are created encrypted and every message in them is encrypted end to end. The matrix role holds one encryption store per assistant on its volume, acts as each assistant's device through the application service (device masquerading, MSC3202), and receives the key shares Synapse pushes with the transactions (MSC2409), so no assistant runs a sync loop. Both flags are enabled on the Synapse the harness is registered with. The fallback, had push proved unworkable, would have been one sync loop per assistant; it was not needed. An assistant's encryption state is prepared when the role starts and when it is invited, so a key share that arrives while the role was away is not lost: Synapse redelivers the transaction and the message is answered once the role is back.

Every assistant device is signed by the assistant's own cross-signing identity, which the harness holds whether the escrow is on or not: Twake Chat sends the room keys only to the devices that the owner of a cross-signing identity signed, so an unsigned device never reads its owner's messages. The identity is created when the assistant first speaks. An identity on the assistant's Matrix user that the harness does not hold, such as one another application left there, is replaced, and so is the harness's own when its store is lost and no escrow keeps it. The cross-signing keys go up as the application service, which Synapse lets replace an identity without interactive authentication; the device's own token could not. The database keeps the master public key the harness holds, to tell its identity from any other.

### Identity

One person is one principal everywhere in the harness: the subject of their platform token, which is their email. A user of the homeserver is that same person: `@alice:<MATRIX_SERVER_NAME>` is the principal `alice@<MATRIX_MAIL_DOMAIN>`, and the mail domain defaults to the server name. The creator conversation, the API, the `owner` of the events the dispatcher posts and the owner header of the contract calls all carry that principal, so the assistant created from Twake Chat is the one the API returns for the owner's token, and a delegation keyed by email at the gateway matches. A principal of another mail domain has no account on the homeserver, so no room can be opened for it: the API refuses to create its assistant with a 422.

### Organization agent

With `ORG_AGENT_ENABLED`, the matrix role runs one more bot, the organization agent: a Matrix user in the assistants' namespace (`ORG_AGENT_LOCALPART`), with its own name and persona, that joins the direct messages of the members named in `ORG_AGENT_MEMBERS` and nobody else, greets them, and answers each of them with the member's identifier in front of the message. It acts under the organization principal, `org`, so its memory is the organization's and its skills library is the organization's; no token can carry that subject. Its contract calls carry no owner header: the gateway sees the harness key alone.

### Events

The dispatcher wakes an assistant by posting an event to `POST /v1/events` with the owner's identifier, the event's id and its type, under a token of one of the service clients named in `EVENTS_CLIENT_IDS` (by subject); a user's token is refused. The harness queues a turn in the owner's room, deduplicated on the event id, in which the assistant reads the event through the contracts and tells the owner. An event for a user without an assistant is refused and logged.

### Key escrow

With `ESCROW_ENABLED`, the matrix role escrows each assistant's identity in the platform OpenBao, through the `openbao` route of APISIX and the Kubernetes auth method (`OPENBAO_K8S_ROLE`, the pod's projected token with the audience the chart sets): once an assistant's device is signed by its identity (see Encryption), a key backup is opened on the homeserver, and the secret storage key, the three cross-signing secrets, the backup key and its version go to `<mount>/data/<prefix>/<owner>`. The escrow only stores the keys: the identity itself is the harness's either way, and an identity replaced since is escrowed again. The database keeps the path, the master public key and the backup version only; every read and write of the escrow is logged with the principal. Room keys are backed up as they come and go. After a lost store, the escrowed identity on the homeserver is not replaced: the new device waits, and `POST /v1/assistants/me/recover` (the owner's token) puts it back on the escrowed identity, which the owner's clients already trust, and the backup goes on; the room keys of the lost device stay in the server backup, unreadable until the crypto bindings can import them. At rest, the store on the volume is protected by the volume's own encryption (an encrypted storage class).

### Skills

Skills follow the Agent Skills format: a name, a description and Markdown instructions. Each user has a library, the organization has one, and every skill has exactly one owner. The system prompt lists the skills a user may read, with their descriptions; the model reads one with `scoped_skills_read` when it applies and searches them with `skills_search`. What the assistant learns becomes a proposal through `skills_propose`, invisible to the model until its owner approves it (`POST /v1/skills/proposals/:id/approve`). An administrator, a principal with the `skills.admin` right, writes organization skills (`POST /v1/org/skills`) and promotes a user's proposal into the organization library by copy (`POST /v1/org/skills/promote/:id`), leaving the user's library untouched. Row-level security enforces all of it: a user never sees another user's skill, and the organization's are written by administrators only.

### Session search

The model finds past conversations with `session_search`, by words they contain, among the owner's sessions only; the result gives the session ids and a snippet, and `scoped_sessions_read` opens one.

### Contracts as tools

The harness reads the curated OpenAPI that APISIX serves and turns every operation that has an `operationId` into a tool named after it, dots replaced by underscores. A tool call goes to APISIX at the path the document gives, as OpenAPI reads it: the path of its first server, the root when it names none, then the operation's path; a server on another host keeps only its path, with a warning, since the gateway is the harness's only way out, and `CONTRACTS_BASE_PATH`, empty by default, prefixes the calls for a gateway that mounts the contracts elsewhere. It carries the harness consumer key, the contract id and the owner in `x-twake-on-behalf-of`; the gateway attaches the owner's token, so the harness never holds one. What a contract returns is handed to the model as data, status included, and every call is logged; the gateway writes its audit record. The catalog is loaded at start and refreshed on an interval; a failed refresh keeps the previous catalog.

### Consent

An assistant reads an application only once its owner allowed it. A contract belongs to the application its id starts with (`mail` for `mail.emails.read.v1`), and a `GET` contract reads. The first time an assistant would read an application its owner never allowed, the harness freezes the call as the model wrote it, stores it for its owner, and ends the turn with its own fixed question in the deployment's language: nothing reaches the application, and nothing the model or a third party writes can phrase that question. The assistant's own feed of workplace events (`events`) is read without asking, and the organization agent, which acts for no user, never asks. Consents and waiting calls are rows of their owner, under row-level security. The assistants of the pilot kept reading Calendar when consents came: every principal that could call contracts then got that consent.

The question carries two buttons, the assistant's own reactions "✅ YES" and "❌ NO" in the deployment's language: Twake Chat shows a reaction's key as its label, and a tap sends the same reaction from the owner. The owner answers with a button, a bare ✅ or ❌, or an exact yes or no as their next message after the question, in any language the harness speaks; anything else they write is an ordinary message, after which only a reaction answers. The matrix role reads the answer itself, never the model, and only from an event that reached the assistant encrypted, sent by the owner: a reaction or a message written in the owner's name on the server, which cannot encrypt for the room, answers nothing, and an answer delivered twice answers once. A no drops the call and erases what it would have sent; the harness says so itself, without the model. A yes approves the call at once and queues a `resume` job with the owner's turns. The job grants the consent, runs the call exactly as it was frozen, under the correlation id of the turn that froze it, records it in the session as the assistant's call followed by its result, and lets the model go on; a resumed turn is admitted like any other.
