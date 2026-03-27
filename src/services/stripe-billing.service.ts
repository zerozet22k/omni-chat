import Stripe from "stripe";
import { env } from "../config/env";
import { IntegrationNotReadyError, ValidationError } from "../lib/errors";
import {
  getStripeBillingPortalConfigurationId,
  getStripeClient,
  isStripeConfigured,
} from "../lib/stripe";
import {
  BillingAccountModel,
  PlanCatalogModel,
  PlanVersionModel,
} from "../models";
import { auditLogService } from "./audit-log.service";
import { billingService, type BillingAccountStatus } from "./billing.service";

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const hasAddressFields = (value: {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}) =>
  [
    value.line1,
    value.line2,
    value.city,
    value.state,
    value.postalCode,
    value.country,
  ].some((item) => trimString(item).length > 0);

const resolveUiBaseUrl = (uiOrigin?: string | null) => {
  const candidate = trimString(uiOrigin);
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.origin.replace(/\/+$/, "");
      }
    } catch {
      // Fall back to configured client URL.
    }
  }

  return env.CLIENT_URL.trim().replace(/\/+$/, "");
};

const buildWorkspaceBillingUrl = (
  workspaceSlug: string,
  state?: "checkout_success" | "checkout_canceled" | "portal_return",
  uiOrigin?: string | null
) => {
  const baseUrl = resolveUiBaseUrl(uiOrigin);
  const url = new URL(`/workspace/${encodeURIComponent(workspaceSlug)}/billing`, baseUrl);
  if (state) {
    url.searchParams.set("stripe", state);
  }
  return url.toString();
};

const mapStripeStatus = (value: string | null | undefined): BillingAccountStatus => {
  switch (trimString(value)) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "incomplete":
    case "incomplete_expired":
    case "unpaid":
      return "past_due";
    case "paused":
      return "paused";
    case "canceled":
      return "canceled";
    default:
      return "active";
  }
};

type StripePortalFlow = "manage" | "payment_method_update";

type StripePlanSessionResult = {
  url: string;
  mode: "checkout" | "portal_subscription_update";
};

type StripePortalSessionResult = {
  url: string;
  mode: StripePortalFlow;
};

class StripeBillingService {
  isConfigured() {
    return isStripeConfigured();
  }

  private getClient() {
    return getStripeClient();
  }

  private buildCustomerParams(params: {
    billingAccountId: string;
    name: string;
    companyLegalName?: string;
    billingEmail?: string;
    billingContactName?: string;
    billingPhone?: string;
    billingAddress?: {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
    };
  }): Stripe.CustomerCreateParams {
    const name =
      trimString(params.companyLegalName) ||
      trimString(params.billingContactName) ||
      trimString(params.name) ||
      "Billing account";
    const payload: Stripe.CustomerCreateParams = {
      name,
      email: trimString(params.billingEmail) || undefined,
      phone: trimString(params.billingPhone) || undefined,
      metadata: {
        billingAccountId: params.billingAccountId,
      },
    };

    if (params.billingAddress && hasAddressFields(params.billingAddress)) {
      payload.address = {
        line1: trimString(params.billingAddress.line1) || undefined,
        line2: trimString(params.billingAddress.line2) || undefined,
        city: trimString(params.billingAddress.city) || undefined,
        state: trimString(params.billingAddress.state) || undefined,
        postal_code: trimString(params.billingAddress.postalCode) || undefined,
        country: trimString(params.billingAddress.country) || undefined,
      };
    }

    return payload;
  }

  async ensureCustomerForBillingAccount(billingAccountId: string) {
    if (!this.isConfigured()) {
      throw new IntegrationNotReadyError("Stripe billing is not configured yet.");
    }

    const billingAccount = await BillingAccountModel.findById(billingAccountId);
    if (!billingAccount) {
      throw new ValidationError("Billing account not found");
    }

    const stripe = this.getClient();
    const customerPayload = this.buildCustomerParams({
      billingAccountId: String(billingAccount._id),
      name: billingAccount.name,
      companyLegalName: trimString(billingAccount.companyLegalName),
      billingEmail: trimString(billingAccount.billingEmail),
      billingContactName: trimString(billingAccount.billingContactName),
      billingPhone: trimString(billingAccount.billingPhone),
      billingAddress: billingAccount.billingAddress ?? {},
    });

    const existingCustomerId = trimString(billingAccount.paymentProviderCustomerId);
    if (existingCustomerId) {
      try {
        const existing = await stripe.customers.retrieve(existingCustomerId);
        if (!("deleted" in existing && existing.deleted)) {
          await stripe.customers.update(
            existingCustomerId,
            customerPayload as Stripe.CustomerUpdateParams
          );
          return existing.id;
        }
      } catch {
        // Replace stale customer references with a fresh customer below.
      }
    }

    const customer = await stripe.customers.create(customerPayload);
    billingAccount.paymentProviderCustomerId = customer.id;
    await billingAccount.save();
    return customer.id;
  }

