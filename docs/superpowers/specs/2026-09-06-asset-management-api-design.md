# Asset Management API — Design Spec

**Date:** 2026-09-06
**Status:** Approved 2026-09-06 (JWKS verification cut on review)
**Context:** Take-home task for the Backend Engineer role at Luarc. The brief asks for an authenticated coupon/voucher API that stays consistent when hundreds of users claim or update the same records concurrently, with efficient relational queries for a user's history and the global pool state.

---

## 1. Goals and non-goals

### Goals

1. **Correct under contention.** With N users racing for a coupon with Q units, exactly Q claims exist afterwards and the denormalized counter equals the row count. Provable by an automated test.
2. **Consistency enforced by Postgres**, not by application code. Every invariant has a constraint backing it.
3. **Secure, complete auth flow**: register, login, refresh with rotation, logout, revocation, no user enumeration on login.
4. **Efficient relational reads**: joins and filters with matching indexes and keyset pagination.
5. **Reviewer-friendly**: one command to run, OpenAPI docs, a README that explains every design decision and shows test output.

### Non-goals (deliberately omitted)

- Admin role. Authorization is ownership based (coupon creator).
- Redeem step after claiming. Would be a second conditional update of the same shape; noted in README as a natural extension.
- Configurable per-user claim limit. One claim per user per coupon, enforced by a unique constraint.
- Idempotency-Key header. The unique constraint already makes claim retries safe.
- Soft delete. Coupons are disabled via `status`.
- Email verification, password reset, CORS configuration, multi-tenancy.
- Owner view of "who claimed my coupon". The two required read paths (history, pool) are covered.
- Infrastructure-as-code. AWS deployment is described in prose only.
- Verifying externally issued tokens (Supabase JWKS, multi-algorithm). Our claim shape matches Supabase's, but verifying their keys would dead-end without user provisioning, so it was cut on review.

---

## 2. Stack and tooling

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 24, TypeScript executed natively (type stripping) | No build step. `node src/server.ts` runs in dev, tests, and the Docker image. Verified locally: `node --test` with `.ts` files and `--env-file` work with no flags or warnings. |
| Framework | Express 5.2 | Named on Luarc's site. Express 5 forwards rejected promises from async handlers to the error middleware, so no wrapper library. |
| Validation | zod 4 | Request bodies, query strings, and environment config all validated with the same library. |
| Database | PostgreSQL 16 | Row-level locking, CHECK constraints, RETURNING, partial and composite indexes. Supabase is Postgres, so the schema ports unchanged. |
| Query layer | Kysely 0.29 + pg 8 | Typed SQL builder that never hides the SQL. Transactions, `RETURNING`, `ON CONFLICT`, raw `sql` template, built-in migrator. |
| JWT | jose 6 | HS256 sign and verify with a shared secret. Small, audited, no callbacks. |
| Passwords | `node:crypto` scrypt | Zero dependencies, OWASP-listed KDF, constant-time comparison via `timingSafeEqual`. Parameters stored in the hash string so they can be raised later. |
| Redis | redis 6 (node-redis) | Rate limiting and one read cache. |
| Logging | pino 10 + pino-http 11 | Structured JSON logs, request ids, redaction of the Authorization header. |
| Security headers | helmet | One line, standard. |
| API docs | Hand-written `openapi.yaml` served by swagger-ui-express | No generator dependency. A contract test asserts every registered Express route appears in the spec so it cannot drift silently. |
| Tests | `node:test` + global `fetch` | Zero test dependencies. Tests hit a real Postgres and Redis, never mocks. |
| Load test | k6 script | Reviewer can watch the guarantee hold under real HTTP load. |
| Type checking | `tsc --noEmit`, TypeScript ^5.9, `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions` | Type checking only; Node executes the source. |
| Package manager | npm with lockfile | Zero friction for reviewers. |
| Containers | Dockerfile (node:24-alpine, non-root) + docker-compose.yml (api, postgres:16, redis:7) | `docker compose up` brings up everything, runs migrations and seed, then starts the API. |
| CI | GitHub Actions | Postgres and Redis service containers, typecheck, tests, Docker build. |

Runtime dependencies (10): express, kysely, pg, jose, zod, redis, pino, pino-http, helmet, swagger-ui-express.
Dev dependencies: typescript, @types/node@24, @types/express, @types/pg, @types/swagger-ui-express.

