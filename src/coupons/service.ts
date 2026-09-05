import { sql } from 'kysely';
import type { CouponStatus, Db } from '../db/index.ts';
import { decodeStringCursor, page, type Page } from '../lib/pagination.ts';

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
