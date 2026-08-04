/**
 * Two-user authorization test: user A must never read user B's hands.
 *
 * Runs against DATABASE_URL (Neon). Seeds two neon_auth users, writes a hand
 * for each, then asserts the same SQL the handlers use, scoped by session
 * user_id, returns 404-equivalent empty for cross-user access.
 *
 *   DATABASE_URL=... npm run test:api
 */
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("hand access scoping (two users)", () => {
  /*
   * Connected lazily, not at collection time.
   *
   * `describe.skip` still *evaluates* its callback, it only marks the tests
   * inside as skipped, so a top-level `neon(DATABASE_URL!)` ran even when the
   * suite was meant to be skipped, and threw "No database connection string was
   * provided". `npm run test:api` therefore failed rather than skipped for
   * anyone without the env var, which is a bad state for the one test standing
   * between two accounts and each other's hands: a suite that always errors is
   * a suite nobody reads.
   */
  let sql: ReturnType<typeof neon>;
  const userA = randomUUID();
  const userB = randomUUID();
  let handAId = "";
  let handBId = "";
  let sessionA = "";
  let sessionB = "";

  beforeAll(async () => {
    sql = neon(DATABASE_URL!);
    await sql`
      insert into neon_auth.user (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values
        (${userA}::uuid, 'User A', ${`a-${userA}@example.com`}, true, now(), now()),
        (${userB}::uuid, 'User B', ${`b-${userB}@example.com`}, true, now(), now())
    `;

    await sql`
      insert into profiles (user_id, display_name) values
        (${userA}::uuid, 'User A'),
        (${userB}::uuid, 'User B')
    `;

    const sessA = await sql`
      insert into sessions (user_id, seat_count, stack_bb, small_blind, big_blind, lineup)
      values (${userA}::uuid, 2, 100, 5, 10, '[{"seat":0,"archetype":"human"},{"seat":1,"archetype":"tag"}]'::jsonb)
      returning id::text as id
    `;
    const sessB = await sql`
      insert into sessions (user_id, seat_count, stack_bb, small_blind, big_blind, lineup)
      values (${userB}::uuid, 2, 100, 5, 10, '[{"seat":0,"archetype":"human"},{"seat":1,"archetype":"tag"}]'::jsonb)
      returning id::text as id
    `;
    sessionA = sessA[0].id as string;
    sessionB = sessB[0].id as string;

    const handA = await sql`
      insert into hands (
        session_id, user_id, hand_number, seed, button, board,
        seats, pots, end_street, went_to_showdown
      ) values (
        ${sessionA}::uuid, ${userA}::uuid, 1, 42, 0, array[1,2,3]::smallint[],
        '[]'::jsonb, '[]'::jsonb, 'river', true
      )
      returning id::text as id
    `;
    const handB = await sql`
      insert into hands (
        session_id, user_id, hand_number, seed, button, board,
        seats, pots, end_street, went_to_showdown
      ) values (
        ${sessionB}::uuid, ${userB}::uuid, 1, 99, 0, array[4,5,6]::smallint[],
        '[]'::jsonb, '[]'::jsonb, 'flop', false
      )
      returning id::text as id
    `;
    handAId = handA[0].id as string;
    handBId = handB[0].id as string;
  });

  afterAll(async () => {
    // Cascade from neon_auth.user deletes profiles/sessions/hands.
    await sql`delete from neon_auth.user where id in (${userA}::uuid, ${userB}::uuid)`;
  });

  it("GET hand/:id scoped by session user_id returns 404 for the other user", async () => {
    // Same predicate as api/hand/[id].ts, user_id from session, never body.
    const asA = await sql`
      select id from hands
      where id = ${handBId}::uuid and user_id = ${userA}::uuid
      limit 1
    `;
    expect(asA).toHaveLength(0);

    const asB = await sql`
      select id from hands
      where id = ${handAId}::uuid and user_id = ${userB}::uuid
      limit 1
    `;
    expect(asB).toHaveLength(0);

    const own = await sql`
      select id::text as id from hands
      where id = ${handAId}::uuid and user_id = ${userA}::uuid
      limit 1
    `;
    expect(own[0]?.id).toBe(handAId);
  });

  it("GET /hands never returns the other user's rows", async () => {
    const aList = await sql`
      select id::text as id from hands
      where user_id = ${userA}::uuid
      order by created_at desc
    `;
    const idsA = aList.map((r) => r.id);
    expect(idsA).toContain(handAId);
    expect(idsA).not.toContain(handBId);

    const bList = await sql`
      select id::text as id from hands
      where user_id = ${userB}::uuid
      order by created_at desc
    `;
    const idsB = bList.map((r) => r.id);
    expect(idsB).toContain(handBId);
    expect(idsB).not.toContain(handAId);
  });

  it("hand/record is idempotent on (session_id, hand_number)", async () => {
    const first = await sql`
      insert into hands (
        session_id, user_id, hand_number, seed, button, board,
        seats, pots, end_street, went_to_showdown
      ) values (
        ${sessionA}::uuid, ${userA}::uuid, 2, 7, 1, array[]::smallint[],
        '[]'::jsonb, '[]'::jsonb, 'preflop', false
      )
      on conflict (session_id, hand_number) do nothing
      returning id::text as id
    `;
    expect(first).toHaveLength(1);

    const second = await sql`
      insert into hands (
        session_id, user_id, hand_number, seed, button, board,
        seats, pots, end_street, went_to_showdown
      ) values (
        ${sessionA}::uuid, ${userA}::uuid, 2, 7, 1, array[]::smallint[],
        '[]'::jsonb, '[]'::jsonb, 'preflop', false
      )
      on conflict (session_id, hand_number) do nothing
      returning id::text as id
    `;
    expect(second).toHaveLength(0);

    const count = await sql`
      select count(*)::int as n from hands
      where session_id = ${sessionA}::uuid and hand_number = 2
    `;
    expect(count[0].n).toBe(1);
  });
});
