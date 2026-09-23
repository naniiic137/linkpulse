/** A typed application error that the HTTP layer maps to `{ error: { code, message } }`. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Forbidden') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);

/** Thrown by stores when a unique constraint (code, email, key hash) is violated. */
export class UniqueViolation extends Error {
  constructor(readonly field: string) {
    super(`Unique constraint violated on ${field}`);
    this.name = 'UniqueViolation';
  }
}
