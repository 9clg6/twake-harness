# Documentation

The [README](../README.md) says what the harness does for an owner and their assistant. These pages are the reference for whoever runs it or changes it: what each part does, setting by setting. A section often sends the reader to another by its name, such as "(see Consent)": the list below says which page holds each one.

- [Architecture](architecture.md): the service as a whole, [Roles](architecture.md#roles), [Behind the gateway](architecture.md#behind-the-gateway), [Jobs between roles](architecture.md#jobs-between-roles), [Admission](architecture.md#admission), [Identity](architecture.md#identity) and [Contracts as tools](architecture.md#contracts-as-tools).
- [Configuration](configuration.md): every environment variable, its default, and the migrations.
- [Assistants](assistants.md): [While a turn works](assistants.md#while-a-turn-works), [Organization agent](assistants.md#organization-agent), [Skills](assistants.md#skills), [Session search](assistants.md#session-search), [Language](assistants.md#language) and [Time zone](assistants.md#time-zone).
- [Encryption](encryption.md): [Encryption](encryption.md#encryption), [The owner's sessions](encryption.md#the-owners-sessions) and [Key escrow](encryption.md#key-escrow).
- [Events](events.md): [Events](events.md#events), [The activity exchange](events.md#the-activity-exchange), [Calendar's invitations](events.md#calendars-invitations), [Listening journal](events.md#listening-journal), [Listened sources](events.md#listened-sources) and [Quiet hours](events.md#quiet-hours).
- [Suggestions](suggestions.md): the meetings an assistant proposes from what is said in a channel or in a listened conversation.
- [Morning brief](morning-brief.md): the brief of the owner's working day, its settings, and the brief they ask for.
- [Consent](consent.md): what an assistant asks before it reads or writes, the token broker's permission, previews, deletion, the consent API and its metrics.
- [Provisioning API](provisioning-api.md): how a client gives its user their assistant without the creator conversation.
- [Development](development.md): [Stack and conventions](development.md#stack-and-conventions), [Develop](development.md#develop) and [Replaying against dev](development.md#replaying-against-dev).
- [Capability catalog](capability-catalog.md): the contracts proposed for each Twake application, and what opening one to the assistants takes.
- [Decisions](adr/): [0001](adr/0001-invitee-assistant-answers-availability.md), the invitee's assistant answers for the invitee's calendar.
- [Glossary](../CONTEXT.md): the words of the domain, from owner and assistant to availability request.

The availability requests one assistant sends another when a listened conversation asks to meet are described in decision 0001 and in the glossary; the Suggestions page does not describe them yet.

## Where things are

- Specification: issue #101 of the deployment project, https://ci.linagora.com/linagora/lrs/saas/deployments/twake/twake-workplace-cozy-apps/-/work_items/101
- Tickets: #102 to #121 of the same project.
- Deployment: the `agent-harness` release of that project, on the dev cluster, from the chart in `charts/twake-harness` published as an OCI package next to the image, `ghcr.io/linagora/twake-harness`. Each build of `main` publishes the image as `sha-<commit>` and the chart as `0.1.0-sha-<commit>`, the same seven characters of the commit, with that image as its appVersion, so a release pins both and no later build changes them.
- Capability catalog: [`docs/capability-catalog.md`](capability-catalog.md), the contracts proposed for each Twake application and what opening one to the assistants takes.
