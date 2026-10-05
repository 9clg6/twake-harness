# twake-harness

The Twake Space agent harness: one shared service, written in TypeScript, that gives every user of a Twake Workplace platform a personal assistant in Twake Chat, and gives the organization an analysis agent.

- Isolation between users is enforced in code and in the database, not by separate pods.
- Assistants are created by their owner from Twake Chat, through a creator conversation, with nothing to configure.
- Each assistant has memory, skills and self-learning, and acts in the applications with its owner's rights, through the platform's API gateway, asking before it acts.
- The service reaches the outside world only through APISIX, keeps the assistants' encryption secrets in the platform's OpenBao, and logs every action and reasoning step in clear.

## Where things are

- Specification: issue #101 of the deployment project, https://ci.linagora.com/linagora/lrs/saas/deployments/twake/twake-workplace-cozy-apps/-/work_items/101
- Tickets: #102 to #121 of the same project. The walking skeleton is #105.
- Deployment: the `agent-harness` release of that project, on the dev cluster.

## Status

Not started. The first ticket to take is #105.
