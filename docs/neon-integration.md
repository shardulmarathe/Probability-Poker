# Neon integration — server-side task

This is the **server half** of the persistence layer, written to be handed to Cursor (or any
agent/editor) as a self-contained task. The client half — the game, the analysis, and
`src/lib/api.ts` — is being built separately against the contract below.

**The contract is the point.** Both halves must agree on the schema and the endpoint shapes or
they will not meet. If you change anything here, the change has to come back into this file so the
client side follows.

---

## Using the Neon MCP server

The developer has the **Neon MCP server** connected in Cursor, so the database work is done
through it rather than by hand. That changes the workflow in three useful ways:

1. **No credential shuttling.** Cursor creates or selects the project and reads the connection
   string through the MCP; nobody pastes a `DATABASE_URL` into a chat window.
2. **Branch-first migrations.** Neon's migration tooling applies DDL to a temporary branch, lets
   you inspect the result, and only then commits to the main branch. Use that flow — an
   unreviewed migration then costs a discarded branch instead of a restore.
3. **Neon Auth provisioning** can be set up through the MCP too, which is what populates
   `neon_auth.user`.

Exact tool names depend on the MCP server version, so discover them rather than assuming; the
intent above is what matters. **Everything still has to end up as committed SQL in
`db/migrations/`** — a migration that exists only as an MCP call is not reproducible for anyone
else, including a fresh deploy.

> **A caution worth stating once:** the Neon MCP has write access to a real database. Point it at
> a development branch, read the DDL it proposes before committing a migration to main, and never
> let it operate against production data it did not create.

---

## Prompt to run in Cursor

> Add persistence to this Vite + React + TypeScript app using **Neon Postgres** and **Neon Auth**,
> deployed on Vercel. **Use the connected Neon MCP server** for all database work — creating the
> project, provisioning Neon Auth, and applying migrations. Prefer the branch-first migration flow
> (apply to a temporary branch, verify, then commit to main) over running raw DDL against main.
>
> Do not modify anything under `src/poker/`, `src/workers/`, `src/components/`, `src/store/`, or
> `src/pages/` — those are the game engine and UI, owned elsewhere. Your work is confined to
> `api/`, `db/`, `src/lib/auth.ts`, and mounting a provider in `src/main.tsx`.
>
> Follow the schema and endpoint contract in `docs/neon-integration.md` exactly — another
> workstream is building the client against that same contract. If you must deviate, update that
> file so both halves stay in sync.
>
> Requirements:
> 1. Neon Auth (**Managed Better Auth**, not the legacy Stack Auth) for email/password sign-up.
> 2. Every schema change also committed as ordered SQL in `db/migrations/`, so a fresh database can
>    be built without the MCP. Verify by applying them to a clean Neon branch.
> 3. Vercel serverless functions under `api/` implementing the listed endpoints.
> 4. Every handler validates the session and scopes **all** queries by the `user_id` taken from the
>    **session, never the request body**. Add a two-user test proving A cannot read B's hands.
> 5. `hand/record` is **idempotent** on `(session_id, hand_number)` — the client retries from a
>    write-behind queue, so duplicates will happen and must not create rows.
> 6. The app stays fully playable signed-out. Persistence is additive and must never block gameplay.
> 7. Report which Neon project and branch you used, and paste the final migration SQL.

---

## Stack notes (verified current, not from memory)

- Neon Auth is now **Managed Better Auth**. Stack Auth is the legacy product — do not use it.
- React + Vite client: `npm i @neondatabase/neon-js`, then
  `createAuthClient(import.meta.env.VITE_NEON_AUTH_URL)`.
- Users sync into the **`neon_auth.user`** table inside the same Postgres, so application tables can
  foreign-key to it directly and row-level security is available.
- Vercel serves `/api/*` as serverless functions alongside the static Vite build — no extra config.
- Query with `@neondatabase/serverless` over HTTP; open and close within a single request handler
  (connections cannot outlive a request in a serverless environment).

## Environment variables

| Name | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | server only | Neon connection string |
| `VITE_NEON_AUTH_URL` | client (public) | Auth Base URL from Neon Console → Auth → Configuration |

Add both to Vercel project settings. `VITE_`-prefixed vars are **exposed to the browser** — never
put the database URL behind that prefix.

---

## Schema

Cards are stored as integers `0..51` (`(rank - 2) * 4 + suitIndex`, suits ordered `s,h,d,c`),
matching the engine's internal encoding.

> **Deviation note:** `neon_auth.user(id)` is `uuid` under Managed Better Auth, so every
> `user_id` column below is `uuid` (not `text`) to keep foreign keys valid. The client should
> treat user ids as opaque strings.

