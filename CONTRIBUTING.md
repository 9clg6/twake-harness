# Contributing

Thank you for helping with twake-harness. This page says how to set up the project, run its checks, change its database and propose a change. The [README](README.md) says what the harness does, [`docs/`](docs/README.md) how it does it, and [`CONTEXT.md`](CONTEXT.md) what its words mean.

A bug or an idea can start as an issue, from the templates the repository offers. A vulnerability never does: report it privately, as [SECURITY.md](SECURITY.md) says.

## Set up

You need Node 24 (`package.json` asks for 24 or later, and CI and the image use 24), npm, and Docker: the tests start Synapse and RabbitMQ in containers, through testcontainers, and the compose file runs their PostgreSQL.

```sh
docker compose up -d postgres
npm ci
```

The compose file runs PostgreSQL 16 on port 5433, with the user, password and database `harness`, which the tests use by default.

**The tests empty the database they are given.** They create a plain role, `harness_app`, without superuser rights or `BYPASSRLS`, so that row-level security applies to the harness as in production, then run `drop schema public cascade` on the database `TEST_ADMIN_DATABASE_URL` names and create it again for that role. Point it only at a database you can lose.

## Run the checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run lint` runs `prettier --check .` then `eslint .`, so Markdown and YAML must be formatted too; `npm run format` rewrites everything with Prettier (tabs, single quotes, no trailing commas, 100 columns). `npx vitest run tests/quiet-hours.test.ts` runs one test file. CI runs the same checks (below).

The tests read these variables, each with a default that suits the compose file:

| Variable                        | Default                               | What it sets                                                                                     |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `TEST_ADMIN_DATABASE_URL`       | the compose PostgreSQL                | the database the tests empty and use, as a user that may create roles                            |
| `TEST_REPLICAS`                 | `1`                                   | how many api replicas each suite runs against, sharing the database                              |
| `SYNAPSE_IMAGE`                 | `ghcr.io/element-hq/synapse:v1.160.0` | the Synapse the Matrix tests start                                                               |
| `RABBITMQ_IMAGE`                | `mirror.gcr.io/library/rabbitmq:3.13` | the RabbitMQ the event tests start                                                               |
| `HARNESS_CALLBACK_HOST`         | `host.docker.internal`                | the host Synapse and the broker call the harness back on, for a harness that runs in a container |
| `HARNESS_CALLBACK_HOST_ADDRESS` | `host-gateway`                        | the address `host.docker.internal` resolves to inside the test containers                        |

`npm run test:dev` replays black-box checks against a deployed harness instead, as [docs/development.md](docs/development.md#replaying-against-dev) says.

## Change the database

A schema change is a new SQL file in [`migrations/`](migrations), numbered after the last one, such as `0104_<what>.sql`. At its start, or with `npm run db:migrate`, the service applies the files it has not applied yet, in the order of their names, in one transaction under an advisory lock, and records each by its name in `schema_migrations`, with no checksum: a migration already merged is never edited, since no database that ran it would run it again. Write a new one instead.

A table that holds an owner's rows enables and forces row-level security, with a policy on `current_setting('app.principal', true)`, as the existing migrations do.

## Write the code

The stack and the code conventions are in [docs/development.md](docs/development.md#stack-and-conventions). The tests drive the service through its HTTP boundary and its Matrix rooms, against a real PostgreSQL and, where they need them, a real Synapse and RabbitMQ; a change of behaviour comes with the test that shows it.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, such as `fix(suggestions): tell the owner when a suggestion fails`. The types in use are `feat`, `fix`, `test`, `refactor`, `docs`, `chore` and `ci`; the scope names the area, such as `agent`, `worker`, `matrix`, `suggestions`, `assistants`, `consent` or `chart`. The body says what changed and why, wrapped at about 72 characters.

## Document the behaviour

A change of behaviour updates its documentation in the same pull request:

- what an owner sees or writes, in the [README](README.md);
- how it works, setting by setting, in the page of its area under [`docs/`](docs/README.md), which the index lists;
- a new word, in [`CONTEXT.md`](CONTEXT.md);
- a decision between alternatives, in a new record under [`docs/adr/`](docs/adr), numbered after the last;
- a new environment variable, in [docs/configuration.md](docs/configuration.md), and in the chart's [`values.yaml`](charts/twake-harness/values.yaml) when the chart sets it.

## Propose the change

Open a pull request against `main`, from a branch or a fork, and fill in its template. [CI](.github/workflows/ci.yml) runs:

- `check`: `npm ci`, `npm run lint` and `npm run typecheck`, on Node 24;
- `test`: the suite in three shards, with PostgreSQL 16; a pull request runs it with one api replica on Synapse v1.160.0, and `main` also with two replicas and on Synapse's latest release;
- `chart`: `helm lint`, the chart rendered for each role through kubeconform, and checks of what it renders;
- `image`: the image build, pushed only from `main`;
- `chart-publish`: on `main` only.

A pull request from a fork runs on GitHub's runners, any other on the organization's.

Each build of `main` publishes the image `ghcr.io/linagora/twake-harness` under the tags `sha-<commit>` and `main`, and the chart `oci://ghcr.io/linagora/twake-harness` at version `0.1.0-sha-<commit>`, the same seven characters of the commit, whose appVersion is that image: a release pins the chart of the image it runs. The image and the chart do not wait for the tests on `main`, since a pull request runs them before its merge.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). The project is licensed under the [GNU Affero General Public License v3.0 only](LICENSE).
