import { logger } from "../lib/logger";
import { BillingAccountModel, UserModel } from "../models";

class BillingAccountMigrationService {
  async normalizeBillingAccounts() {
    let droppedLegacyOwnerIndex = false;

    try {
      const indexes = await BillingAccountModel.collection.indexes();
      const legacyUniqueOwnerIndex = indexes.find((index) => {
        const key = index.key as Record<string, number> | undefined;
        return (
          !!index.unique &&
          !!key &&
          Object.keys(key).length === 1 &&
          key.ownerUserId === 1
        );
      });

      if (legacyUniqueOwnerIndex?.name) {
        await BillingAccountModel.collection.dropIndex(legacyUniqueOwnerIndex.name);
        droppedLegacyOwnerIndex = true;
      }
    } catch (error) {
      logger.warn("Billing account migration could not inspect/drop legacy indexes", {
        error,
      });
    }

    try {
      await BillingAccountModel.collection.createIndex(
        { ownerUserId: 1 },
        { name: "ownerUserId_1" }
      );
    } catch (error) {
      logger.warn("Billing account migration could not ensure ownerUserId index", {
        error,
      });
    }

    const users = await UserModel.find({
      $or: [{ defaultBillingAccountId: null }, { defaultBillingAccountId: { $exists: false } }],
    }).select("_id defaultBillingAccountId");

    let defaultedUsers = 0;

    for (const user of users) {
      const earliestBillingAccount = await BillingAccountModel.findOne({
        ownerUserId: user._id,
      }).sort({ createdAt: 1 });

      if (!earliestBillingAccount) {
        continue;
      }

      user.defaultBillingAccountId = earliestBillingAccount._id;
      await user.save();
      defaultedUsers += 1;
    }

    logger.info("Billing account migration complete", {
      droppedLegacyOwnerIndex,
      defaultedUsers,
    });
  }
}

export const billingAccountMigrationService = new BillingAccountMigrationService();
