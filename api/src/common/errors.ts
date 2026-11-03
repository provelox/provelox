/** Expected failures with a message meant for the user. Mapped to HTTP statuses by the exception filter. */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message, 404, 'not_found');
  }
}
export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 409, 'conflict');
  }
}
export class ValidationError extends DomainError {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message, 400, 'invalid');
  }
}
export class UnauthorizedError extends DomainError {
  constructor(message = 'Not signed in') {
    super(message, 401, 'unauthorized');
  }
}
/** Signed in, but the credential used is not allowed to do this. */
export class ForbiddenError extends DomainError {
  constructor(message = 'This token is not allowed to do that.') {
    super(message, 403, 'forbidden');
  }
}
export class TooManyRequestsError extends DomainError {
  constructor(message: string) {
    super(message, 429, 'rate_limited');
  }
}
/** A Docker resource exists but this service cannot prove it owns it, so it refuses to touch it. */
export class OwnershipError extends DomainError {
  constructor(message: string) {
    super(message, 409, 'not_owned');
  }
}
