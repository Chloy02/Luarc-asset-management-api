import type { RequestHandler } from 'express';
import { HttpProblem } from '../lib/problem.ts';
import type { Tokens } from './tokens.ts';

/** Verifies the bearer token and sets req.user. Express 5 forwards the thrown problem to the error handler. */
export function requireAuth(tokens: Tokens): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token) throw new HttpProblem(401, 'unauthorized', 'Unauthorized', 'Missing bearer token.');
    try {
      req.user = await tokens.verifyAccess(token);
    } catch {
      throw new HttpProblem(401, 'unauthorized', 'Unauthorized', 'Invalid or expired token.');
    }
    next();
  };
}
