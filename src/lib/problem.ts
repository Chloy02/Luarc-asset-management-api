import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';

/** An HTTP error the client should see, rendered as RFC 9457 problem details. */
export class HttpProblem extends Error {
  public readonly status: number;
  public readonly slug: string;
  public readonly title: string;
  public readonly detail?: string;
  public readonly extra: Record<string, unknown>;

  constructor(status: number, slug: string, title: string, detail?: string, extra: Record<string, unknown> = {}) {
    super(detail ?? title);
    this.name = 'HttpProblem';
    this.status = status;
    this.slug = slug;
    this.title = title;
    this.detail = detail;
    this.extra = extra;
  }
}

export function notFound(what = 'Resource'): HttpProblem {
  return new HttpProblem(404, 'not-found', 'Not found', `${what} not found.`);
}

type Mapping = [status: number, slug: string, title: string, detail: string];

// The only place in the codebase that knows pg error codes and constraint names.
// Constraint names come from src/db/migrations/0001_init.ts.
const UNIQUE_VIOLATIONS: Record<string, Mapping> = {
  users_email_key: [409, 'email-taken', 'Email already registered', 'An account with this email already exists.'],
  coupons_code_key: [409, 'code-taken', 'Coupon code already exists', 'Choose a different coupon code.'],
  claims_coupon_id_user_id_key: [409, 'already-claimed', 'Coupon already claimed', 'You have already claimed this coupon.'],
};
const FK_VIOLATIONS: Record<string, Mapping> = {
  claims_coupon_id_fkey: [404, 'not-found', 'Not found', 'Coupon not found.'],
  claims_user_id_fkey: [403, 'unknown-user', 'Unknown user', 'No user exists for this token.'],
  coupons_created_by_fkey: [403, 'unknown-user', 'Unknown user', 'No user exists for this token.'],
};
const CHECK_VIOLATIONS: Record<string, Mapping> = {
  coupons_claimed_within_total: [
    422,
    'quantity-below-claimed',
    'Quantity below claimed count',
    'total_quantity cannot be lower than the number of claims already made.',
  ],
};

export function mapPgError(err: unknown): HttpProblem | null {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  if (!e || typeof e.code !== 'string' || typeof e.constraint !== 'string') return null;
  const table =
    e.code === '23505' ? UNIQUE_VIOLATIONS : e.code === '23503' ? FK_VIOLATIONS : e.code === '23514' ? CHECK_VIOLATIONS : null;
  const hit = table?.[e.constraint];
  return hit ? new HttpProblem(...hit) : null;
}

function toProblem(err: unknown): HttpProblem {
  if (err instanceof HttpProblem) return err;
  const mapped = mapPgError(err);
  if (mapped) return mapped;
  const e = err as { type?: string } | null;
  if (e?.type === 'entity.parse.failed') {
    return new HttpProblem(400, 'invalid-json', 'Malformed JSON', 'Request body is not valid JSON.');
  }
  if (e?.type === 'entity.too.large') {
    return new HttpProblem(413, 'payload-too-large', 'Payload too large', 'Request body exceeds 100kb.');
  }
  return new HttpProblem(500, 'internal', 'Internal server error', 'Something went wrong. Quote the request_id when reporting it.');
}

export const notFoundHandler: RequestHandler = (req) => {
  throw notFound(`Route ${req.method} ${req.path}`);
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  // Express identifies error middleware by arity, so all four parameters must be declared.
  return (err, req, res, _next) => {
    const problem = toProblem(err);
    const requestId = String(req.id ?? '');
    if (problem.status >= 500) {
      (req.log ?? logger).error({ err, request_id: requestId }, 'unhandled error');
    }
    if (problem.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    res
      .status(problem.status)
      .type('application/problem+json')
      .json({
        type: `/problems/${problem.slug}`,
        title: problem.title,
        status: problem.status,
        detail: problem.detail,
        instance: req.originalUrl,
        request_id: requestId,
        ...problem.extra,
      });
  };
}
