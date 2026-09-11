import { z, type ZodType } from 'zod';
import { HttpProblem, notFound } from './problem.ts';

/** Parse untrusted input or throw a 400 problem listing every issue. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpProblem(400, 'validation-error', 'Request validation failed', 'One or more fields are invalid.', {
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

const uuid = z.uuid();

/** A path id that is not a UUID cannot exist, so it is a 404, not a 400. */
export function parseId(raw: string): string {
  const result = uuid.safeParse(raw);
  if (!result.success) throw notFound();
  return result.data;
}
