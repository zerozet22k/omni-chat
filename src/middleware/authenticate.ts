import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { UnauthorizedError } from "../lib/errors";
import { UserModel } from "../models";

type AuthTokenPayload = {
  userId: string;
  email: string;
  iat?: number;
  exp?: number;
};

const extractBearer = (authorizationHeader: string | undefined) => {
  if (!authorizationHeader) {
    return "";
  }

  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return "";
  }

  return token;
};

export const authenticate = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  const token = extractBearer(req.header("authorization"));
  if (!token) {
    next(new UnauthorizedError("Missing bearer token"));
    return;
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
    if (!decoded.userId || !decoded.email) {
      next(new UnauthorizedError("Invalid authentication token"));
      return;
    }

    const user = await UserModel.findById(decoded.userId);
    if (!user) {
      next(new UnauthorizedError("Authenticated user no longer exists"));
      return;
    }

    req.auth = {
      userId: decoded.userId,
      email: decoded.email,
      user,
    };

    next();
  } catch (error) {
    next(new UnauthorizedError("Invalid or expired token", error));
  }
};
