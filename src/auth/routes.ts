import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import type { Db } from '../db/index.ts';
import { HttpProblem, notFound } from '../lib/problem.ts';
import { rateLimit } from '../lib/redis.ts';
import { parse } from '../lib/validate.ts';
import { requireAuth } from './middleware.ts';
import { hashPassword, verifyPassword } from './passwords.ts';
import type { AuthUser } from './tokens.ts';

const credentials = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(8).max(128),
});
const refreshBody = z.object({ refresh_token: z.string().min(20).max(200) });

export interface TokenPair {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

/** Mint an access token and persist a new refresh token. Pass a transaction to make it atomic with other writes. */
export async function issueTokenPair(ctx: AppContext, user: AuthUser, db: Db = ctx.db): Promise<TokenPair> {
  const { token, hash } = ctx.tokens.newRefreshToken();
  await db
    .insertInto('refresh_tokens')
    .values({ user_id: user.id, token_hash: hash, expires_at: new Date(Date.now() + ctx.tokens.refreshTtlSeconds * 1000) })
    .execute();
  return {
    access_token: await ctx.tokens.signAccess(user),
    token_type: 'Bearer',
    expires_in: ctx.tokens.accessTtlSeconds,
    refresh_token: token,
  };
}

const invalidCredentials = () =>
  new HttpProblem(401, 'invalid-credentials', 'Invalid credentials', 'Email or password is incorrect.');
const invalidRefresh = () =>
  new HttpProblem(401, 'invalid-refresh-token', 'Invalid refresh token', 'The refresh token is unknown, expired, or revoked.');

export function registerAuthRoutes(app: Express, ctx: AppContext): void {
  const { db, tokens, config } = ctx;

  // Verified against when the email is unknown so response time does not reveal account existence.
  const dummyHash = hashPassword(randomBytes(16).toString('hex'));

  app.use(
    '/auth',
    rateLimit(ctx.redis, ctx.logger, {
      max: config.RATE_LIMIT_AUTH_MAX,
      windowSeconds: config.RATE_LIMIT_AUTH_WINDOW_SECONDS,
      prefix: 'rl:auth',
    }),
  );

  app.post('/auth/register', async (req, res) => {
    const { email, password } = parse(credentials, req.body);
    const password_hash = await hashPassword(password);
    // A duplicate email raises 23505 on users_email_key → mapped to 409 email-taken.
    const user = await db
      .insertInto('users')
      .values({ email, password_hash })
      .returning(['id', 'email', 'created_at'])
      .executeTakeFirstOrThrow();
    res.status(201).json({ user, ...(await issueTokenPair(ctx, user)) });
  });

  app.post('/auth/login', async (req, res) => {
    const { email, password } = parse(credentials, req.body);
    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'created_at', 'password_hash'])
      .where('email', '=', email)
      .executeTakeFirst();
    const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash));
    if (!user || !ok) throw invalidCredentials();
    const { password_hash: _omit, ...publicUser } = user;
    res.json({ user: publicUser, ...(await issueTokenPair(ctx, user)) });
  });

  app.post('/auth/refresh', async (req, res) => {
    const { refresh_token } = parse(refreshBody, req.body);
    const hash = tokens.hashRefreshToken(refresh_token);

    // Returns 'invalid' instead of throwing so the reuse-detection revocation below COMMITS.
    // Throwing inside the callback would roll it back.
    const outcome = await db.transaction().execute(async (trx): Promise<TokenPair | 'invalid'> => {
      // Unlocked read, only to learn whose row this is.
      const owner = await trx.selectFrom('refresh_tokens').select('user_id').where('token_hash', '=', hash).executeTakeFirst();
      if (!owner) return 'invalid';
      // Lock order: users row → refresh_tokens rows. Every refresh for this user serialises here,
      // so the multi-row family revocation below can never deadlock with a concurrent refresh.
      await trx.selectFrom('users').select('id').where('id', '=', owner.user_id).forUpdate().execute();

      // Re-read under FOR UPDATE: the token's state may have changed while we waited for the user lock.
      const row = await trx.selectFrom('refresh_tokens').selectAll().where('token_hash', '=', hash).forUpdate().executeTakeFirst();
      if (!row) return 'invalid';
      if (row.revoked_at) {
        // Replay of a rotated token: someone holds a stolen copy. Revoke every live token for the user.
        await trx
          .updateTable('refresh_tokens')
          .set({ revoked_at: sql<Date>`now()` })
          .where('user_id', '=', row.user_id)
          .where('revoked_at', 'is', null)
          .execute();
        return 'invalid';
      }
      if (row.expires_at.getTime() <= Date.now()) return 'invalid';

      await trx.updateTable('refresh_tokens').set({ revoked_at: sql<Date>`now()` }).where('id', '=', row.id).execute();
      const user = await trx.selectFrom('users').select(['id', 'email']).where('id', '=', row.user_id).executeTakeFirstOrThrow();
      return issueTokenPair(ctx, user, trx);
    });

    if (outcome === 'invalid') throw invalidRefresh();
    res.json(outcome);
  });

  app.post('/auth/logout', async (req, res) => {
    const { refresh_token } = parse(refreshBody, req.body);
    await db
      .updateTable('refresh_tokens')
      .set({ revoked_at: sql<Date>`now()` })
      .where('token_hash', '=', tokens.hashRefreshToken(refresh_token))
      .where('revoked_at', 'is', null)
      .execute();
    res.status(204).end();
  });

  app.get('/me', requireAuth(tokens), async (req, res) => {
    const user = await db.selectFrom('users').select(['id', 'email', 'created_at']).where('id', '=', req.user!.id).executeTakeFirst();
    if (!user) throw notFound('User');
    res.json(user);
  });
}
