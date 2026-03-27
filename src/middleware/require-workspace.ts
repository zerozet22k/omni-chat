import { NextFunction, Request, Response } from "express";
import { ForbiddenError, ValidationError } from "../lib/errors";
import { WorkspaceMembershipModel, WorkspaceModel } from "../models";
import { logger } from "../lib/logger";

const resolveWorkspaceId = (req: Request): string => {
  // Primary: explicit header sent by the authenticated client.
  const headerValue = req.header("x-workspace-id")?.trim();
  if (headerValue) {
    return headerValue;
  }

  // Secondary: REST path param (e.g. /workspaces/:workspaceId/members).
  const paramValue =
    typeof req.params.workspaceId === "string"
      ? req.params.workspaceId.trim()
      : "";
  if (paramValue) {
    return paramValue;
  }

  // Fallback: query string — accepted but logged so callers can migrate.
  const queryValue =
    typeof req.query.workspaceId === "string"
      ? req.query.workspaceId.trim()
      : "";
  if (queryValue) {
    logger.warn("requireWorkspace: workspaceId resolved from query string — prefer x-workspace-id header", {
      path: req.path,
    });
    return queryValue;
  }

  // Body fallback removed: workspaceId in request body is not a supported pattern.
  // All routes that previously relied on this have been updated to use the header.
  return "";
};

export const requireWorkspace = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  if (!req.auth?.userId) {
    next(new ForbiddenError("Request is not authenticated"));
    return;
  }

  const workspaceId = resolveWorkspaceId(req);
  if (!workspaceId) {
    next(new ValidationError("workspaceId is required"));
    return;
  }

  const [workspaceMembership, workspace] = await Promise.all([
    WorkspaceMembershipModel.findOne({
      workspaceId,
      userId: req.auth.userId,
      status: "active",
    }),
    WorkspaceModel.findById(workspaceId),
  ]);

  if (!workspace) {
    next(new ValidationError("Workspace not found"));
    return;
  }

  if (!workspaceMembership) {
    next(new ForbiddenError("You do not have access to this workspace"));
    return;
  }

  workspaceMembership.lastActiveAt = new Date();
  await workspaceMembership.save();

  req.workspace = workspace;
  req.workspaceMembership = workspaceMembership;
  next();
};
