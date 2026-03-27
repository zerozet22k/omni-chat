import { logger } from "../lib/logger";
import { UserModel, WorkspaceMembershipModel, WorkspaceModel } from "../models";

class RoleModelMigrationService {
  async normalizeRoleModel() {
    const [
      clearedClientUsers,
      migratedPlatformStaffUsers,
      migratedStaffMemberships,
    ] = await Promise.all([
      UserModel.updateMany(
        { platformRole: "client" },
        { $unset: { platformRole: 1 } }
      ),
      UserModel.updateMany(
        { platformRole: { $in: ["platform_staff", "dev_staff"] } },
        { $set: { platformRole: "staff" } }
      ),
      WorkspaceMembershipModel.updateMany(
        { role: "staff" },
        { $set: { role: "agent" } }
      ),
    ]);
    const workspaces = await WorkspaceModel.find({
      createdByUserId: { $ne: null },
    }).select("_id createdByUserId");

    const promoteOwnerResult = workspaces.length
      ? await WorkspaceMembershipModel.bulkWrite(
          workspaces.map((workspace) => ({
            updateOne: {
              filter: {
                workspaceId: workspace._id,
                userId: workspace.createdByUserId,
                role: { $ne: "owner" },
              },
              update: {
                $set: {
                  role: "owner",
                },
              },
            },
          })),
          { ordered: false }
        )
      : null;

    const demoteForeignOwnerResult = workspaces.length
      ? await WorkspaceMembershipModel.bulkWrite(
          workspaces.map((workspace) => ({
            updateMany: {
              filter: {
                workspaceId: workspace._id,
                userId: { $ne: workspace.createdByUserId },
                role: "owner",
              },
              update: {
                $set: {
                  role: "admin",
                },
              },
            },
          })),
          { ordered: false }
        )
      : null;

    logger.info("Role model migration complete", {
      clearedClientUsers: clearedClientUsers.modifiedCount,
      migratedPlatformStaffUsers: migratedPlatformStaffUsers.modifiedCount,
      migratedStaffMemberships: migratedStaffMemberships.modifiedCount,
      promotedWorkspaceOwners: promoteOwnerResult?.modifiedCount ?? 0,
      demotedForeignWorkspaceOwners: demoteForeignOwnerResult?.modifiedCount ?? 0,
    });
  }
}

export const roleModelMigrationService = new RoleModelMigrationService();
