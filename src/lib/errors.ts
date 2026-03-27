export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super(404, "NOT_FOUND", message, details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "VALIDATION_ERROR", message, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, details?: unknown) {
    super(403, "FORBIDDEN", message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string, details?: unknown) {
    super(401, "UNAUTHORIZED", message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, "CONFLICT", message, details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message: string, details?: unknown) {
    super(429, "TOO_MANY_REQUESTS", message, details);
  }
}

export class CapabilityError extends AppError {
  constructor(message: string, details?: unknown) {
    super(422, "CHANNEL_CAPABILITY_BLOCKED", message, details);
  }
}

export class IntegrationNotReadyError extends AppError {
  constructor(message: string, details?: unknown) {
    super(501, "INTEGRATION_NOT_READY", message, details);
  }
}
