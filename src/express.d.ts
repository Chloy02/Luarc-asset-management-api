import type { AuthUser } from './auth/tokens.ts';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
