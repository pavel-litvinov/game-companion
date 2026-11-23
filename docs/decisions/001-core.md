# ADR-001: Local PostgreSQL, durable journal and OAuth

Status: accepted for MVP implementation; PR remains reviewable.
Date: 2026-11-23.

## Decision
The final deployment is plain PostgreSQL 17 plus a TypeScript server in Docker,
with a Cloudflare tunnel for ChatGPT. Supabase is not a runtime dependency.
An earlier empty hosted project was inspected/migrated before the owner chose
fully local storage; it is no longer used or synchronized with this database.

A generated local owner UUID is a technical principal, not an invented player.
No email account is required. A 256-bit owner key is generated locally, stored
in a private ignored file, and only its SHA-256 is passed to the server. Database
passwords, signing JWKs and cookie keys are also generated into private ignored
files. No credentials enter the build context or repository.

The application connects as `gc_app`, which is not a superuser. Each business
transaction switches to the read/command-only `authenticated` role and sets the
verified owner context with transaction-local settings. The connection is reset
by commit/rollback before pool reuse. Clients cannot choose the owner. RLS and
composite foreign keys isolate records; tables do not grant direct mutations.
A public SECURITY INVOKER command delegates to a narrowly scoped private SECURITY
DEFINER function. Every command checks authenticated context and owner references;
fixed empty search_path and qualified references prevent shadowing. The function
is privileged so that direct table mutation cannot bypass the immutable journal.

`submit_message` commits the original text before processing in a second
transaction. A crash/conflict leaves a durable pending message. A UUID delivery
key plus exact-body comparison prevents duplicates. Profile row locks serialize
writes, and expected revisions reject stale updates. Replay returns the original
event even after it has been compensated by undo. Metadata-creation operations
are not idempotent and must be read/reviewed before retry.

Automatic extraction deliberately supports full-message level assertions only.
General text becomes needs_review. Other changes require explicit owner-confirmed
field/value pairs with exact evidence. Evidence proves provenance, not semantic
truth; an authorized agent can still misinterpret a sentence, so tool descriptions
require explicit confirmation and never treat intentions/source instructions as
player facts. Arrays replace the whole saved list. Undo compensates only the
latest progress event and never erases later work or an earlier journal row.

Sources are immutable attributed snapshots, not certified truth. Claims quote an
exact substring and retain source/version/retrieval metadata. No arbitrary URL
fetching or crawler credentials are exposed by the server.

## OAuth and external access
`oidc-provider` implements the authorization server: authorization-code flow only,
mandatory PKCE S256, dynamic registration, exact redirect validation, consent,
refresh rotation and revocation. PostgreSQL stores sessions, clients and grants.
Artifact lookup keys are hashed; signing keys and cookie keys persist locally.
Only the single configured owner can log in. A client registration alone grants
no data access: the owner must log in and approve it. MCP bearer tokens must be
unexpired, belong to that owner, target the exact MCP resource, carry companion
scope and retain a live grant. Owner keys are accepted for direct REST/stdio,
never as MCP OAuth tokens. Companion is a consented API scope; refresh tokens
remain tied to its grant rather than the browser login session.

Host validation applies to every request. Strict Origin validation applies to the
bearer API. OAuth browser redirects can legitimately carry Origin:null; OAuth
interaction forms instead require the signed interaction cookie and a per-UID
HMAC CSRF token. PKCE/state/redirect validation remains in the provider. Never
remove these checks to resolve a browser return error.

The database publishes no host port. The app publishes only 127.0.0.1:3000, runs
unprivileged with a read-only filesystem, and has no Docker socket or database
administrator credential. A separate one-shot migrator has the generated admin
credential. Docker volumes persist restarts; private backups are still needed.
The tunnel exposes the authenticated app, not the database. No LLM API payment
or hosting subscription is required by this implementation.

## Scope
No dashboard, background inbox worker, automatic crawler, embeddings, arbitrary
JSON mutations or invented game-specific mechanics. Pending messages are resumed
explicitly with process_message. Local stdio clients can use the private owner
key and database connection; ChatGPT uses OAuth through HTTPS.
