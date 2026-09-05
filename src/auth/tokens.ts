import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Config } from '../config.ts';

export interface AuthUser {
  id: string;
  email: string;
}

export interface Tokens {
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  signAccess(user: AuthUser): Promise<string>;
  verifyAccess(token: string): Promise<AuthUser>;
  newRefreshToken(): { token: string; hash: string };
  hashRefreshToken(token: string): string;
}

export function createTokens(config: Config): Tokens {
  const secret = new TextEncoder().encode(config.JWT_SECRET);
  const hashRefreshToken = (token: string) => createHash('sha256').update(token).digest('hex');

  return {
    accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlSeconds: config.REFRESH_TOKEN_TTL_SECONDS,

    // Claim shape follows Supabase Auth (sub, email, role, aud, iss) so a client written
    // against Supabase tokens reads ours unchanged. Nothing in this codebase depends on it.
    signAccess(user) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ email: user.email, role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(user.id)
        .setIssuer(config.JWT_ISSUER)
        .setAudience(config.JWT_AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + config.ACCESS_TOKEN_TTL_SECONDS)
        .sign(secret);
    },

    async verifyAccess(token) {
      // Explicit algorithm allow-list: alg=none and algorithm confusion are rejected by construction.
      const { payload } = await jwtVerify(token, secret, {
        algorithms: ['HS256'],
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
      });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
        throw new Error('token missing sub or email');
      }
      return { id: payload.sub, email: payload.email };
    },

    // Opaque 256-bit token, returned to the client once; only its SHA-256 is stored.
    newRefreshToken() {
      const token = randomBytes(32).toString('base64url');
      return { token, hash: hashRefreshToken(token) };
    },

    hashRefreshToken,
  };
}