  async syncCustomerProfileIfPossible(billingAccountId: string) {
    if (!this.isConfigured()) {
      return;
    }

    await this.ensureCustomerForBillingAccount(billingAccountId);
  }

  async createPlanSession(params: {
    workspaceId: string;
    workspaceSlug: string;
    planVersionId: string;
    uiOrigin?: string | null;
  }): Promise<StripePlanSessionResult> {
    if (!this.isConfigured()) {
      throw new IntegrationNotReadyError("Stripe billing is not configured yet.");
    }

    const [context, requestedPlanVersion] = await Promise.all([
      billingService.getWorkspaceBillingState(params.workspaceId),
      PlanVersionModel.findById(params.planVersionId),
    ]);

    if (!requestedPlanVersion) {
      throw new ValidationError("Selected plan version was not found.");
    }

    const requestedPlanCatalog = await PlanCatalogModel.findById(
      requestedPlanVersion.planCatalogId
    );
    if (!requestedPlanCatalog) {
      throw new ValidationError("Selected plan catalog was not found.");
    }

    if (!requestedPlanCatalog.active || !requestedPlanVersion.active) {
      throw new ValidationError("This plan is not available for customer checkout.");
    }

    const stripePriceId = trimString(requestedPlanVersion.stripePriceId);
    if (!stripePriceId) {
      throw new IntegrationNotReadyError(
        "This plan version does not have a Stripe price attached yet."
      );
    }

    if (String(context.planVersion._id) === String(requestedPlanVersion._id)) {
      throw new ValidationError("This billing account is already on that plan version.");
    }

    const customerId = await this.ensureCustomerForBillingAccount(
      String(context.billingAccount._id)
    );
    const stripe = this.getClient();
    const returnUrl = buildWorkspaceBillingUrl(
      params.workspaceSlug,
      "portal_return",
      params.uiOrigin
    );

    if (
      context.subscription.provider === "stripe" &&
      trimString(context.subscription.providerSubscriptionId)
    ) {
      const stripeSubscription = await stripe.subscriptions.retrieve(
        trimString(context.subscription.providerSubscriptionId)
      );
      const subscriptionItem = stripeSubscription.items.data[0];
      if (!subscriptionItem) {
        throw new ValidationError(
          "The Stripe subscription does not contain a billable item to update."
        );
      }

      if (trimString(subscriptionItem.price.id) === stripePriceId) {
        throw new ValidationError("This Stripe subscription is already on that price.");
      }

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
        configuration: getStripeBillingPortalConfigurationId() ?? undefined,
        flow_data: {
          type: "subscription_update_confirm",
          after_completion: {
            type: "redirect",
            redirect: {
              return_url: returnUrl,
            },
          },
          subscription_update_confirm: {
            subscription: stripeSubscription.id,
            items: [
              {
                id: subscriptionItem.id,
                price: stripePriceId,
                quantity: subscriptionItem.quantity ?? 1,
              },
            ],
          },
        },
      });

