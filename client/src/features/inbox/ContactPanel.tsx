import { useState } from "react";
import { Contact, Conversation } from "../../types/models";
import { apiRequest } from "../../services/api";
import { ChannelBadge } from "./ChannelBadge";

type UpdateConversationResponse =
  | Conversation
  | { conversation: Conversation };

function isConversation(value: unknown): value is Conversation {
  return (
    typeof value === "object" &&
    value !== null &&
    "_id" in value &&
    "workspaceId" in value &&
    "channel" in value &&
    "status" in value &&
    "aiState" in value
  );
}

type InfoBlockProps = {
  label: string;
  children: React.ReactNode;
};

function InfoBlock({ label, children }: InfoBlockProps) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
        {label}
      </p>
      <div className="mt-3 text-sm text-slate-900">{children}</div>
    </article>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
      {children}
    </span>
  );
}

function ActionButton(props: {
  children: React.ReactNode;
  onClick: () => Promise<void> | void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
}) {
  const { children, onClick, disabled, variant = "secondary" } = props;

  const styles =
    variant === "primary"
      ? "bg-slate-900 text-white hover:bg-slate-800"
      : variant === "danger"
        ? "bg-amber-50 text-amber-900 ring-1 ring-amber-200 hover:bg-amber-100"
        : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100";

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled}
      className={`inline-flex items-center justify-center rounded-xl px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${styles}`}
    >
      {children}
    </button>
  );
}

const humanReadableAIState: Record<string, string> = {
  idle: "Bot active",
  suggesting: "Suggesting",
  auto_replied: "Auto replied",
  needs_human: "Needs human",
  human_requested: "Human requested",
  human_active: "Human active",
};

export function ContactPanel(props: {
  contact: Contact | null;
  conversation: Conversation | null;
  currentUserId?: string | null;
  onConversationUpdated?: (conversation: Conversation) => void;
}) {
  const { contact, conversation, currentUserId, onConversationUpdated } = props;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
        <div>
          <p className="text-sm font-medium text-slate-900">No contact selected</p>
          <p className="mt-1 text-sm text-slate-500">
            Select a conversation to inspect the customer profile.
          </p>
        </div>
      </div>
    );
  }

  const phones = contact?.phones ?? [];
  const identities = contact?.channelIdentities ?? [];
  const tags = conversation.tags ?? [];
  const aiState = conversation.aiState ?? "idle";

  const patchConversation = async (patch: Record<string, unknown>) => {
    setIsSubmitting(true);
    setActionError(null);

    try {
      const data = await apiRequest<UpdateConversationResponse>(
        `/api/conversations/${conversation._id}`,
        {
          method: "PATCH",
          body: JSON.stringify(patch),
        }
      );

      let updatedConversation: Conversation | null = null;

      if (isConversation(data)) {
        updatedConversation = data;
      } else if (
        typeof data === "object" &&
        data !== null &&
        "conversation" in data &&
        isConversation((data as { conversation?: unknown }).conversation)
      ) {
        updatedConversation = (data as { conversation: Conversation }).conversation;
      }

      if (!updatedConversation) {
        throw new Error("Unexpected conversation response");
      }

      onConversationUpdated?.(updatedConversation);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Failed to update conversation"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTakeOver = async () => {
    await patchConversation({
      status: "pending",
      aiState: "human_active",
      assigneeUserId: currentUserId ?? null,
      tags: Array.from(new Set([...(conversation.tags ?? []), "needs_human"])),
    });
  };

  const handleReturnToBot = async () => {
    await patchConversation({
      status: "open",
      aiState: "idle",
      assigneeUserId: null,
      tags: (conversation.tags ?? []).filter((tag) => tag !== "needs_human"),
    });
  };

  const handleRequestHuman = async () => {
    await patchConversation({
      status: "pending",
      aiState: "human_requested",
      tags: Array.from(new Set([...(conversation.tags ?? []), "needs_human"])),
    });
  };

  const canTakeOver =
    aiState !== "human_active" && !isSubmitting;

  const canReturnToBot =
    (aiState === "human_active" || aiState === "human_requested") &&
    !isSubmitting;

  const canRequestHuman =
    aiState !== "human_requested" &&
    aiState !== "human_active" &&
    !isSubmitting;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="truncate text-base font-semibold text-slate-900">
              {contact?.primaryName ?? conversation.contactName ?? "Unknown contact"}
            </h4>
            <p className="mt-1 text-sm text-slate-500">
              Conversation and channel context
            </p>
          </div>

          <ChannelBadge channel={conversation.channel} />
        </div>
      </section>

      <InfoBlock label="AI control">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Pill>{humanReadableAIState[aiState] ?? aiState}</Pill>
            <Pill>Status: {conversation.status}</Pill>
          </div>

          <div className="flex flex-wrap gap-2">
            <ActionButton
              variant="primary"
              onClick={handleTakeOver}
              disabled={!canTakeOver}
            >
              {isSubmitting && aiState !== "human_active" ? "Updating..." : "Take over"}
            </ActionButton>

            <ActionButton
              onClick={handleRequestHuman}
              disabled={!canRequestHuman}
            >
              Request human
            </ActionButton>

            <ActionButton
              variant="danger"
              onClick={handleReturnToBot}
              disabled={!canReturnToBot}
            >
              Return to bot
            </ActionButton>
          </div>

          {actionError ? (
            <p className="text-sm text-red-600">{actionError}</p>
          ) : null}
        </div>
      </InfoBlock>

      <InfoBlock label="Tags">
        {tags.length ? (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <Pill key={tag}>{tag}</Pill>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No handoff tags</p>
        )}
      </InfoBlock>

      <InfoBlock label="Phones">
        {phones.length ? (
          <div className="flex flex-wrap gap-2">
            {phones.map((phone) => (
              <Pill key={phone}>{phone}</Pill>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No phone captured yet</p>
        )}
      </InfoBlock>

      <InfoBlock label="External identities">
        {identities.length ? (
          <div className="space-y-3">
            {identities.map((identity) => (
              <div
                key={`${identity.channel}-${identity.externalUserId}`}
                className="rounded-xl bg-white p-3 ring-1 ring-slate-200"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm font-semibold text-slate-900">
                    {identity.displayName || identity.externalUserId}
                  </strong>
                  <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium capitalize text-slate-700 ring-1 ring-slate-200">
                    {identity.channel}
                  </span>
                </div>

                {identity.displayName ? (
                  <p className="mt-1 break-all text-xs text-slate-500">
                    {identity.externalUserId}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No identity details yet</p>
        )}
      </InfoBlock>
    </div>
  );
}