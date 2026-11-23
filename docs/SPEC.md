# Game Companion MVP

## Objective and scope
ChatGPT is the primary interface. Store personal games, multiple playthroughs,
immutable progress history, an inbox of original messages, and source-backed
knowledge in local PostgreSQL. No game mechanics, characters, or player progress are seeded.
No LLM subscription or external model API is required for the deterministic MVP.

## Capabilities and build order
`identity` (local owner + OAuth + PostgreSQL RLS) → `profiles` (games and playthroughs) →
`progress` (durable inbox, conservative extraction, revisioned journal) →
`knowledge` (source snapshots and cited claims) → `access` (REST and HTTP MCP).
All capabilities are one backend deployment; there is no separate player website.

## Acceptance criteria
- Every authorized received message is saved before processing; ambiguous text
  stays `needs_review`, and processing failures leave a retryable `pending` message.
- Retry of the same message key and body returns the original message. Reusing
  that key with different text fails. A profile lock and revision check serialize writes.
- Only complete, unambiguous level statements are extracted automatically.
  Other state changes need an explicit owner confirmation with exact evidence.
- Each applied change retains the original message, before/after state, and revision.
  Undo appends a compensating event and never erases history or later changes.
- Cross-owner access, cross-game source links, direct journal edits, anonymous,
  privileged and anonymous-sign-in tokens are rejected.
- Claims cite an exact excerpt in an immutable source snapshot with URL, version,
  retrieval time, and SHA-256. Stored claims are attributed assertions, not certified truth.
- REST and MCP share the same validated command service. No arbitrary SQL, network
  fetching, service-role keys, or user-supplied owner identities in the application.
- SQL integration tests exercise real PostgreSQL semantics in PGlite; Docker smoke tests verify the actual PostgreSQL migration and API.

## Implementation conventions
TypeScript strict mode, ESM, exact dependencies and lockfile. SQL is authoritative
for authorization, invariants, transactions and automatic level extraction.
`src/` contains transport and validation; `tests/` covers SQL and protocol behavior.
Build: `npm run build`; check: `npm run check`; test: `npm test`; dev: `npm run dev`.

## Boundaries
Always validate at API and database boundaries, preserve raw messages, run checks.
Never commit secrets, fabricate real player data, apply inferred mechanics, merge
the PR, or claim ChatGPT is connected before an actual OAuth round trip.
ChatGPT plugin consent is required before it receives access; no email account is required.
