import { sql } from 'kysely';
import type { CouponStatus, Db } from '../db/index.ts';
import { decodeStringCursor, page, type Page } from '../lib/pagination.ts';
import { HttpProblem, notFound } from '../lib/problem.ts';

export const STATS_CACHE_KEY = 'cache:coupons:stats';

export interface CouponView {
  id: string;
  code: string;
  title: string;
  description: string | null;
  status: CouponStatus;
  total_quantity: number;
  claimed_count: number;
  remaining: number;
  expires_at: Date | null;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  claimed_by_me: boolean;
}

export interface NewCoupon {
  code: string;
  title: string;
  description?: string | null;
  total_quantity: number;
  expires_at?: string | null;
}

export interface CouponFilters {
  status?: CouponStatus;
  available?: boolean;
  q?: string;
  limit: number;
  cursor?: string;
}

/** The one SELECT shape every coupon read uses: row + remaining + whether the viewer holds a claim. */
function couponView(db: Db, viewerId: string) {
  return db
    .selectFrom('coupons as c')
    .leftJoin('claims as mine', (join) => join.onRef('mine.coupon_id', '=', 'c.id').on('mine.user_id', '=', viewerId))
    .select([
      'c.id',
      'c.code',
      'c.title',
      'c.description',
      'c.status',
      'c.total_quantity',
      'c.claimed_count',
      'c.expires_at',
      'c.version',
      'c.created_by',
      'c.created_at',
      'c.updated_at',
      sql<number>`c.total_quantity - c.claimed_count`.as('remaining'),
      sql<boolean>`mine.id IS NOT NULL`.as('claimed_by_me'),
    ]);
}

export async function getCoupon(db: Db, id: string, viewerId: string): Promise<CouponView | undefined> {
  return couponView(db, viewerId).where('c.id', '=', id).executeTakeFirst();
}

