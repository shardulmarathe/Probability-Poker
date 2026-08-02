-- Probability Poker persistence schema.
-- Applied after Neon Auth (Managed Better Auth) has created neon_auth.*.
-- user_id is uuid to match neon_auth.user(id).

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
