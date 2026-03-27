import Stripe from "stripe";
import { env } from "../config/env";
import { IntegrationNotReadyError } from "./errors";

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

let stripeClient: Stripe | null = null;

export const isStripeConfigured = () =>
  trimString(env.STRIPE_SECRET_KEY).length > 0 &&
  trimString(env.STRIPE_WEBHOOK_SECRET).length > 0;

export const assertStripeConfigured = (context: string) => {
  if (isStripeConfigured()) {
    return;
  }

  throw new IntegrationNotReadyError(
    `${context} requires Stripe, but STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are not fully configured.`
  );
};

export const getStripeClient = () => {
  assertStripeConfigured("Stripe billing");

  if (!stripeClient) {
    stripeClient = new Stripe(env.STRIPE_SECRET_KEY);
  }

  return stripeClient;
};

export const getStripeWebhookSecret = () => {
  assertStripeConfigured("Stripe webhook verification");
  return env.STRIPE_WEBHOOK_SECRET.trim();
};

export const getStripeBillingPortalConfigurationId = () =>
  trimString(env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID) || null;

export const getStripePublishableKey = () =>
  trimString(env.STRIPE_PUBLISHABLE_KEY) || null;
