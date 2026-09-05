import { z } from 'zod';
import { HttpProblem } from './problem.ts';

export const pageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
};

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

// Cursors are opaque to clients: base64url of the last row's sort key.
export function encodeCursor(value: string | number): string {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

const badCursor = () => new HttpProblem(400, 'validation-error', 'Invalid cursor', 'The cursor is malformed. Start again without one.');

export function decodeStringCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw badCursor();
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded) throw badCursor();
  return decoded;
}

export function decodeIntCursor(cursor: string): number {
  const n = Number(decodeStringCursor(cursor));
  if (!Number.isSafeInteger(n) || n < 0) throw badCursor();
  return n;
}

/** Callers fetch limit + 1 rows; this trims the extra and derives next_cursor from the last kept row. */
export function page<T>(rows: T[], limit: number, key: (row: T) => string | number): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, next_cursor: hasMore && last !== undefined ? encodeCursor(key(last)) : null };
}
