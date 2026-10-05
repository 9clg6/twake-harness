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
- `matrix` is the Matrix application service: it receives what Synapse pushes, answers as the creator user and the assistants, and calls Synapse through the `matrix` route of APISIX. `npm run matrix:registration` prints the registration file Synapse loads, given `MATRIX_APPSERVICE_URL`, the APISIX route Synapse pushes to.

The Matrix tests start a real Synapse in a container, so Docker is needed to run them.
