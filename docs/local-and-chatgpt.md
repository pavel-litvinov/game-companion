# Docker, tunnel and ChatGPT

## Start and persistence
From the repository root run `npm ci --ignore-scripts` and `npm run local:up`.
Compose starts plain PostgreSQL, runs ordered migrations and starts the API.
No Supabase services, SDK, email registration or cloud account are needed.

Private generated files live in `.local/` (ignored by Git and Docker builds):
`postgres.env` (database container), `migrate.env` (one-shot administrator),
`api.env` (limited app credential and signing settings), and `owner-key.txt`
(the local owner's login key). Files use mode 0600 and the directory mode 0700.
The app receives only the SHA-256 of the owner's key. Never paste the key in chat.
If `cat .local/owner-key.txt` fails, first change into the actual repository root
or use the absolute path to that file. The task's parent directory is not the repo.

Data lives in `game-companion_postgres_data`. `npm run local:stop` preserves it.
Do not use `docker compose down -v` to stop the app. Keep private PostgreSQL
backups and signing configuration together if you need to restore sessions.
The database has no published port. The API binds to loopback port 3000.

## Cloudflare Quick Tunnel
Install cloudflared from its official source, then run:

```sh
cloudflared tunnel --url http://localhost:3000 --no-autoupdate
```

Set `PUBLIC_URL` in `.local/api.env` to the actual HTTPS origin printed by the
command, then run `npm run local:up`. Or pass `GC_PUBLIC_URL=<actual origin>` to
that command. Do not put `/mcp` in PUBLIC_URL. For a container configured with a
public origin, use that origin when testing health/login; its Host check rejects
unconfigured addresses. Container health uses an explicit HTTP Host header.

Quick Tunnels require neither a Cloudflare account nor a domain. They have no
uptime guarantee, do not support SSE, and change hostname on restart. The server
uses JSON MCP replies. Do not put an interactive Cloudflare email gate in front
of MCP: it blocks non-browser clients. Our OAuth protects the data instead.
The Mac, Docker, application and tunnel must remain running. If the hostname
changes, update PUBLIC_URL, restart the app and reconnect the ChatGPT plugin.
A named tunnel and an existing domain can provide a stable URL later.
[Cloudflare reference](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## Add the plugin
In ChatGPT Plugins choose Add → Add custom MCP server. Use:

- Name: Game Companion.
- Server URL: `<PUBLIC_URL>/mcp`.
- Authentication: OAuth.
- Registration: Dynamic Client Registration (DCR).
- Default scopes: companion and offline_access. OpenID discovery is available.

ChatGPT discovers `/auth`, `/token`, `/reg` and the resource automatically.
Review the requested access and create the plugin. At our owner sign-in page,
enter the existing key from `.local/owner-key.txt`, then approve the client.
Do not create an email account or disable authentication.

A redirect can show `Origin:null`; signed interaction cookies plus CSRF still
protect our form. Old interaction links expire after ten minutes. If a link is
expired, start Connect from the plugin again rather than reusing the old URL.
After connection, verify read_records and one deliberate progress submission.
The plugin is not considered connected until the UI and an authenticated MCP
request confirm it.

[Official ChatGPT connection guidance](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)

## Local API, tests and revocation
REST accepts the local owner key as a Bearer token, or an OAuth access token.
MCP requires a resource-bound OAuth token. `npm run test:local` checks live
PostgreSQL + REST, then deletes its synthetic game records in finally. Unit/SQL
and OAuth tests use temporary databases and never seed player data.

The OIDC revocation endpoint and provider grants support revocation; deleting a
grant immediately blocks associated MCP requests. The owner key is a local
administration credential: keep it private and backed up separately from Git.