---

## 3. Data model

All timestamps are `timestamptz`. UUIDs are generated with `gen_random_uuid()`.

### users

| column | type | constraints |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| email | text | NOT NULL, UNIQUE. Stored trimmed and lowercased by the application. |
| password_hash | text | NOT NULL. Format `scrypt$N$r$p$<salt_b64>$<hash_b64>`. |
| created_at | timestamptz | NOT NULL, default now() |

### refresh_tokens

| column | type | constraints |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | NOT NULL, FK users(id) ON DELETE CASCADE |
| token_hash | text | NOT NULL, UNIQUE. SHA-256 hex of the opaque token. The raw token is never stored. |
| expires_at | timestamptz | NOT NULL |
| revoked_at | timestamptz | NULL |
| created_at | timestamptz | NOT NULL, default now() |

Index: `(user_id)` for family revocation.

### coupons

| column | type | constraints |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| code | text | NOT NULL, UNIQUE. Immutable after creation. Uppercase, `^[A-Z0-9][A-Z0-9-]{1,31}$`. |
| title | text | NOT NULL, 1..120 chars |
| description | text | NULL, max 2000 chars |
| status | text | NOT NULL, CHECK IN ('active','disabled'), default 'active' |
| total_quantity | integer | NOT NULL, CHECK > 0 |
| claimed_count | integer | NOT NULL, default 0 |
| expires_at | timestamptz | NULL. NULL means never expires. |
| version | integer | NOT NULL, default 1. Incremented only by PATCH, never by claims. |
| created_by | uuid | NOT NULL, FK users(id) |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now(). Set by the application on every UPDATE. |

Table constraint: `CHECK (claimed_count >= 0 AND claimed_count <= total_quantity)` — **the oversell backstop**. Even a bug in the application cannot push the counter past total.

Indexes: `(status, code)` for the filtered, code-ordered pool listing. The unique index on `code` serves lookups and the keyset cursor.

Derived, never stored: `remaining = total_quantity - claimed_count`. "Sold out" is `remaining = 0`, not a status value, so it cannot drift.

### claims

| column | type | constraints |
|---|---|---|
| id | bigint | PK, GENERATED ALWAYS AS IDENTITY. Monotonic, used as the history cursor. |
| coupon_id | uuid | NOT NULL, FK coupons(id) |
| user_id | uuid | NOT NULL, FK users(id) |
| claimed_at | timestamptz | NOT NULL, default now() |

Table constraint: `UNIQUE (coupon_id, user_id)` — **one claim per user per coupon**, enforced across concurrent transactions by the unique index.

Indexes: `(user_id, id)` for the per-user history keyset scan (btree scans backwards for DESC). `(coupon_id)` for the FK and reconciliation queries.

### Invariants (all DB-enforced)

1. `0 <= claimed_count <= total_quantity` on every coupon, at all times, including mid-transaction.
2. At most one claim row per (coupon, user).
3. `claimed_count = COUNT(claims WHERE coupon_id = id)` after every committed transaction. Enforced procedurally by the claim transaction (insert + increment in one atomic unit) and verified by tests and by the stats endpoint exposing both numbers.

---

## 4. Concurrency design

### 4.1 Claim: atomic compare-and-swap, no explicit locks

```sql
BEGIN;  -- READ COMMITTED (default)

-- Step 1: cheap uniqueness gate. A duplicate fails here on the unique index
--         without ever touching the contended coupon row.
INSERT INTO claims (coupon_id, user_id) VALUES ($coupon, $user);
--   23505 unique_violation           -> ROLLBACK, 409 already-claimed
--   23503 fk claims_coupon_id_fkey   -> ROLLBACK, 404 not-found
--   23503 fk claims_user_id_fkey     -> ROLLBACK, 403 unknown-user (deleted user with a live token)

-- Step 2: conditional increment. Postgres takes the row lock inside UPDATE and
--         re-evaluates the WHERE clause against the latest committed version
--         after any concurrent writer finishes (EvalPlanQual), so the
--         increment is a true CAS.
UPDATE coupons
   SET claimed_count = claimed_count + 1,
       updated_at    = now()
 WHERE id = $coupon
   AND status = 'active'
   AND (expires_at IS NULL OR expires_at > now())
   AND claimed_count < total_quantity
RETURNING claimed_count, total_quantity;

-- 0 rows: diagnose with a plain SELECT of status/expires_at/counts, then ROLLBACK:
--   status = 'disabled'                 -> 410 coupon-disabled
--   expires_at <= now()                 -> 410 coupon-expired
--   otherwise                           -> 410 coupon-sold-out

COMMIT;  -- 201 with the claim and remaining = total_quantity - claimed_count
```

