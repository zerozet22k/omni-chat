import { NextFunction, Request, Response } from "express";
import { ForbiddenError } from "../lib/errors";
import { PublicWorkspaceRole, hasWorkspaceRoleAccess } from "../lib/workspace-role";

export const requireRole = (roles: PublicWorkspaceRole[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const membership = req.workspaceMembership;
    if (!membership) {
      next(new ForbiddenError("Workspace membership is required"));
      return;
    }

    if (!hasWorkspaceRoleAccess(membership.role, roles)) {
      next(new ForbiddenError("You do not have permission for this action"));
      return;
    }

    next();
  };
};