export async function createCoupon(db: Db, ownerId: string, input: NewCoupon): Promise<CouponView> {
  // A duplicate code raises 23505 on coupons_code_key → mapped to 409 code-taken.
  const { id } = await db
    .insertInto('coupons')
    .values({
      code: input.code,
      title: input.title,
      description: input.description ?? null,
      total_quantity: input.total_quantity,
      expires_at: input.expires_at ? new Date(input.expires_at) : null,
      created_by: ownerId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return (await getCoupon(db, id, ownerId))!;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function listCoupons(db: Db, viewerId: string, f: CouponFilters): Promise<Page<CouponView>> {
  let q = couponView(db, viewerId);
  if (f.status) q = q.where('c.status', '=', f.status);
  if (f.available) {
    q = q
      .where('c.status', '=', 'active')
      .where((eb) => eb.or([eb('c.expires_at', 'is', null), eb('c.expires_at', '>', sql<Date>`now()`)]))
      .where((eb) => eb('c.claimed_count', '<', eb.ref('c.total_quantity')));
  }
  if (f.q) {
    // ponytail: ILIKE with a leading wildcard is a sequential scan; add a pg_trgm GIN index if the pool grows large.
    const like = `%${escapeLike(f.q)}%`;
    q = q.where((eb) => eb.or([eb('c.code', 'ilike', like), eb('c.title', 'ilike', like)]));
  }
  if (f.cursor) q = q.where('c.code', '>', decodeStringCursor(f.cursor));
  const rows = await q.orderBy('c.code', 'asc').limit(f.limit + 1).execute();
  return page(rows, f.limit, (r) => r.code);
}

export interface CouponPatch {
  version: number;
  title?: string;
  description?: string | null;
  total_quantity?: number;
  status?: CouponStatus;
  expires_at?: string | null;
}

/**
 * Optimistic locking. `version` increments only on edits, never on claims, so an editor of a
 * hot coupon is not livelocked by the claim counter changing underneath them (which is why
 * this is a body field and not an ETag/If-Match pair). The WHERE clause carries ownership,
 * the version check, and the id in one statement; the CHECK constraint arbitrates shrinking
 * total_quantity below claimed_count (23514 → 422 in lib/problem.ts).
 */
export async function updateCoupon(db: Db, id: string, ownerId: string, patch: CouponPatch): Promise<CouponView> {
  const updated = await db
    .updateTable('coupons')
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.total_quantity !== undefined ? { total_quantity: patch.total_quantity } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.expires_at !== undefined ? { expires_at: patch.expires_at === null ? null : new Date(patch.expires_at) } : {}),
      version: sql<number>`version + 1`,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', id)
    .where('created_by', '=', ownerId)
    .where('version', '=', patch.version)
    .returning('id')
    .executeTakeFirst();

  if (!updated) {
    // Zero rows: work out which precondition failed, in order of what the client can act on.
    const current = await db.selectFrom('coupons').select(['created_by', 'version']).where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Coupon');
    if (current.created_by !== ownerId) {
      throw new HttpProblem(403, 'forbidden', 'Forbidden', 'Only the coupon owner can modify it.');
    }
    throw new HttpProblem(
      409,
      'version-conflict',
      'Version conflict',
      `Coupon is at version ${current.version}; you sent ${patch.version}. Re-read it and retry.`,
      { current_version: current.version },
    );
  }
  return (await getCoupon(db, id, ownerId))!;
}

export interface ClaimResult {
  id: number;
  coupon_id: string;
  user_id: string;
  claimed_at: Date;
  remaining: number;
}

/**
 * The consistency core. Two statements, one short transaction, READ COMMITTED, no explicit locks.
 *
 *  1. INSERT the claim first. A duplicate dies on the unique index (23505 → 409) without ever
 *     touching the contended coupon row. A bad coupon id dies on the FK (23503 → 404).
 *  2. Conditional UPDATE. Postgres takes the row lock inside the UPDATE and re-evaluates the WHERE
 *     against the newest committed row after any concurrent writer finishes, so the increment is
 *     a true compare-and-swap: N racing claims on Q units yield exactly Q successes.
 *     Zero rows means the predicate failed; we read the row once to say why, then the throw rolls
 *     the INSERT back.
 *
 * Deadlock-free: every claim touches its own new claims row, then one coupon row. The FK check
 * takes FOR KEY SHARE on the coupon; the UPDATE of non-key columns takes FOR NO KEY UPDATE, which
 * is compatible with it. Claims on the same coupon simply queue.
 *
 * Even if this code were wrong, `coupons_claimed_within_total` (CHECK) would refuse to oversell.
 */
export async function claimCoupon(db: Db, couponId: string, userId: string): Promise<ClaimResult> {
  return db.transaction().execute(async (trx) => {
    const claim = await trx
      .insertInto('claims')
      .values({ coupon_id: couponId, user_id: userId })
      .returning(['id', 'coupon_id', 'user_id', 'claimed_at'])
      .executeTakeFirstOrThrow();

    const { rows } = await sql<{ claimed_count: number; total_quantity: number }>`
      UPDATE coupons
         SET claimed_count = claimed_count + 1,
             updated_at    = now()
       WHERE id = ${couponId}
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > now())
         AND claimed_count < total_quantity
      RETURNING claimed_count, total_quantity
    `.execute(trx);

    const updated = rows[0];
    if (!updated) {
      // The FK check above proved the coupon exists, so this read cannot miss.
      const c = await trx.selectFrom('coupons').select(['code', 'status', 'expires_at']).where('id', '=', couponId).executeTakeFirstOrThrow();
      const [slug, title, why] =
        c.status !== 'active'
          ? ['coupon-disabled', 'Coupon disabled', 'it has been disabled by its owner']
          : c.expires_at && c.expires_at.getTime() <= Date.now()
            ? ['coupon-expired', 'Coupon expired', 'it has expired']
            : ['coupon-sold-out', 'Coupon sold out', 'all units have been claimed'];
      throw new HttpProblem(410, slug, title, `Coupon ${c.code} cannot be claimed: ${why}.`);
    }
    return { ...claim, remaining: updated.total_quantity - updated.claimed_count };
  });
}

export interface Stats {
  total_coupons: number;
  active_coupons: number;
  total_units: number;
  claimed_units: number;
  remaining_units: number;
  total_claims: number;
  unique_claimers: number;
  generated_at: string;
}

/**
 * claimed_units (SUM of the denormalised counter) and total_claims (COUNT of claim rows) come from
 * different tables and must always be equal. Exposing both makes the consistency guarantee visible.
 */
export async function couponStats(db: Db): Promise<Stats> {
  const { rows } = await sql<Omit<Stats, 'generated_at'>>`
    WITH c AS (
      SELECT count(*)::int                                   AS total_coupons,
             count(*) FILTER (WHERE status = 'active')::int  AS active_coupons,
             coalesce(sum(total_quantity), 0)::bigint        AS total_units,
             coalesce(sum(claimed_count), 0)::bigint         AS claimed_units
        FROM coupons
    ), k AS (
      SELECT count(*)::bigint               AS total_claims,
             count(DISTINCT user_id)::int   AS unique_claimers
        FROM claims
    )
    SELECT c.total_coupons, c.active_coupons, c.total_units, c.claimed_units,
           (c.total_units - c.claimed_units)::bigint AS remaining_units,
           k.total_claims, k.unique_claimers
      FROM c, k
  `.execute(db);
  return { ...rows[0]!, generated_at: new Date().toISOString() };
}
