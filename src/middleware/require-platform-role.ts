import { NextFunction, Request, Response } from "express";
import { ForbiddenError } from "../lib/errors";
import { PublicPlatformRole, serializePlatformRole } from "../lib/platform-role";

type PlatformRole = PublicPlatformRole;

export const requirePlatformRole = (roles: PlatformRole[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const authUser = req.auth?.user;
    if (!authUser) {
      next(new ForbiddenError("Authenticated user is required"));
      return;
    }

    const platformRole = serializePlatformRole(authUser.platformRole);

    if (!platformRole || !roles.includes(platformRole)) {
      next(new ForbiddenError("You do not have permission for portal access"));
      return;
    }

    next();
  };
};
