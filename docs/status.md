# Implementation status

Updated 2026-11-23 (Europe/Kyiv).

## Final architecture
Plain local PostgreSQL 17 + TypeScript API/MCP + local OAuth provider, in Docker.
Cloudflare Quick Tunnel exposes only the authenticated application. No database
port, Supabase service, cloud database or paid hosting is required by this runtime.
Generated owner/database/signing credentials are private and ignored by Git.

## Verified
- Repository originally had no commits. A minimal README initialized main so
  implementation could proceed through `codex/game-companion-mvp` and a PR.
- Ordered PostgreSQL migrations apply through the separate administrator job.
- API runs with an unprivileged database role; business transactions use RLS
  and transaction-local verified owner context.
- SQL and transport tests cover isolation, durability, idempotency, revision
  conflicts, undo, evidence, sources and both supported MCP protocol generations.
- OAuth integration test covers owner login, signed interaction CSRF, opaque
  browser origins, consent, PKCE, token exchange/rotation/replay and revocation.
- Live Docker REST smoke test verifies submit/retry/undo and removes every
  synthetic game/profile/message/event afterward.
- Public tunnel health and OAuth discovery have been verified over HTTPS.
- ChatGPT discovered the actual authorization/token/registration/resource URLs.

## Connection status
The personal plugin setup is in progress in the owner's ChatGPT account. Actual
installation/consent and an authenticated tool round trip are reported separately;
a reachable URL or filled form alone is not a completed connection.

## Limits
Only explicit full-message level assertions are automatically extracted.
Other facts require owner confirmation and exact evidence. There is no automatic
background inbox worker, game-specific database or guaranteed delivery of every
ordinary ChatGPT message. The tool must actually be called.

The Quick Tunnel hostname changes if its process is restarted. The Mac and
containers must be running. Persistent volumes are not a substitute for private
backups. Initial metadata-creation commands do not promise retry idempotency.

## Earlier hosted inspection
At the original request, the GitHub and Supabase connectors confirmed an empty
repository and empty hosted project. Two schema-only migrations were applied to
that hosted project before the owner selected plain local PostgreSQL. Rollback
smoke tests left its user/game/progress/source counts at zero. That project was
not deleted; the final application neither connects to it nor synchronizes data.
