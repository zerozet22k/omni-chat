import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { UnauthorizedError } from "../../lib/errors";
import { emitRealtimeEvent, syncRealtimeUserProfile } from "../../lib/realtime";
import { hasPortalAccess, serializePlatformRole } from "../../lib/platform-role";
import { UserDocument } from "../../models";

const router = Router();

const updateAccountSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const resolveActorKind = (params: {
  hasPortalRole: boolean;
  workspaceCount: number;
}) => {
  if (params.hasPortalRole && params.workspaceCount > 0) {
    return "hybrid_user" as const;
  }

  if (params.hasPortalRole) {
    return "platform_user" as const;
  }

  return "workspace_user" as const;
};

const serializeAccount = (user: UserDocument, workspaceCount: number) => {
  const platformRole = serializePlatformRole(user.platformRole);

  return {
    _id: String(user._id),
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
    actorKind: resolveActorKind({
      hasPortalRole: hasPortalAccess(user.platformRole),
      workspaceCount,
    }),
    platformRole,
    authProvider:
      user.authProvider === "google" || user.authProvider === "hybrid"
        ? user.authProvider
        : "password",
    workspaceCount,
  };
};

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const authUser = req.auth?.user;
    if (!authUser) {
      throw new UnauthorizedError("Authentication required");
    }

    res.json({
      account: serializeAccount(authUser, authUser.workspaceIds.length),
    });
  })
);

router.patch(
  "/",
  asyncHandler(async (req, res) => {
    const authUser = req.auth?.user;
    if (!authUser) {
      throw new UnauthorizedError("Authentication required");
    }

    const payload = updateAccountSchema.parse(req.body);
    authUser.name = payload.name;
    await authUser.save();

    syncRealtimeUserProfile({
      userId: String(authUser._id),
      userName: authUser.name,
    });

    const workspaceIds = Array.from(
      new Set(
        authUser.workspaceIds
          .map((workspaceId) => String(workspaceId))
          .filter(Boolean)
      )
    );

    for (const workspaceId of workspaceIds) {
      emitRealtimeEvent("user.updated", {
        workspaceId,
        user: {
          _id: String(authUser._id),
          name: authUser.name,
          avatarUrl: authUser.avatarUrl ?? null,
        },
      });
    }

    res.json({
      account: serializeAccount(authUser, authUser.workspaceIds.length),
    });
  })
);

export default router;