Why this beats the alternatives (this reasoning goes in the README):

| Approach | Verdict |
|---|---|
| `SELECT ... FOR UPDATE`, check in app, then UPDATE | Correct, but two round trips and the check lives in JavaScript. The conditional UPDATE does the same lock with the check in SQL. |
| `SERIALIZABLE` + retry loop | Correct, but pays serialization-failure retries under exactly the contention we are designing for. Unnecessary when one row is the whole conflict set. |
| Application-level mutex / Redis lock | Not durable, not transactional, wrong layer. The database already owns the row lock. |
| Check in app, then blind `UPDATE SET claimed_count = $n` | Lost update. This is the bug the brief is testing for. |

**Deadlock freedom.** Every claim touches rows in the same order: its own new claims row, then one coupon row. The FK check on `coupon_id` takes `FOR KEY SHARE`, which is compatible with the `FOR NO KEY UPDATE` lock the UPDATE takes on non-key columns. Two claims for the same coupon simply queue on that row.

**Isolation level.** READ COMMITTED is sufficient. The conditional UPDATE re-checks its predicate after acquiring the lock, and the unique index serializes duplicate inserts (the second inserter blocks until the first commits, then fails). No phantom can slip between the two statements because the invariant is on the same row we lock.

**Throughput ceiling.** One hot row serializes claims for that coupon at roughly the commit latency of the database, on the order of a few thousand per second on RDS-class hardware. Past that, the upgrade path is sharded counters or a Redis `DECR` reservation with async reconciliation. Both trade the single-row guarantee for coordination complexity, which is the wrong trade at the brief's scale of "hundreds". Documented in the README scaling section.

### 4.2 Update: optimistic locking with an explicit version

```sql
UPDATE coupons
   SET title = coalesce($title, title),
       description = ...,
       total_quantity = coalesce($total_quantity, total_quantity),
       status = coalesce($status, status),
       expires_at = ...,           -- explicit null allowed to clear
       version = version + 1,
       updated_at = now()
 WHERE id = $id
   AND created_by = $user          -- ownership, enforced in the same statement
   AND version = $expected_version
RETURNING *;
```

- 0 rows: re-read the coupon. Not found → 404. Owner mismatch → 403. Otherwise → 409 `version-conflict` with `current_version` in the problem body.
- 23514 check_violation (new total below current claimed count) → 422 `quantity-below-claimed`. The database, not the app, refuses to shrink below what has already been handed out.

**Why not ETag / If-Match.** HTTP's native optimistic concurrency is the obvious choice, and the README will say so. It was rejected for this domain because an RFC-correct ETag must change whenever the representation changes, and `claimed_count` changes on every claim. An editor of a hot coupon would receive 412 in a loop and never land an edit. Using a `version` that increments only on edits keeps edits and claims independent. Claims cannot clobber edits and edits cannot clobber claims because they touch disjoint columns under the same row lock, and the CHECK constraint arbitrates the one interaction (shrinking quantity).

### 4.3 Refresh token rotation under concurrency

The refresh handler runs in a transaction and takes `SELECT ... FOR UPDATE` on the token row by hash, so two concurrent refreshes with the same token serialize. The second one sees `revoked_at` set and is treated as reuse (see section 6), which revokes the whole family. This is the strict behavior recommended by the OAuth 2.0 Security BCP. Clients must not refresh concurrently; the README says so.

---

## 5. HTTP API

Base path `/`. All request and response bodies are JSON. Errors use RFC 9457 problem details with `Content-Type: application/problem+json`.

### Authentication and authorization

- Public: `GET /health`, `GET /docs`, `GET /openapi.yaml`, everything under `/auth/*`.
- Everything else requires `Authorization: Bearer <access token>`. Missing or invalid token → 401 `unauthorized`.
- Only the coupon's `created_by` may PATCH it → otherwise 403 `forbidden`.
- `/auth/*` routes are rate limited per client IP (section 7).

