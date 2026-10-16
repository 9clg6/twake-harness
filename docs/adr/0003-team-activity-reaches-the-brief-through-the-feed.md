# Team activity reaches the brief through each space's Feed

The activity of a space's applications that names no one, such as a mail received in a team mailbox, a task done or files added to a folder, reaches an owner through their brief. The brief reads the Feed of every space they are a member of, viewer included, with their own Space token. That activity does not come from events each application would publish on the platform's activity exchange with the people it concerns: the exchange is left to wake-ups, whose activities name their recipients. The Feed already holds a card for each object of a space's applications and shows each member what Space lets them see, so one read covers every application, and the mail side service and Tasks have nothing more to publish for it.

## Considered Options

- **Each application names the people concerned on the activity exchange**, such as the editors and admins of a team mailbox, and the harness listens to all of it. Rejected: every producer would compute, and keep right, who may see what, which Space already does for the Feed, and none of it would wake anyone.

## Consequences

- What happens outside the spaces has no Feed and reaches no brief this way.
- An owner's brief reads the Feed once they have given their Space API token, with `space:read` and `feed:read`, at the token broker.
- A card shows only once its application publishes the activity: Drive's folders wait for cozy-stack's ADR 010.
