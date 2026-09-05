import type { Express } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { requireAuth } from '../auth/middleware.ts';
import { listUserClaims } from '../coupons/service.ts';
import { pageQuery } from '../lib/pagination.ts';
import { parse } from '../lib/validate.ts';

const historyQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  coupon_status: z.enum(['active', 'disabled']).optional(),
  ...pageQuery,
});

export function registerClaimRoutes(app: Express, ctx: AppContext): void {
  app.get('/me/claims', requireAuth(ctx.tokens), async (req, res) => {
    const filters = parse(historyQuery, req.query);
    res.json(await listUserClaims(ctx.db, req.user!.id, filters));
  });
}