### Endpoints

| Method | Path | Auth | Success | Notes |
|---|---|---|---|---|
| POST | /auth/register | no | 201 `{ user, access_token, token_type, expires_in, refresh_token }` | 400 validation, 409 `email-taken` |
| POST | /auth/login | no | 200 same shape as register | 401 `invalid-credentials` for unknown email **and** wrong password (same body, same timing path) |
| POST | /auth/refresh | no | 200 `{ access_token, token_type, expires_in, refresh_token }` | Rotates. 401 `invalid-refresh-token` for unknown, expired, or reused tokens. |
| POST | /auth/logout | no | 204 | Revokes the presented refresh token. Always 204, even if unknown. |
| GET | /me | yes | 200 `{ id, email, created_at }` | 404 if the principal has no user row (deleted user with a live token). |
| GET | /me/claims | yes | 200 `{ data: Claim[], next_cursor }` | Query: `from`, `to` (ISO timestamps on claimed_at), `coupon_status`, `limit` (1..100, default 20), `cursor`. Ordered by claim id DESC. |
| POST | /coupons | yes | 201 Coupon | Body: `code`, `title`, `description?`, `total_quantity`, `expires_at?`. 409 `code-taken`. |
| GET | /coupons | yes | 200 `{ data: Coupon[], next_cursor }` | Query: `status`, `available` (true → active, not expired, remaining > 0), `q` (case-insensitive substring on code or title), `limit`, `cursor`. Ordered by code ASC. |
| GET | /coupons/stats | yes | 200 Stats | Cached in Redis for `STATS_CACHE_TTL_SECONDS` (default 5). `X-Cache: HIT|MISS` header. |
| GET | /coupons/:id | yes | 200 Coupon | 404 |
| PATCH | /coupons/:id | yes, owner | 200 Coupon | Body: `version` (required) plus at least one of `title`, `description`, `total_quantity`, `status`, `expires_at`. 403, 404, 409 `version-conflict`, 422 `quantity-below-claimed`. |
| POST | /coupons/:id/claims | yes | 201 `{ id, coupon_id, user_id, claimed_at, remaining }` | 404, 409 `already-claimed`, 410 `coupon-sold-out` / `coupon-expired` / `coupon-disabled` |
| GET | /health | no | 200 `{ status, checks: { postgres, redis } }` | 503 if Postgres is unreachable. Redis failure → `status: "degraded"` with 200. |
| GET | /docs, /openapi.yaml | no | Swagger UI and the raw spec | |

### Resource shapes

**Coupon**
```json
{
  "id": "uuid", "code": "SUMMER-50", "title": "...", "description": "... | null",
  "status": "active | disabled",
  "total_quantity": 50, "claimed_count": 12, "remaining": 38,
  "expires_at": "ISO | null", "version": 3,
  "created_by": "uuid", "created_at": "ISO", "updated_at": "ISO",
  "claimed_by_me": false
}
```
`claimed_by_me` comes from a LEFT JOIN to the caller's claims and is present on every coupon read.

**Claim (history row)**
```json
{
  "id": 1042, "claimed_at": "ISO",
  "coupon": { "id": "uuid", "code": "SUMMER-50", "title": "...", "status": "active", "expires_at": "ISO | null" }
}
```

**Stats**
```json
{
  "total_coupons": 12, "active_coupons": 10,
  "total_units": 5000, "claimed_units": 1234, "remaining_units": 3766,
  "total_claims": 1234, "unique_claimers": 980,
  "generated_at": "ISO"
}
```
`claimed_units` (SUM of the denormalized counter) and `total_claims` (COUNT of claim rows) are computed from different tables and must always be equal. Exposing both makes the consistency guarantee observable.

### Pagination

Keyset, opaque cursors (base64url of the key). `next_cursor` is `null` on the last page. The server fetches `limit + 1` rows to know whether a next page exists.

- History: key is `claims.id`; `WHERE user_id = $u AND id < $cursor ORDER BY id DESC`. Uses index `(user_id, id)`.
- Pool: key is `coupons.code`; `WHERE code > $cursor ORDER BY code ASC` plus filters. Uses `(status, code)` or the unique code index.

### Error format

