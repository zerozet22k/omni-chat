import { Conversation } from "../../types/models";

function getPreviewText(input?: string) {
  if (!input) {
    return "New conversation";
  }

  const normalized = input.trim().toLowerCase();
  if (normalized === "[image]") return "User has sent image";
  if (normalized === "[video]") return "User has sent video";
  if (normalized === "[audio]") return "User has sent audio";
  if (normalized === "[file]") return "User has sent file";
  if (normalized === "[location]") return "User has sent location";
  if (normalized === "[contact]") return "User has sent contact";
  if (normalized === "[sticker]") return "User has sent sticker";
  if (normalized === "[emoji]") return "User has sent emoji";
  return input;
}

function ChannelIcon({ channel }: { channel: Conversation["channel"] }) {
  const src =
    channel === "telegram"
      ? "/platform-icons/telegram.svg"
      : channel === "facebook"
        ? "/platform-icons/facebook.svg"
        : channel === "viber"
          ? "/platform-icons/viber.svg"
          : "/platform-icons/tiktok.svg";

  const fallback =
    channel === "telegram"
      ? "T"
      : channel === "facebook"
        ? "F"
        : channel === "viber"
          ? "V"
          : "T";

  return (
    <span title={channel} className="inline-flex h-4 w-4 items-center justify-center overflow-hidden rounded-full bg-slate-100">
      <img
        src={src}
        alt={channel}
        className="h-full w-full object-cover"
        onError={(event) => {
          event.currentTarget.style.display = "none";
          const sibling = event.currentTarget.nextElementSibling as HTMLElement | null;
          if (sibling) {
            sibling.style.display = "inline-flex";
          }
        }}
      />
      <span className="hidden h-full w-full items-center justify-center text-[9px] font-semibold text-slate-600">
        {fallback}
      </span>
    </span>
  );
}

function formatTime(date?: string | Date): string {
  if (!date) return "";
  const d = new Date(date);
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  return isToday
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

const statusDotClass: Record<string, string> = {
  open: "bg-blue-400",
  pending: "bg-amber-400",
  resolved: "bg-emerald-400",
};

export function ConversationList(props: {
  conversations: Conversation[];
  selectedConversationId?: string;
  currentUserId?: string | null;
  onSelect: (conversation: Conversation) => void;
}) {
  if (!props.conversations.length) {
    return (
      <div className="px-4 py-8 text-center text-sm text-slate-400">
        No conversations found.
      </div>
    );
  }

  return (
    <div>
      {props.conversations.map((conversation) => {
        const isSelected = props.selectedConversationId === conversation._id;
        const unreadCount = conversation.unreadCount ?? 0;
        const initials = (conversation.contactName || "?")[0].toUpperCase();
        const avatarUrl =
          conversation.contact?.channelIdentities?.find(
            (identity) =>
              identity.channel === conversation.channel &&
              typeof identity.avatar === "string" &&
              identity.avatar.trim().length > 0
          )?.avatar ??
          conversation.contact?.channelIdentities?.find(
            (identity) =>
              typeof identity.avatar === "string" &&
              identity.avatar.trim().length > 0
          )?.avatar;

        const platforms = Array.from(
          new Set([
            conversation.channel,
            ...(conversation.contact?.channelIdentities?.map((identity) => identity.channel) ?? []),
          ])
        );

        const assigneeName = conversation.assignee?.name?.trim();
        const isManagedByCurrentUser =
          !!conversation.assignee?._id &&
          !!props.currentUserId &&
          conversation.assignee._id === props.currentUserId;

        return (
          <button
            key={conversation._id}
            type="button"
            onClick={() => props.onSelect(conversation)}
            className={[
              "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
              isSelected ? "bg-slate-100" : "hover:bg-slate-50",
            ].join(" ")}
          >
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-200 text-sm font-semibold text-slate-600">
              {initials}
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={conversation.contactName || "Contact avatar"}
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
              ) : null}
              <span
                className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white ${
                  statusDotClass[conversation.status] ?? "bg-slate-300"
                }`}
              />
            </div>

            <div className="min-w-0 flex-1">
              <div className="mb-0.5 flex items-center gap-1">
                {platforms.map((platform) => (
                  <ChannelIcon key={`${conversation._id}-${platform}`} channel={platform} />
                ))}
              </div>

              <div className="flex items-baseline justify-between gap-1">
                <span
                  className={`truncate text-sm ${
                    unreadCount > 0
                      ? "font-semibold text-slate-900"
                      : "font-medium text-slate-700"
                  }`}
                >
                  {conversation.contactName || "Unknown"}
                </span>
                <span className="shrink-0 text-[11px] text-slate-400">
                  {formatTime(conversation.lastMessageAt)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-1">
                <p className="truncate text-xs text-slate-500">
                  {getPreviewText(conversation.lastMessageText)}
                </p>
                {unreadCount > 0 ? (
                  <span className="ml-1 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-semibold leading-none text-white">
                    {unreadCount}
                  </span>
                ) : null}
              </div>

              {assigneeName ? (
                <p className="mt-0.5 truncate text-[11px] text-slate-400">
                  {isManagedByCurrentUser
                    ? "Managed by you"
                    : `Managed by ${assigneeName}`}
                </p>
              ) : null}
            </div>
          </button>
        );
      })}
    </div>
  );
}
