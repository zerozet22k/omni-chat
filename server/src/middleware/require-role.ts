import { NextFunction, Request, Response } from "express";
import { ForbiddenError } from "../lib/errors";
import { WORKSPACE_MEMBER_ROLES } from "../models";

type WorkspaceRole = (typeof WORKSPACE_MEMBER_ROLES)[number];

export const requireRole = (roles: WorkspaceRole[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const membership = req.workspaceMembership;
    if (!membership) {
      next(new ForbiddenError("Workspace membership is required"));
      return;
    }

    if (!roles.includes(membership.role as WorkspaceRole)) {
      next(new ForbiddenError("You do not have permission for this action"));
      return;
    }

    next();
  };
};