```json
{
  "type": "/problems/already-claimed",
  "title": "Coupon already claimed",
  "status": 409,
  "detail": "User has already claimed coupon SUMMER-50.",
  "instance": "/coupons/2b1.../claims",
  "request_id": "..."
}
```
Validation errors add `errors: [{ path, message }]`. Version conflicts add `current_version`. Rate limits add `retry_after` and the `Retry-After` header.

Problem slugs: `validation-error`, `invalid-json`, `payload-too-large`, `unauthorized`, `forbidden`, `not-found`, `email-taken`, `invalid-credentials`, `invalid-refresh-token`, `code-taken`, `already-claimed`, `coupon-sold-out`, `coupon-expired`, `coupon-disabled`, `version-conflict`, `quantity-below-claimed`, `unknown-user`, `rate-limited`, `internal`.

Unexpected errors return 500 `internal` with no stack trace or driver message; the full error is logged with the request id.

---

## 6. Authentication design

### Passwords

`node:crypto` scrypt with N=2^15, r=8, p=3, 16-byte random salt, 64-byte key (an OWASP-listed parameter set, 32 MiB memory cost, within Node's default `maxmem`). Stored as `scrypt$32768$8$3$<salt>$<hash>` so parameters can be raised later and old hashes still verify. Comparison via `crypto.timingSafeEqual`.

Login runs the scrypt verification even when the email is unknown (against a fixed dummy hash) so the response time does not reveal whether the account exists.

### Access tokens

JWT, HS256, signed with `JWT_SECRET` (min 32 chars, validated at startup). Lifetime `ACCESS_TOKEN_TTL_SECONDS` (default 900). Claims follow Supabase's shape:

```json
{ "sub": "<user uuid>", "email": "...", "role": "authenticated", "aud": "authenticated", "iss": "<JWT_ISSUER>", "iat": 0, "exp": 0 }
```

### Verification

HS256 only, with the same `JWT_SECRET`. `jose.jwtVerify` is called with an explicit `algorithms: ['HS256']` allow-list plus `issuer` and `audience`, so `alg: none` and algorithm confusion are rejected by construction. Expired or malformed tokens → 401 `unauthorized`.

The claim shape above is the one Supabase Auth issues, which is a free nod to Luarc's stack; nothing in the code depends on it. Verifying Supabase-issued tokens (their JWKS, ES256/RS256) was considered and cut because it would also require provisioning a `users` row on first sight of an unknown `sub`, and building half of that is worse than building none of it. If a principal's user row is missing (deleted user, live token), writes get 403 `unknown-user` via the FK mapping and `/me` returns 404.

### Refresh tokens

- 32 random bytes, base64url, returned once. Stored as SHA-256 hex. Lifetime `REFRESH_TOKEN_TTL_SECONDS` (default 30 days).
- `/auth/refresh` (in one transaction): lock the row by hash → not found or expired → 401; `revoked_at` set → **reuse detected** → revoke every live token for that user → 401; otherwise revoke this one, insert a new one, issue a new access token.
- `/auth/logout`: set `revoked_at` on the presented token. 204 regardless.
- Expired and revoked rows are never deleted by the API; a periodic cleanup is an ops concern noted in the README.

---

## 7. Redis: rate limiting and one cache

Both features **fail open**: if Redis errors, the request proceeds, the error is logged once per failure with the request id, and `/health` reports `degraded`. Availability of the core API never depends on Redis. The README states this trade-off and when you would flip the rate limiter to fail closed.

### Rate limiting (auth routes)

Fixed window per client IP for every `/auth/*` route: key `rl:auth:<ip>`, `INCR`, set `EXPIRE` when the count is 1, reject with 429 `rate-limited` and `Retry-After` when the count exceeds `RATE_LIMIT_AUTH_MAX` (default 10) within `RATE_LIMIT_AUTH_WINDOW_SECONDS` (default 60). About twenty lines. Marked `ponytail: fixed window, up to 2x burst at boundaries; sliding-window Lua script if that matters`.

`TRUST_PROXY` (default false) controls `app.set('trust proxy', ...)` so the real client IP is used behind an ALB.

### Stats cache

`GET /coupons/stats` reads key `cache:coupons:stats`; on miss it runs the aggregate, stores the JSON with `EX STATS_CACHE_TTL_SECONDS` (default 5), and returns `X-Cache: MISS`. Every successful write that changes the aggregate (coupon create, PATCH, claim) issues `DEL` on the key after commit. The TTL is the safety net if a DEL is lost. Documented staleness bound: at most `STATS_CACHE_TTL_SECONDS`.

Nothing on the claim or update path reads from the cache. The README states this rule explicitly: the write path is never cached because it is the thing being kept consistent.

---

## 8. Cross-cutting behavior

- **Config**: environment variables validated with zod at startup; the process exits with a readable message on a missing or malformed value. `.env.example` documents every variable. Node's `--env-file` loads `.env` in dev and `.env.test` in tests. Variables: `PORT`, `NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL`, `PG_POOL_MAX` (default 10), `REDIS_URL`, `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_SECONDS`, `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_AUTH_WINDOW_SECONDS`, `STATS_CACHE_TTL_SECONDS`, `TRUST_PROXY`.
- **Request ids**: honor an incoming `X-Request-Id`, else generate a UUID; echoed in the response header, included in every log line and every problem body.
- **Logging**: pino-http, JSON, `authorization` header redacted, request bodies never logged.
- **Body limit**: `express.json({ limit: '100kb' })`.
- **Security headers**: helmet defaults.
- **Graceful shutdown**: on SIGTERM/SIGINT stop accepting connections, drain in-flight requests, close the pg pool and Redis client, exit 0. Required for clean ECS task rotation.
- **Health**: `SELECT 1` against Postgres and `PING` against Redis, each with a short timeout.
- **Database driver errors** are mapped to problems in one place (`pg` error `code` + constraint name). Anything unmapped becomes 500 `internal`.

---

## 9. Project layout

```
.
├── src/
│   ├── server.ts              # bootstrap: config → db → redis → app → listen; shutdown hooks
│   ├── app.ts                 # createApp(deps): middleware, routes, error handler (used by tests)
│   ├── config.ts              # zod-validated env
│   ├── db/
│   │   ├── index.ts           # Kysely instance, Database interface (table types)
│   │   ├── migrate.ts         # CLI: migrate to latest (Kysely Migrator, FileMigrationProvider)
│   │   ├── seed.ts            # idempotent demo data
│   │   └── migrations/0001_init.ts
│   ├── auth/
│   │   ├── passwords.ts       # scrypt hash / verify
│   │   ├── tokens.ts          # sign/verify HS256 access tokens, refresh token generate/hash
│   │   ├── middleware.ts      # requireAuth → req.user = { id, email }
│   │   └── routes.ts          # /auth/*, /me
│   ├── coupons/
│   │   ├── service.ts         # claim transaction, versioned update, list/get/stats queries
│   │   └── routes.ts          # /coupons/*
│   ├── claims/
│   │   └── routes.ts          # /me/claims
│   └── lib/
│       ├── problem.ts         # HttpProblem class, pg error mapping, error middleware
│       ├── validate.ts        # parse(schema, source) helper
│       ├── redis.ts           # client, rateLimit middleware, cache get/set/del (fail-open)
│       └── pagination.ts      # cursor encode/decode, limit parsing
├── test/
│   ├── helpers.ts             # boot app on port 0, truncate tables, flush test redis db, create users, mint tokens, api() fetch wrapper
│   ├── auth.test.ts
│   ├── coupons.test.ts        # CRUD, authz, version conflict, quantity-below-claimed
│   ├── claims.test.ts         # happy path, 404/409/410 paths
│   ├── concurrency.test.ts    # the three race proofs (section 10)
│   ├── queries.test.ts        # history filters + pagination, pool filters + pagination, stats + cache
│   └── openapi.test.ts        # every Express route appears in openapi.yaml
├── load/
│   ├── prepare.ts             # writes load/fixtures.json (coupon id + N access tokens) straight from DB
│   └── claim-race.js          # k6 script
├── openapi.yaml
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .github/workflows/ci.yml
├── package.json  tsconfig.json  README.md
```

Unit boundaries:
- `coupons/service.ts` owns every SQL statement that touches coupons and claims. Routes only validate, call the service, and shape the response.
- `lib/problem.ts` is the only place that knows pg error codes.
- `lib/redis.ts` is the only place that knows Redis; callers get `rateLimit(opts)` middleware and `cache.get/set/del` that never throw.
- `auth/tokens.ts` is the only place that knows jose.

---

## 10. Testing

All tests run against real Postgres (`luarc_test` database) and a dedicated Redis logical database (`REDIS_URL=redis://localhost:6379/1`), with `--test-concurrency=1`. `.env.test` sets `RATE_LIMIT_AUTH_MAX=100000` so ordinary auth tests never trip the limiter; the 429 test boots a second app instance via `createApp` with `RATE_LIMIT_AUTH_MAX=3`. Each test file runs migrations to latest, truncates all tables, and flushes the test Redis db in a `before` hook. The app is booted in-process on port 0 and exercised over HTTP with `fetch`, so the tests cover routing, middleware, validation, and serialization, not just the service layer.

### Concurrency proofs (`concurrency.test.ts`)

1. **Oversell**: create a coupon with `total_quantity = 50`; create 500 users directly in the DB and mint their tokens; fire 500 `POST /coupons/:id/claims` with `Promise.all`. Assert exactly 50 responses are 201 and 450 are 410 `coupon-sold-out`; then assert `claimed_count = 50`, `COUNT(claims) = 50`, and `GET /coupons/:id` shows `remaining = 0`.
2. **Duplicate**: one user fires 100 parallel claims on a fresh coupon. Assert 1 × 201, 99 × 409 `already-claimed`, `claimed_count = 1`, one claim row.
3. **Concurrent edits**: 20 parallel PATCHes from the owner, all with `version = 1`. Assert exactly one 200 and nineteen 409 `version-conflict`, and `version = 2` afterwards.
4. **Invariant under mixed load**: run claims and PATCHes (title changes, each sending the version it last saw) concurrently on the same coupon. PATCHes may return 200 or 409; claims return 201 or 410. Assert the claim count is correct, `claimed_count = COUNT(claims)`, and no request returned 500.

### Other coverage

- Auth: register → login → protected call; wrong password and unknown email produce identical 401 bodies; refresh rotates (old token then fails); refresh reuse revokes the family (the newest token also fails); logout revokes; expired access token → 401; malformed Bearer → 401; rate limit returns 429 with `Retry-After` after `RATE_LIMIT_AUTH_MAX` attempts.
- Coupons: create validation (code format, quantity > 0); duplicate code → 409; non-owner PATCH → 403; PATCH without `version` → 400; shrinking below claimed → 422; disabling then claiming → 410 `coupon-disabled`; expired → 410 `coupon-expired`.
- Queries: history returns only the caller's claims, joined coupon fields present, `from`/`to`/`coupon_status` filters, keyset pagination walks all pages with no gaps or duplicates and ends with `next_cursor: null`; pool `available` filter excludes sold-out, expired, and disabled; `claimed_by_me` is correct; stats `claimed_units = total_claims`; stats second call is `X-Cache: HIT`; a claim causes the next call to be `MISS`.
- Health: 200 with both checks ok.
- OpenAPI: every `METHOD path` registered on the Express app exists in `openapi.yaml`.

### Load test

`npm run load:prepare` creates one coupon (`total_quantity = 50`) and 300 users with pre-minted access tokens, written to `load/fixtures.json` (git-ignored). `k6 run load/claim-race.js` runs 300 VUs, one claim each, records counters for 201/409/410, and in `teardown` fetches the coupon and asserts `claimed_count = 50`. The README shows a sample run. Fixtures are minted directly rather than via `/auth/register` so the auth rate limiter does not interfere.

---

## 11. Delivery: Docker, CI, README

**Dockerfile**: `node:24-alpine`, `npm ci --omit=dev`, copy `src/` and `openapi.yaml`, run as `node` user, `CMD ["node", "src/server.ts"]`. No build stage because Node executes TypeScript directly.

**docker-compose.yml**: `postgres:16` and `redis:7` with healthchecks; `api` depends on both being healthy and runs `node src/db/migrate.ts && node src/db/seed.ts && node src/server.ts`. Exposes 3000. Works with both `docker compose` v2 and `docker-compose` v1.29.

**Seed** (idempotent, `ON CONFLICT DO NOTHING`): user `demo@luarc.test` with a password printed in the README, and coupons `WELCOME-100` (100 units), `RACE-50` (50 units, for the demo), `BIG-10000`, `EXPIRED-1` (expired), `DISABLED-1` (disabled).

**CI** (`.github/workflows/ci.yml`): on push and PR; Postgres 16 and Redis 7 service containers; `npm ci`, `npm run typecheck`, `npm test`, `docker build .`.

**README** sections, in order:
1. Quick start (three commands, then a curl walkthrough: login → list pool → claim → history → stats).
2. API overview table and problem types.
3. Data model (mermaid ER diagram) and invariants.
4. Consistency design: the claim transaction annotated, alternatives table, deadlock freedom, isolation level, optimistic locking and why not ETag.
5. Concurrency proof: how to run, pasted output of the four race tests, k6 sample output.
6. Auth: flow diagram, scrypt parameters, rotation and reuse detection, why the claim shape matches Supabase and why JWKS verification was left out.
7. Redis: what is cached, what is never cached, staleness bound, fail-open.
8. Query performance: indexes and pasted `EXPLAIN (ANALYZE, BUFFERS)` for the history query and the pool listing showing index scans.
9. Operations: configuration table, health, logging, graceful shutdown, CI.
10. AWS deployment sketch (mermaid): ALB → ECS Fargate (stateless, N tasks) → RDS Postgres (Multi-AZ) + ElastiCache Redis; Secrets Manager for `JWT_SECRET` and `DATABASE_URL`; CloudWatch logs; migrations as a one-off task before rollout. Scaling notes and the hot-row ceiling from section 4.1.
11. Trade-offs and omissions (section 1 non-goals, with the upgrade path for each).

---

## 12. Decisions log

| Decision | Chosen | Rejected | Reason |
|---|---|---|---|
| Claim concurrency | Insert-then-conditional-UPDATE, READ COMMITTED | FOR UPDATE, SERIALIZABLE, app locks | Fewest round trips, check lives in SQL, no retries, DB constraints as backstop. |
| Edit concurrency | `version` in PATCH body | ETag / If-Match | Counter churn would livelock editors under an RFC-correct ETag. |
| Counter | Denormalized `claimed_count` + CHECK | `COUNT(*)` on claims | O(1) reads on the hot path; integrity guaranteed by the same-transaction insert and verified by the stats endpoint. |
| One claim per user | UNIQUE (coupon_id, user_id) | Per-coupon limit column | DB-enforced, provable, and makes retries idempotent. |
| Pagination | Keyset (id for claims, code for coupons) | OFFSET | Stable under concurrent inserts, index-friendly, exact (no timestamp precision issues). |
| Password hashing | node:crypto scrypt | bcrypt, argon2 | Zero deps, no native build in Docker, OWASP-listed, parameters stored per hash. |
| Tests | node:test + fetch | vitest + supertest | Zero test dependencies on Node 24; tests exercise the real HTTP surface. |
| OpenAPI | Hand-written YAML + contract test | zod-to-openapi generator | No generator dep; drift caught by a 15-line test. |
| Rate limiter | Hand-rolled INCR/EXPIRE | express-rate-limit + redis store | Twenty lines, shows the Redis primitive, no two extra deps. |
| Redis failure mode | Fail open, log, degrade health | Fail closed | Core API availability must not depend on the cache tier; documented flip for the limiter. |
| JWT verification | HS256 only, Supabase-shaped claims | JWKS + multi-algorithm | Dead-ends without user provisioning; cut on review. |
| Env loading | `node --env-file` | dotenv | Stdlib. |
| TypeScript execution | Native type stripping | tsc build / tsx | Verified working on Node 24; removes a whole build pipeline. Fallback: tsx, one dev dep, if a library's types need non-erasable syntax. |

---

## 13. Implementation phases (for the plan)

1. **Scaffold**: package.json, tsconfig, config, app/server, health, problem middleware, logging, helmet, shutdown, Dockerfile, compose, CI skeleton, test helper booting the app.
2. **Database**: migration 0001, Kysely types, migrate and seed scripts.
3. **Auth**: passwords, tokens, routes, middleware, rate limiter; auth tests.
4. **Coupons**: create, get, list, PATCH with version; coupon tests.
5. **Claims and stats**: claim transaction, stats aggregate with cache and invalidation, concurrency tests.
6. **History**: `/me/claims` with filters and pagination; query tests.
7. **Docs and load**: openapi.yaml + contract test, k6 script and fixture generator, README with pasted outputs and EXPLAIN plans.

Each phase ends with `npm run typecheck && npm test` green.
