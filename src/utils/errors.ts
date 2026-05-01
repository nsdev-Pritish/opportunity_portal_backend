export class AppError extends Error {
  constructor(public readonly message: string, public readonly statusCode = 500, public readonly code?: string) {
    super(message); this.name = 'AppError';
  }
}
export class NotFoundError extends AppError {
  constructor(resource: string, id?: string | number) {
    super(id ? `${resource} '${id}' not found` : `${resource} not found`, 404, 'NOT_FOUND');
  }
}
export class ValidationError extends AppError {
  constructor(msg: string) { super(msg, 400, 'VALIDATION_ERROR'); }
}
export class UnauthorizedError extends AppError {
  constructor(msg = 'Unauthorized') { super(msg, 401, 'UNAUTHORIZED'); }
}
export class ConflictError extends AppError {
  constructor(msg: string) { super(msg, 409, 'CONFLICT'); }
}
