import type { Express } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { requireAuth } from '../auth/middleware.ts';
import { pageQuery } from '../lib/pagination.ts';
import { notFound } from '../lib/problem.ts';
import { parse, parseId } from '../lib/validate.ts';
import { claimCoupon, couponStats, createCoupon, getCoupon, listCoupons, STATS_CACHE_KEY, updateCoupon } from './service.ts';

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/, 'must be 2-32 characters of A-Z, 0-9 and hyphens');
const title = z.string().trim().min(1).max(120);
const description = z.string().trim().max(2000).nullish();
const totalQuantity = z.number().int().min(1).max(1_000_000_000);
const expiresAt = z.iso.datetime({ offset: true }).nullish();
const status = z.enum(['active', 'disabled']);

const createBody = z.strictObject({ code, title, description, total_quantity: totalQuantity, expires_at: expiresAt });

const patchShape = {
  version: z.number().int().min(1),
  title: title.optional(),
  description,
  total_quantity: totalQuantity.optional(),
  status: status.optional(),
  expires_at: expiresAt,
};
const EDITABLE = Object.keys(patchShape).filter((k) => k !== 'version') as (keyof typeof patchShape)[];

const patchBody = z
  .strictObject(patchShape)
  .refine((b) => EDITABLE.some((k) => b[k] !== undefined), { message: 'At least one editable field is required', path: [] });

const listQuery = z.object({
  status: status.optional(),
  available: z.stringbool().optional(),
  q: z.string().trim().min(1).max(64).optional(),
  ...pageQuery,
});

export function registerCouponRoutes(app: Express, ctx: AppContext): void {
  const auth = requireAuth(ctx.tokens);

  app.post('/coupons', auth, async (req, res) => {
    const input = parse(createBody, req.body);
    const coupon = await createCoupon(ctx.db, req.user!.id, input);
    await ctx.cache.del(STATS_CACHE_KEY);
    res.status(201).location(`/coupons/${coupon.id}`).json(coupon);
  });

  app.get('/coupons', auth, async (req, res) => {
    const filters = parse(listQuery, req.query);
    res.json(await listCoupons(ctx.db, req.user!.id, filters));
  });

  // Must be registered before /coupons/:id or Express would treat "stats" as an id.
  app.get('/coupons/stats', auth, async (_req, res) => {
    const cached = await ctx.cache.get(STATS_CACHE_KEY);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.type('application/json').send(cached);
      return;
    }
    // Read-only aggregate, allowed to be STATS_CACHE_TTL_SECONDS stale. Every write path DELs the key.
    const body = JSON.stringify(await couponStats(ctx.db));
    await ctx.cache.set(STATS_CACHE_KEY, body, ctx.config.STATS_CACHE_TTL_SECONDS);
    res.setHeader('X-Cache', 'MISS');
    res.type('application/json').send(body);
  });

  app.get('/coupons/:id', auth, async (req, res) => {
    // Passing `auth` (a plain RequestHandler<ParamsDictionary>) alongside this handler in the same
    // array widens Express 5's inferred route-param type back to ParamsDictionary, so req.params.id
    // types as `string | string[]` even though ':id' can only ever match one segment.
    const id = parseId(req.params.id as string);
    const coupon = await getCoupon(ctx.db, id, req.user!.id);
    if (!coupon) throw notFound('Coupon');
    res.json(coupon);
  });

  app.patch('/coupons/:id', auth, async (req, res) => {
    const id = parseId(req.params.id as string);
    const patch = parse(patchBody, req.body);
    const coupon = await updateCoupon(ctx.db, id, req.user!.id, patch);
    await ctx.cache.del(STATS_CACHE_KEY);
    res.json(coupon);
  });

  app.post('/coupons/:id/claims', auth, async (req, res) => {
    const id = parseId(req.params.id as string);
    const claim = await claimCoupon(ctx.db, id, req.user!.id);
    await ctx.cache.del(STATS_CACHE_KEY);
    res.status(201).json(claim);
  });
}
