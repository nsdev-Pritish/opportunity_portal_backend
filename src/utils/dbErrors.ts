import { AppError } from './errors.js';

/**
 * Turn a database "value too large" error into a clear 400 the user can act on.
 *
 *
 * Postgres doesn't name the column in this error, so the message is deliberately generic —
 * it applies to any field.
 * Drizzle wraps driver errors in DrizzleQueryError with the original on `.cause`; both
 * places are checked. Any other error is returned untouched.
 *
 * Returning an AppError (statusCode + code) means it is shown correctly by whichever error
 * handler serves the route — the message reaches the client in the response's `message`.
 */
export function toFriendlyDbError(err: unknown): unknown {
  const code = (err as any)?.cause?.code ?? (err as any)?.code;
  if (code === '22003') {
    return new AppError(
      'One of the values is too large to save. Please check the entered values and try again.',
      400,
      'VALUE_TOO_LARGE',
    );
  }
  return err;
}

/** For `.catch(rethrowFriendlyDbError)` on a save — rethrows, converting overflow errors. */
export function rethrowFriendlyDbError(err: unknown): never {
  throw toFriendlyDbError(err);
}
