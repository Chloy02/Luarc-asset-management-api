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
