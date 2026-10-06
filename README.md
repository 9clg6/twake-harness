# twake-harness

The Twake Space agent harness: one shared service, written in TypeScript, that gives every user of a Twake Workplace platform a personal assistant in Twake Chat, and gives the organization an analysis agent.

- Isolation between users is enforced in code and in the database, not by separate pods.
- Assistants are created by their owner from Twake Chat, through a creator conversation, with nothing to configure.
- Each assistant has memory, skills and self-learning, and acts in the applications with its owner's rights, through the platform's API gateway, asking before it acts.
- The service reaches the outside world only through APISIX, keeps the assistants' encryption secrets in the platform's OpenBao, and logs every action and reasoning step in clear.

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

| Variable                       | Meaning                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| `HARNESS_ROLE`                 | `api`, `matrix` or `worker`                                     |
| `HOST`, `PORT`                 | listening address, `0.0.0.0:8080` by default                    |
| `DATABASE_URL`                 | PostgreSQL connection string of a plain role, never a superuser |
| `AUTH_JWKS_URL`                | JWKS of the OIDC provider the access tokens come from           |
| `AUTH_ISSUER`, `AUTH_AUDIENCE` | expected `iss` and `aud` of the access tokens                   |
| `LOG_LEVEL`                    | pino level, `info` by default                                   |

Migrations in `migrations/` run at start, under an advisory lock so replicas do not race.

## Roles

One image, one role per deployment, chosen by `HARNESS_ROLE`:

- `api` serves the HTTP API behind APISIX.
- `worker` runs the daily curation: for every owner, under their own principal, it merges duplicate memory entries and turns a request made the same way in three conversations or more into a skill proposal for that owner. It serves its health check and nothing else.
- `matrix` is the Matrix application service: it receives what Synapse pushes, answers as the creator user and the assistants, and calls Synapse through the `matrix` route of APISIX. `npm run matrix:registration` prints the registration file Synapse loads, given `MATRIX_APPSERVICE_URL`, the APISIX route Synapse pushes to.

The Matrix tests start a real Synapse in a container, so Docker is needed to run them.

### Behind the gateway

The api role is meant to sit behind APISIX only. With `GATEWAY_SHARED_SECRET` set, every request of the API must carry that value in `x-twake-gateway`, which the gateway injects on what it forwards; anything else gets a 403 before any identity work, while the health check and the metrics stay open to the cluster. Every contract call is posted to the audit route as one record in the shape the audit relay takes from the gateway's own logger (agent, user, contract, method, path, status, correlation id), so it lands in the audit topic keyed by the agent.

### Jobs between roles

The roles hand work to each other through the `jobs` table: a Matrix message becomes a `turn` for the api role, its answer a `send` for the matrix role. Any replica claims any job (`for update skip locked`), so the api role scales horizontally; the chart ships a horizontal autoscaler for it (`autoscaling.enabled`), never below one replica. A job carries a dedup key, so an event Synapse delivers twice makes one turn, and a group key: the turns of one owner and the answers of one room run one at a time, in the order they were queued, whichever replica takes them. A job still running after its lease (fifteen minutes) is handed back to the queue, as its replica is taken for gone.

### Admission

A turn is admitted before any model call. The turns per minute of a user, those of the whole harness and the daily tokens of a user are counted in the database, so the limits hold whatever the number of replicas; the turns in flight, the queue of a full replica and the slots a user holds in it are each replica's own, as are the counters of `/metrics`. A refused turn gets a 429 with its reason.

### Encryption

The assistants' rooms are created encrypted and every message in them is encrypted end to end. The matrix role holds one encryption store per assistant on its volume, acts as each assistant's device through the application service (device masquerading, MSC3202), and receives the key shares Synapse pushes with the transactions (MSC2409), so no assistant runs a sync loop. Both flags are enabled on the Synapse the harness is registered with. The fallback, had push proved unworkable, would have been one sync loop per assistant; it was not needed. An assistant's encryption state is prepared when the role starts and when it is invited, so a key share that arrives while the role was away is not lost: Synapse redelivers the transaction and the message is answered once the role is back.