```sql
create table profiles (
  user_id      uuid primary key references neon_auth.user(id) on delete cascade,
  display_name text not null,
  prefs        jsonb not null default '{}',
  created_at   timestamptz not null default now()
);

-- One sit-down at a table.
create table sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references neon_auth.user(id) on delete cascade,
  seat_count   smallint not null check (seat_count between 2 and 6),
  stack_bb     smallint not null,          -- 20 / 50 / 100 / 200
  small_blind  integer not null,
  big_blind    integer not null,
  lineup       jsonb not null,             -- [{seat, archetype}]
  started_at   timestamptz not null default now(),
  ended_at     timestamptz
);

-- `seed` alone replays the hand exactly; the denormalised cards exist for SQL analytics.
create table hands (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references sessions(id) on delete cascade,
  user_id       uuid not null references neon_auth.user(id) on delete cascade,
  hand_number   integer not null,
  seed          bigint not null,
  button        smallint not null,
  board         smallint[] not null,
  seats         jsonb not null,            -- [{seat, archetype|human, hole, invested, won, status}]
  pots          jsonb not null,            -- [{amount, eligible, winners}]
  end_street    text not null,
  went_to_showdown boolean not null,
  created_at    timestamptz not null default now(),
  unique (session_id, hand_number)
);

-- Every action by every seat. The table the coaching features are built on.
create table decisions (
  id           bigserial primary key,
  hand_id      uuid not null references hands(id) on delete cascade,
  user_id      uuid not null references neon_auth.user(id) on delete cascade,
  seat         smallint not null,
  actor        text not null,              -- 'human' | archetype id
  street       text not null,
  position     text not null,              -- BTN/SB/BB/UTG/HJ/CO
  pot_before   integer not null,
  to_call      integer not null,
  action       text not null,
  cost         integer not null,
  equity       real,
  ev_chosen    real,
  ev_best      real,
  ev_loss      real,                       -- <= 0; 0 means the best action was taken
  created_at   timestamptz not null default now()
);

-- Learned P(action | bucket, street, position) tallies for the human.
create table player_models (
  user_id    uuid primary key references neon_auth.user(id) on delete cascade,
  model      jsonb not null,
  hands_seen integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Rolled-up tracker stats, incrementally maintained.
create table player_stats (
  user_id     uuid primary key references neon_auth.user(id) on delete cascade,
  hands       integer not null default 0,
  vpip_n integer not null default 0, vpip_d integer not null default 0,
  pfr_n  integer not null default 0, pfr_d  integer not null default 0,
  threebet_n integer not null default 0, threebet_d integer not null default 0,
  af_aggressive integer not null default 0, af_passive integer not null default 0,
  wtsd_n integer not null default 0, wtsd_d integer not null default 0,
  wsd_n  integer not null default 0, wsd_d  integer not null default 0,
  net_bb      real not null default 0,
  ev_lost_bb  real not null default 0,
  updated_at  timestamptz not null default now()
);

create index hands_user_id_created_at_idx on hands (user_id, created_at desc);
create index hands_session_id_hand_number_idx on hands (session_id, hand_number);
create index decisions_hand_id_idx on decisions (hand_id);
create index decisions_user_id_street_idx on decisions (user_id, street);
```

Stats are stored as numerator/denominator pairs rather than percentages so they can be updated
incrementally and re-derived exactly. A percentage cannot be merged; a pair can.

---

## Endpoints

All under `api/`. All require a valid session; all scope by the authenticated `user_id` taken from
the **session, never from the request body**.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `POST` | `/api/session/start` | `{seatCount, stackBb, smallBlind, bigBlind, lineup}` | `{sessionId}` |
| `POST` | `/api/session/end` | `{sessionId}` | `{ok}` |
| `POST` | `/api/hand/record` | `{sessionId, hand, decisions[]}` | `{handId}` |
| `GET` | `/api/hands` | `?limit&cursor` | paginated hand summaries |
| `GET` | `/api/hand/:id` | — | full hand + decisions |
| `GET` | `/api/model` | — | `{model, handsSeen}` |
| `PUT` | `/api/model` | `{model, handsSeen}` | `{ok}` |
| `GET` | `/api/stats/me` | — | the `player_stats` row plus derived percentages |
| `GET` | `/api/leaderboard` | `?metric&limit` | ranked list; **display name and metric only** |

Notes:
- `hand/record` must be **idempotent** on `(session_id, hand_number)` — the client retries from a
  write-behind queue, so a duplicate must not create a second row.
- `hand/record` should update `player_stats` in the same transaction as the insert.
- `/api/leaderboard` is the only endpoint that returns data across users. It must expose nothing
  beyond display name and the ranked metric — no hands, no cards, no user ids.

## Authorization test to include

Create two users, have each write a hand, then assert that user A receives 404/403 — not the row —
when requesting user B's `hand/:id`, and that `GET /api/hands` never returns the other's rows.
Scoping by a `user_id` taken from the request body instead of the session is the classic failure
here; the test should fail if anyone makes that change later.

---

## Client contract (built separately — for reference)

`src/lib/api.ts` will expose a write-behind queue: gameplay never awaits the network, failed writes
retry with backoff, and the queue survives a reload. Signed-out play keeps everything in memory and
writes nothing. That means the server can be slow or briefly down without the game stalling — but
it also means `hand/record` **must** be idempotent.
