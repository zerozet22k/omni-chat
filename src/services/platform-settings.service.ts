import { ValidationError } from "../lib/errors";
import { isStripeConfigured } from "../lib/stripe";
import { PlatformSettingsModel, type PlatformSettingsDocument } from "../models/platform-settings.model";

const DEFAULT_CONTACT_EMAIL = "elqenzero@gmail.com";

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const normalizeEmail = (value: unknown, fallback = DEFAULT_CONTACT_EMAIL) =>
  trimString(value) || fallback;

export type PaymentProviderSummary = {
  stripe: {
    enabled: boolean;
    configured: boolean;
    available: boolean;
  };
  manualEmail: {
    enabled: boolean;
    available: boolean;
    contactEmail: string | null;
  };
  kbzpay: {
    enabled: boolean;
    available: boolean;
    contactEmail: string | null;
  };
};

type PaymentSettingsUpdate = {
  stripe?: {
    enabled?: boolean;
  };
  manualEmail?: {
    enabled?: boolean;
    contactEmail?: string;
  };
  kbzpay?: {
    enabled?: boolean;
    contactEmail?: string;
  };
};

class PlatformSettingsService {
  private async ensureSettingsDocument() {
    let settings = await PlatformSettingsModel.findOne({ singletonKey: "default" });
    if (!settings) {
      settings = await PlatformSettingsModel.create({ singletonKey: "default" });
    }

    return settings;
  }

  private applyDefaults(settings: PlatformSettingsDocument) {
    if (!settings.payments) {
      settings.payments = {
        stripe: { enabled: true },
        manualEmail: {
          enabled: true,
          contactEmail: DEFAULT_CONTACT_EMAIL,
        },
        kbzpay: {
          enabled: false,
          contactEmail: DEFAULT_CONTACT_EMAIL,
        },
      };
    }

    if (!settings.payments.stripe) {
      settings.payments.stripe = { enabled: true };
    }

    if (!settings.payments.manualEmail) {
      settings.payments.manualEmail = {
        enabled: true,
        contactEmail: DEFAULT_CONTACT_EMAIL,
      };
    }

    if (!settings.payments.kbzpay) {
      settings.payments.kbzpay = {
        enabled: false,
        contactEmail: DEFAULT_CONTACT_EMAIL,
      };
    }

    settings.payments.manualEmail.contactEmail = normalizeEmail(
      settings.payments.manualEmail.contactEmail
    );
    settings.payments.kbzpay.contactEmail = normalizeEmail(
      settings.payments.kbzpay.contactEmail,
      normalizeEmail(settings.payments.manualEmail.contactEmail)
    );

    return settings;
  }

  async getSettings() {
    const settings = await this.ensureSettingsDocument();
    const normalized = this.applyDefaults(settings);
    if (normalized.isModified()) {
      await normalized.save();
    }
    return normalized;
  }

  async getPaymentProviderSummary(): Promise<PaymentProviderSummary> {
    const settings = await this.getSettings();
    const payments = this.applyDefaults(settings).payments!;
    const stripeEnabled = payments.stripe!.enabled !== false;
    const stripeConfigured = isStripeConfigured();
    const manualEmail = normalizeEmail(payments.manualEmail!.contactEmail);
    const kbzpayEmail = normalizeEmail(
      payments.kbzpay!.contactEmail,
      manualEmail
    );

    return {
      stripe: {
        enabled: stripeEnabled,
        configured: stripeConfigured,
        available: stripeEnabled && stripeConfigured,
      },
      manualEmail: {
        enabled: payments.manualEmail!.enabled !== false,
        available: payments.manualEmail!.enabled !== false && manualEmail.length > 0,
        contactEmail: manualEmail || null,
      },
      kbzpay: {
        enabled: payments.kbzpay!.enabled === true,
        available: payments.kbzpay!.enabled === true && kbzpayEmail.length > 0,
        contactEmail: kbzpayEmail || null,
      },
    };
  }

  async updatePaymentSettings(input: PaymentSettingsUpdate) {
    const settings = await this.getSettings();
    const payments = this.applyDefaults(settings).payments!;

    if (typeof input.stripe?.enabled === "boolean") {
      payments.stripe!.enabled = input.stripe.enabled;
    }

    if (typeof input.manualEmail?.enabled === "boolean") {
      payments.manualEmail!.enabled = input.manualEmail.enabled;
    }

    if (typeof input.manualEmail?.contactEmail === "string") {
      payments.manualEmail!.contactEmail = normalizeEmail(
        input.manualEmail.contactEmail
      );
    }

    if (typeof input.kbzpay?.enabled === "boolean") {
      payments.kbzpay!.enabled = input.kbzpay.enabled;
    }

    if (typeof input.kbzpay?.contactEmail === "string") {
      payments.kbzpay!.contactEmail = normalizeEmail(
        input.kbzpay.contactEmail,
        normalizeEmail(payments.manualEmail!.contactEmail)
      );
    }

    await settings.save();
    return this.getPaymentProviderSummary();
  }

  async assertStripeCheckoutEnabled() {
    const paymentProviders = await this.getPaymentProviderSummary();
    if (!paymentProviders.stripe.enabled) {
      throw new ValidationError("Stripe billing is currently disabled by the platform.");
    }
    if (!paymentProviders.stripe.configured) {
      throw new ValidationError("Stripe billing is not configured on this deployment yet.");
    }
  }
}

export const platformSettingsService = new PlatformSettingsService();