### Identity

One person is one principal everywhere in the harness: the subject of their platform token, which is their email. A user of the homeserver is that same person: `@alice:<MATRIX_SERVER_NAME>` is the principal `alice@<MATRIX_MAIL_DOMAIN>`, and the mail domain defaults to the server name. The creator conversation, the API, the `owner` of the events the dispatcher posts and the owner header of the contract calls all carry that principal, so the assistant created from Twake Chat is the one the API returns for the owner's token, and a delegation keyed by email at the gateway matches. A principal of another mail domain has no account on the homeserver, so no room can be opened for it: the API refuses to create its assistant with a 422.

### Organization agent

With `ORG_AGENT_ENABLED`, the matrix role runs one more bot, the organization agent: a Matrix user in the assistants' namespace (`ORG_AGENT_LOCALPART`), with its own name and persona, that joins the direct messages of the members named in `ORG_AGENT_MEMBERS` and nobody else, greets them, and answers each of them with the member's identifier in front of the message. It acts under the organization principal, `org`, so its memory is the organization's and its skills library is the organization's; no token can carry that subject. Its contract calls carry no owner header: the gateway sees the harness key alone.

### Events

The dispatcher wakes an assistant by posting an event to `POST /v1/events` with the owner's identifier, the event's id and its type, under a token of one of the service clients named in `EVENTS_CLIENT_IDS` (by subject); a user's token is refused. The harness queues a turn in the owner's room, deduplicated on the event id, in which the assistant reads the event through the contracts and tells the owner. An event for a user without an assistant is refused and logged.

### Key escrow

With `ESCROW_ENABLED`, the matrix role escrows each assistant's identity in the platform OpenBao, through the `openbao` route of APISIX and the Kubernetes auth method (`OPENBAO_K8S_ROLE`, the pod's projected token with the audience the chart sets): once an assistant's encryption is ready, its cross-signing keys are uploaded to the homeserver, a key backup is opened there, and the secret storage key, the three cross-signing secrets, the backup key and its version go to `<mount>/data/<prefix>/<owner>`. The database keeps the path, the master public key and the backup version only; every read and write of the escrow is logged with the principal. Room keys are backed up as they come and go. After a lost store, `POST /v1/assistants/me/recover` (the owner's token) puts the new device back on the escrowed identity, which the owner's clients already trust, and the backup goes on; the room keys of the lost device stay in the server backup, unreadable until the crypto bindings can import them. At rest, the store on the volume is protected by the volume's own encryption (an encrypted storage class).

### Skills

Skills follow the Agent Skills format: a name, a description and Markdown instructions. Each user has a library, the organization has one, and every skill has exactly one owner. The system prompt lists the skills a user may read, with their descriptions; the model reads one with `scoped_skills_read` when it applies and searches them with `skills_search`. What the assistant learns becomes a proposal through `skills_propose`, invisible to the model until its owner approves it (`POST /v1/skills/proposals/:id/approve`). An administrator, a principal with the `skills.admin` right, writes organization skills (`POST /v1/org/skills`) and promotes a user's proposal into the organization library by copy (`POST /v1/org/skills/promote/:id`), leaving the user's library untouched. Row-level security enforces all of it: a user never sees another user's skill, and the organization's are written by administrators only.

### Session search

The model finds past conversations with `session_search`, by words they contain, among the owner's sessions only; the result gives the session ids and a snippet, and `scoped_sessions_read` opens one.

### Contracts as tools

The harness reads the curated OpenAPI that APISIX serves and turns every operation that has an `operationId` into a tool named after it, dots replaced by underscores. A tool call goes to APISIX under the contracts path with the harness consumer key, the contract id and the owner in `x-twake-on-behalf-of`; the gateway attaches the owner's token, so the harness never holds one. What a contract returns is handed to the model as data, status included, and every call is logged and posted to the audit route. The catalog is loaded at start and refreshed on an interval; a failed refresh keeps the previous catalog.