      return {
        url: portalSession.url,
        mode: "portal_subscription_update",
      };
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: String(context.billingAccount._id),
      success_url: buildWorkspaceBillingUrl(
        params.workspaceSlug,
        "checkout_success",
        params.uiOrigin
      ),
      cancel_url: buildWorkspaceBillingUrl(
        params.workspaceSlug,
        "checkout_canceled",
        params.uiOrigin
      ),
      billing_address_collection: "auto",
      allow_promotion_codes: true,
      customer_update: {
        address: "auto",
        name: "auto",
      },
      metadata: {
        billingAccountId: String(context.billingAccount._id),
        workspaceId: params.workspaceId,
        workspaceSlug: params.workspaceSlug,
        planCatalogId: String(requestedPlanCatalog._id),
        planVersionId: String(requestedPlanVersion._id),
      },
      line_items: [
        {
          price: stripePriceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata: {
          billingAccountId: String(context.billingAccount._id),
          workspaceId: params.workspaceId,
          workspaceSlug: params.workspaceSlug,
          planCatalogId: String(requestedPlanCatalog._id),
          planVersionId: String(requestedPlanVersion._id),
        },
      },
    });

    if (!checkoutSession.url) {
      throw new ValidationError("Stripe did not return a redirect URL for checkout.");
    }

    return {
      url: checkoutSession.url,
      mode: "checkout",
    };
  }

  async createPortalSession(params: {
    workspaceId: string;
    workspaceSlug: string;
    flow?: StripePortalFlow;
    uiOrigin?: string | null;
  }): Promise<StripePortalSessionResult> {
    if (!this.isConfigured()) {
      throw new IntegrationNotReadyError("Stripe billing is not configured yet.");
    }

    const context = await billingService.getWorkspaceBillingState(params.workspaceId);
    const customerId = await this.ensureCustomerForBillingAccount(
      String(context.billingAccount._id)
    );
    const stripe = this.getClient();
    const flow = params.flow ?? "manage";
    const returnUrl = buildWorkspaceBillingUrl(
      params.workspaceSlug,
      "portal_return",
      params.uiOrigin
    );

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      configuration: getStripeBillingPortalConfigurationId() ?? undefined,
      flow_data:
        flow === "payment_method_update"
          ? {
              type: "payment_method_update",
              after_completion: {
                type: "redirect",
                redirect: {
                  return_url: returnUrl,
                },
              },
            }
          : undefined,
    });

    return {
      url: session.url,
      mode: flow,
    };
  }

  async processBillingEvent(params: {
    provider: string;
    eventId: string;
    payload: Record<string, unknown>;
  }) {
    if (params.provider !== "stripe") {
      return;
    }

    const event = params.payload as unknown as Stripe.Event;
    switch (event.type) {
      case "checkout.session.completed":
        await this.handleCheckoutSessionCompleted(
          event.data.object as Stripe.Checkout.Session,
          event.type,
          params.eventId
        );
        return;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await this.syncFromStripeSubscription(
          event.data.object as Stripe.Subscription,
          event.type,
          params.eventId
        );
        return;
      case "invoice.payment_failed":
      case "invoice.payment_succeeded":
      case "invoice.paid":
        await this.handleInvoiceEvent(
          event.data.object as Stripe.Invoice,
          event.type,
          params.eventId
        );
        return;
      default:
        return;
    }
  }

  private async handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session,
    eventType: string,
    eventId: string
  ) {
    const billingAccountId = trimString(session.metadata?.billingAccountId);
    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : trimString((session.customer as Stripe.Customer | null)?.id);
    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : trimString((session.subscription as Stripe.Subscription | null)?.id);

    if (!billingAccountId || !customerId) {
      return;
    }

    await BillingAccountModel.findByIdAndUpdate(billingAccountId, {
      $set: {
        paymentProviderCustomerId: customerId,
      },
    });

    if (subscriptionId) {
      await this.syncFromStripeSubscriptionId({
        subscriptionId,
        fallbackBillingAccountId: billingAccountId,
        fallbackCustomerId: customerId,
        eventType,
        eventId,
      });
    }
  }

  private async handleInvoiceEvent(
    invoice: Stripe.Invoice,
    eventType: string,
    eventId: string
  ) {
    const typedInvoice = invoice as Stripe.Invoice & {
      subscription?: string | Stripe.Subscription | null;
    };
    const subscriptionId =
      typeof typedInvoice.subscription === "string"
        ? typedInvoice.subscription
        : trimString((typedInvoice.subscription as Stripe.Subscription | null)?.id);
    const customerId =
      typeof invoice.customer === "string"
        ? invoice.customer
        : trimString((invoice.customer as Stripe.Customer | null)?.id);

    if (!subscriptionId) {
      return;
    }

    await this.syncFromStripeSubscriptionId({
      subscriptionId,
      fallbackCustomerId: customerId || null,
      eventType,
      eventId,
    });
  }

  private async syncFromStripeSubscription(
    subscription: Stripe.Subscription,
    eventType: string,
    eventId: string
  ) {
    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : trimString((subscription.customer as Stripe.Customer | null)?.id);
    const billingAccountId = trimString(subscription.metadata?.billingAccountId);
    const firstItem = subscription.items.data[0];

    if (!customerId && !billingAccountId) {
      return;
    }

    await this.syncSubscriptionRecord({
      subscription,
      customerId: customerId || null,
      fallbackBillingAccountId: billingAccountId || null,
      planVersionId: trimString(subscription.metadata?.planVersionId) || null,
      stripePriceId: trimString(firstItem?.price?.id) || null,
      eventType,
      eventId,
    });
  }

  private async syncFromStripeSubscriptionId(params: {
    subscriptionId: string;
    fallbackBillingAccountId?: string | null;
    fallbackCustomerId?: string | null;
    eventType: string;
    eventId: string;
  }) {
    const stripe = this.getClient();
    const subscription = await stripe.subscriptions.retrieve(params.subscriptionId);
    const firstItem = subscription.items.data[0];

    await this.syncSubscriptionRecord({
      subscription,
      customerId:
        (typeof subscription.customer === "string"
          ? subscription.customer
          : trimString((subscription.customer as Stripe.Customer | null)?.id)) ||
        params.fallbackCustomerId ||
        null,
      fallbackBillingAccountId: params.fallbackBillingAccountId ?? null,
      planVersionId: trimString(subscription.metadata?.planVersionId) || null,
      stripePriceId: trimString(firstItem?.price?.id) || null,
      eventType: params.eventType,
      eventId: params.eventId,
    });
  }

  private async syncSubscriptionRecord(params: {
    subscription: Stripe.Subscription;
    customerId: string | null;
    fallbackBillingAccountId: string | null;
    planVersionId: string | null;
    stripePriceId: string | null;
    eventType: string;
    eventId: string;
  }) {
    const billingAccountId =
      trimString(params.subscription.metadata?.billingAccountId) ||
      trimString(params.fallbackBillingAccountId);
    const customerId = trimString(params.customerId);

    let resolvedBillingAccountId = billingAccountId;
    if (!resolvedBillingAccountId && customerId) {
      const account = await BillingAccountModel.findOne({
        paymentProviderCustomerId: customerId,
      }).select("_id");
      resolvedBillingAccountId = account ? String(account._id) : "";
    }

    if (!resolvedBillingAccountId || !customerId) {
      return;
    }

    const subscriptionTiming = params.subscription as Stripe.Subscription & {
      current_period_start?: number | null;
      current_period_end?: number | null;
    };

    await billingService.syncStripeSubscriptionForBillingAccount({
      billingAccountId: resolvedBillingAccountId,
      customerId,
      providerSubscriptionId: params.subscription.id,
      status: mapStripeStatus(params.subscription.status),
      planVersionId: params.planVersionId,
      stripePriceId: params.stripePriceId,
      currentPeriodStart: subscriptionTiming.current_period_start
        ? new Date(subscriptionTiming.current_period_start * 1000)
        : null,
      currentPeriodEnd: subscriptionTiming.current_period_end
        ? new Date(subscriptionTiming.current_period_end * 1000)
        : null,
      cancelAtPeriodEnd: !!params.subscription.cancel_at_period_end,
      trialEndsAt: params.subscription.trial_end
        ? new Date(params.subscription.trial_end * 1000)
        : null,
    });

    await this.syncPaymentMethodSummary(resolvedBillingAccountId, customerId);
    await auditLogService.record({
      actorType: "system",
      eventType: "billing.stripe_subscription_synced",
      sourceHints: ["billing", "stripe", "webhook"],
      data: {
        stripeEventId: params.eventId,
        stripeEventType: params.eventType,
        billingAccountId: resolvedBillingAccountId,
        customerId,
        subscriptionId: params.subscription.id,
        status: params.subscription.status,
        priceId: params.stripePriceId,
      },
    });
  }

  private async syncPaymentMethodSummary(
    billingAccountId: string,
    customerId: string
  ) {
    const stripe = this.getClient();
    const [billingAccount, customer] = await Promise.all([
      BillingAccountModel.findById(billingAccountId),
      stripe.customers.retrieve(customerId, {
        expand: ["invoice_settings.default_payment_method"],
      }),
    ]);

    if (!billingAccount || ("deleted" in customer && customer.deleted)) {
      return;
    }

    const paymentMethod =
      customer.invoice_settings?.default_payment_method &&
      typeof customer.invoice_settings.default_payment_method !== "string"
        ? customer.invoice_settings.default_payment_method
        : null;

    billingAccount.paymentProviderCustomerId = customer.id;
    billingAccount.paymentMethodSummary = {
      provider: "stripe",
      brand:
        paymentMethod?.type === "card" ? trimString(paymentMethod.card?.brand) : "",
      last4:
        paymentMethod?.type === "card" ? trimString(paymentMethod.card?.last4) : "",
      expMonth:
        paymentMethod?.type === "card"
          ? paymentMethod.card?.exp_month ?? null
          : null,
      expYear:
        paymentMethod?.type === "card"
          ? paymentMethod.card?.exp_year ?? null
          : null,
    };
    await billingAccount.save();
  }

  async getBillingAccountStripeSummary(workspaceId: string) {
    const context = await billingService.getWorkspaceBillingState(workspaceId);
    return {
      configured: this.isConfigured(),
      customerId: trimString(context.billingAccount.paymentProviderCustomerId) || null,
      subscriptionId:
        trimString(context.subscription.providerSubscriptionId) || null,
      canOpenPortal: this.isConfigured(),
      portalConfigurationId: getStripeBillingPortalConfigurationId(),
    };
  }

  async getBillingAccountStripeSummaryById(billingAccountId: string) {
    const context = await billingService.getBillingAccountState(billingAccountId);
    return {
      configured: this.isConfigured(),
      customerId: trimString(context.billingAccount.paymentProviderCustomerId) || null,
      subscriptionId:
        trimString(context.subscription.providerSubscriptionId) || null,
      canOpenPortal: this.isConfigured(),
      portalConfigurationId: getStripeBillingPortalConfigurationId(),
    };
  }
}

export const stripeBillingService = new StripeBillingService();
