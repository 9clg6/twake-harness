# Security policy

twake-harness acts in the Twake applications with its users' rights, holds the encryption keys of their assistants and reads the messages it decrypts for them. We take every report seriously and are grateful to anyone who helps keep it safe.

## Supported versions

The harness is deployed continuously from the `main` branch: each build of `main` publishes the image `ghcr.io/linagora/twake-harness:sha-<commit>` and the chart `oci://ghcr.io/linagora/twake-harness` at version `0.1.0-sha-<commit>`. There are no release lines: security fixes are made on `main` only, and reach a deployment when it moves to a build that holds them.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public issues, pull requests or discussions.**

Report them privately with GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**, or go directly to [the reporting form](https://github.com/linagora/twake-harness/security/advisories/new).

Please include as much of the following as you can:

- the part concerned: the role (`api`, `matrix` or `worker`), the provisioning API, a migration, the Helm chart or the image;
- the commit, the image tag (`sha-<commit>`) or the chart version where you found it;
- a description of the vulnerability and of its impact, such as one owner reaching another's data, words that reach an assistant without its owner, or a write that runs without the owner's yes;
- the steps to reproduce it, or a proof of concept;
- a fix or mitigation, if you have one in mind.

Never include real access tokens, keys, passwords, personal data or message contents in a report: redact them.

## What to expect

- We acknowledge your report and keep you informed of its assessment and of the fix.
- We may ask you for details, and we coordinate with you the date of any public disclosure.
- Once a fix is on `main`, we publish a security advisory and credit you for the finding, unless you prefer to remain anonymous.

## Guidelines for security research

- Use the test setup of [CONTRIBUTING.md](CONTRIBUTING.md) whenever you can: it runs the harness against a real PostgreSQL, Synapse and RabbitMQ on your machine, with a gateway and identities of its own.
- If you must test a deployed harness, only use accounts you own, never read or change other people's data, and do not degrade the service (no load or denial-of-service testing).
- Stop and report as soon as you have shown that a vulnerability exists.

## Scope

In scope: the code and configuration of this repository: the three roles, the migrations, the Helm chart, the Dockerfile and the image they build.

Out of scope, to report to their maintainers (tell us too if the harness exposes them): the contracts, in [linagora/twake-space-agent-contracts](https://github.com/linagora/twake-space-agent-contracts); the token broker, in [linagora/twake-space-token-broker](https://github.com/linagora/twake-space-token-broker); Twake Chat, in [linagora/twake-on-matrix](https://github.com/linagora/twake-on-matrix); [Synapse](https://github.com/element-hq/synapse); [APISIX](https://github.com/apache/apisix); the Twake applications themselves; and the model the gateway serves.

## Keeping a deployment secure

- Keep the chart's network policy on (`networkPolicy.enabled`, the default): only APISIX's namespace reaches the pods, and they reach only DNS, APISIX's namespace, the database's addresses (`networkPolicy.databaseCidrs`) and, for a worker that listens to it, RabbitMQ. Add `networkPolicy.extraEgress` only for what a role must reach.
- Set `GATEWAY_SHARED_SECRET` on the api role, and have APISIX send it in `x-twake-gateway` on what it forwards: any other request to the API, but the health check and the metrics, is refused with a 403 before any identity work.
- Give `DATABASE_URL` a plain role, never a superuser nor a role that bypasses row-level security, which keeps each owner's rows to them.
- Set `OWNER_DEVICE_TRUST` to `enforce` (`config.ownerDeviceTrust`) once your users' clients sign their sessions, as Twake Chat does: an owner's words then count only from a session their own identity signed. The default, `report`, takes them all the same and only logs and warns.
- Keep the matrix role's encryption state on a volume of an encrypted storage class (`persistence.storageClass`): the volume's own encryption is what protects it at rest.
- Keep `LOG_LEVEL` at `info` in production: at `debug`, the harness logs the conversations themselves, the messages it decrypts included.
- Keep `AUTH_ANSWER_AUDIENCES` and `PROVISIONER_CLIENT_IDS` to the clients that need them: tokens of those audiences may answer what waits for an owner's yes, and those clients may give any user of the homeserver their assistant.
- Prefer `existingSecret`, a Secret you create and rotate yourself, to `secretEnv`, whose values sit in your Helm values.
- Keep the chart's pod defaults: a non-root user, a read-only root file system, no privilege escalation, every capability dropped, the runtime's default seccomp profile and no service account token mounted.
