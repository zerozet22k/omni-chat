import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";

export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: error.flatten(),
      },
    });
    return;
  }

  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }

  const normalizedError =
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
          ...(error && typeof error === "object" && "code" in error
            ? { code: (error as { code?: unknown }).code }
            : {}),
          ...(error && typeof error === "object" && "keyPattern" in error
            ? { keyPattern: (error as { keyPattern?: unknown }).keyPattern }
            : {}),
          ...(error && typeof error === "object" && "keyValue" in error
            ? { keyValue: (error as { keyValue?: unknown }).keyValue }
            : {}),
        }
      : { value: error };

  logger.error("Unhandled error", normalizedError);
  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal server error",
    },
  });
};
