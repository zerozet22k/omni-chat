import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../hooks/use-session";
import { apiRequest } from "../services/api";
import { connectWorkspaceSocket } from "../services/realtime";
import {
  INBOUND_NOTIFICATION_SOUND_DATA_URI,
  shouldPlayInboundNotification,
  type MessageReceivedRealtimePayload,
} from "../utils/inbound-notification";
import {
  AISettings,
  CannedReply,
  ChannelConnection,
  Contact,
  Conversation,
  ConversationStatus,
  Message,
  MessageKind,
} from "../types/models";
import { OutboundContentBlock } from "../types/outbound-content";
import { Composer, ComposerSendPayload } from "../features/inbox/Composer";
import { ContactPanel } from "../features/inbox/ContactPanel";
import { ConversationList } from "../features/inbox/ConversationList";
import { StickerCatalog } from "../features/inbox/sticker-catalog";
import { ThreadView } from "../features/inbox/ThreadView";
import { ToastItem, ToastStack } from "../features/ui/ToastStack";

const statusOptions: Array<ConversationStatus | "all"> = [
  "all",
  "open",
  "pending",
  "resolved",
];

const defaultSupportedChannels: Record<Conversation["channel"], boolean> = {
  facebook: true,
  telegram: true,
  viber: true,
  tiktok: true,
};

function getConnectionTone(status?: string) {
  switch (status) {
    case "active":
    case "verified":
    case "connected":
      return "emerald";
    case "pending":
      return "amber";
    case "failed":
    case "error":
      return "rose";
    default:
      return "default";
  }
}

function sortConversationsByLatest(items: Conversation[]) {
  return [...items].sort((a, b) => {
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bTime - aTime;
  });
}

function sortMessagesByTime(items: Message[]) {
  return [...items].sort((a, b) => {
    const aTime =
      "createdAt" in a && a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime =
      "createdAt" in b && b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return aTime - bTime;
  });
}

const readFileAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read attachment"));
        return;
      }
      const split = result.split(",");
      resolve(split[1] ?? "");
    };
    reader.onerror = () => reject(new Error("Failed to read attachment"));
    reader.readAsDataURL(file);
  });

const inferOutboundKind = (file: File): Extract<MessageKind, "image" | "video" | "file"> => {
  const mimeType = file.type.toLowerCase();
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  return "file";
};

const validateTikTokAttachment = (file: File) => {
  const mimeType = file.type.toLowerCase();
  const isJpeg = mimeType === "image/jpeg" || mimeType === "image/jpg";
  const isPng = mimeType === "image/png";

  if (!isJpeg && !isPng) {
    throw new Error("TikTok direct messages currently support JPG and PNG image uploads only.");
  }

  if (file.size > 3 * 1024 * 1024) {
    throw new Error("TikTok direct messages limit image uploads to 3 MB.");
  }
};

export function InboxPage() {
  const { session, activeWorkspace } = useSession();
  const workspaceId = activeWorkspace?._id;

  const [status, setStatus] = useState<ConversationStatus | "all">("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");

  const [contact, setContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [connections, setConnections] = useState<ChannelConnection[]>([]);
  const [cannedReplies, setCannedReplies] = useState<CannedReply[]>([]);
  const [isContactPanelOpen, setIsContactPanelOpen] = useState(false);

  const [isBooting, setIsBooting] = useState(true);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [isLoadingThread, setIsLoadingThread] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [isDeletingChatUser, setIsDeletingChatUser] = useState(false);

  const [pageError, setPageError] = useState<string | null>(null);
  const [sendError, setSendError] = useState("");
  const [stickerCatalog, setStickerCatalog] = useState<StickerCatalog | null>(null);
  const [stickerCatalogError, setStickerCatalogError] = useState<string | null>(null);
  const [isLoadingStickerCatalog, setIsLoadingStickerCatalog] = useState(false);
  const [supportedChannels, setSupportedChannels] = useState<
    Record<Conversation["channel"], boolean>
  >(defaultSupportedChannels);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [notificationsMuted, setNotificationsMuted] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem("omni-chat-notifications-muted") === "true";
  });

  const notificationAudioRef = useRef<HTMLAudioElement | null>(null);
  const playedInboundMessageIdsRef = useRef<Set<string>>(new Set());

  const pushToast = useCallback((toast: Omit<ToastItem, "id">) => {
    const next: ToastItem = {
      ...toast,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    setToasts((current) => [...current.slice(-3), next]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [searchInput]);

  useEffect(() => {
    notificationAudioRef.current = new Audio(INBOUND_NOTIFICATION_SOUND_DATA_URI);
    notificationAudioRef.current.preload = "auto";
    notificationAudioRef.current.volume = 0.45;
    return () => {
      notificationAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      "omni-chat-notifications-muted",
      notificationsMuted ? "true" : "false"
    );
  }, [notificationsMuted]);

  const selectedConversation = useMemo(
    () =>
      conversations.find((item) => item._id === selectedConversationId) ?? null,
    [conversations, selectedConversationId]
  );

  const selectedConnection = useMemo(
    () =>
      connections.find(
        (item) =>
          item.channel === selectedConversation?.channel &&
          item.externalAccountId === selectedConversation?.channelAccountId
      ) ?? null,
    [connections, selectedConversation]
  );

  const loadConversations = useCallback(async () => {
    if (!workspaceId) return;

    const response = await apiRequest<{ items: Conversation[] }>(
      "/api/conversations",
      {},
      {
        workspaceId,
        status: status === "all" ? undefined : status,
        search: search || undefined,
      }
    );

    setConversations(sortConversationsByLatest(response.items));
  }, [workspaceId, status, search]);

  const loadConnections = useCallback(async () => {
    if (!workspaceId) return;

    const response = await apiRequest<{ items: ChannelConnection[] }>(
      "/api/channels",
      {},
      { workspaceId }
    );

    setConnections(response.items);
  }, [workspaceId]);

  const loadMessages = useCallback(async (conversationId: string) => {
    const response = await apiRequest<{ items: Message[] }>(
      `/api/conversations/${conversationId}/messages`
    );

    setMessages(sortMessagesByTime(response.items));
  }, []);

  const loadContact = useCallback(async (contactId?: string) => {
    if (!contactId) {
      setContact(null);
      return;
    }

    const response = await apiRequest<{ contact: Contact }>(
      `/api/contacts/${contactId}`
    );
    setContact(response.contact);
  }, []);

  useEffect(() => {
    if (!workspaceId) return;

    let cancelled = false;

    async function boot() {
      try {
        setIsBooting(true);
        setIsLoadingConversations(true);
        setPageError(null);

        const [conversationResponse, connectionResponse, settingsResponse] =
          await Promise.all([
          apiRequest<{ items: Conversation[] }>(
            "/api/conversations",
            {},
            {
              workspaceId,
              status: status === "all" ? undefined : status,
              search: search || undefined,
            }
          ),
          apiRequest<{ items: ChannelConnection[] }>(
            "/api/channels",
            {},
            { workspaceId }
          ),
          apiRequest<{ settings: AISettings | null }>(
            "/api/ai-settings",
            {},
            { workspaceId }
          ),
        ]);

        if (cancelled) return;

        setConversations(sortConversationsByLatest(conversationResponse.items));
        setConnections(connectionResponse.items);
        setSupportedChannels(
          settingsResponse.settings?.supportedChannels ?? defaultSupportedChannels
        );
      } catch (error) {
        if (!cancelled) {
          setPageError(
            error instanceof Error ? error.message : "Failed to load inbox data."
          );
        }
      } finally {
        if (!cancelled) {
          setIsBooting(false);
          setIsLoadingConversations(false);
        }
      }
    }

    void boot();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, status, search]);

  useEffect(() => {
    if (!workspaceId) {
      setCannedReplies([]);
      return;
    }

    let cancelled = false;

    async function bootCannedReplies() {
      try {
        const response = await apiRequest<{ items: CannedReply[] }>(
          "/api/canned-replies",
          {},
          { workspaceId }
        );

        if (!cancelled) {
          setCannedReplies(response.items.filter((item) => item.isActive !== false));
        }
      } catch {
        if (!cancelled) {
          setCannedReplies([]);
        }
      }
    }

    void bootCannedReplies();

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!selectedConversationId && conversations[0]) {
      setSelectedConversationId(conversations[0]._id);
      return;
    }

    if (
      selectedConversationId &&
      !conversations.some((item) => item._id === selectedConversationId)
    ) {
      setSelectedConversationId(conversations[0]?._id ?? "");
    }
  }, [conversations, selectedConversationId]);

  useEffect(() => {
    if (!selectedConversationId) {
      setMessages([]);
      setContact(null);
      return;
    }

    let cancelled = false;

    async function loadThreadData() {
      try {
        setIsLoadingThread(true);
        setPageError(null);
        await Promise.all([
          loadMessages(selectedConversationId),
          loadContact(selectedConversation?.contactId),
        ]);
      } catch (error) {
        if (!cancelled) {
          setPageError(
            error instanceof Error ? error.message : "Failed to load conversation."
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoadingThread(false);
        }
      }
    }

    void loadThreadData();

    return () => {
      cancelled = true;
    };
  }, [selectedConversationId, selectedConversation?.contactId, loadMessages, loadContact]);

  useEffect(() => {
    const channel = selectedConversation?.channel;
    if (!selectedConversationId || !channel) {
      setStickerCatalog(null);
      setStickerCatalogError(null);
      setIsLoadingStickerCatalog(false);
      return;
    }

    const stickerChannel = channel;

    if (stickerChannel !== "telegram" && stickerChannel !== "viber") {
      setStickerCatalog({
        channel: stickerChannel,
        supported: false,
        items: [],
      });
      setStickerCatalogError(null);
      setIsLoadingStickerCatalog(false);
      return;
    }

    let cancelled = false;

    async function loadStickerCatalog() {
      try {
        setIsLoadingStickerCatalog(true);
        setStickerCatalogError(null);
        setStickerCatalog({
          channel: stickerChannel,
          supported: true,
          items: [],
        });

        const response = await apiRequest<{ catalog: StickerCatalog }>(
          `/api/conversations/${selectedConversationId}/sticker-catalog`
        );

        if (cancelled) {
          return;
        }

        setStickerCatalog(response.catalog);
      } catch (error) {
        if (!cancelled) {
          setStickerCatalog({
            channel: stickerChannel,
            supported: true,
            items: [],
          });
          setStickerCatalogError(
            error instanceof Error ? error.message : "Failed to load sticker catalog."
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoadingStickerCatalog(false);
        }
      }
    }

    void loadStickerCatalog();

    return () => {
      cancelled = true;
    };
  }, [selectedConversation?.channel, selectedConversationId]);

  useEffect(() => {
    if (!workspaceId) return;

    const socket = connectWorkspaceSocket(workspaceId);

    const refreshConversations = () => {
      void loadConversations();
    };

    const refreshConnections = () => {
      void loadConnections();
    };

    const refreshThread = (payload: unknown) => {
      const conversationId =
        typeof payload === "object" &&
        payload &&
        "conversationId" in payload &&
        typeof (payload as { conversationId?: unknown }).conversationId === "string"
          ? (payload as { conversationId: string }).conversationId
          : null;

      void loadConversations();

      if (conversationId && conversationId === selectedConversationId) {
        void loadMessages(conversationId);
      }
    };

    const onMessageReceived = (payload: unknown) => {
      refreshThread(payload);

      const normalized =
        typeof payload === "object" && payload
          ? (payload as MessageReceivedRealtimePayload)
          : {};

      const conversationId = normalized.conversationId?.trim();

      // Auto mark-as-read: if the message arrived for the currently open conversation,
      // clear the unread count immediately without requiring a click.
      if (conversationId && conversationId === selectedConversationId) {
        setConversations((current) =>
          current.map((item) =>
            item._id === conversationId ? { ...item, unreadCount: 0 } : item
          )
        );
        void apiRequest(`/api/conversations/${conversationId}`, {
          method: "PATCH",
          body: JSON.stringify({ unreadCount: 0 }),
        }).catch(() => {
          // Non-critical — UI already reflects read state.
        });
      }

      if (!shouldPlayInboundNotification(normalized, playedInboundMessageIdsRef.current)) {
        return;
      }

      const relatedConversation = conversationId
        ? conversations.find((item) => item._id === conversationId)
        : null;

      const assigneeId = relatedConversation?.assignee?._id;
      const currentUserId = session?.user?._id;
      const isManagedByAnotherStaff =
        !!assigneeId && !!currentUserId && assigneeId !== currentUserId;

      if (isManagedByAnotherStaff) {
        return;
      }

      const messageId = normalized.messageId?.trim();
      if (!messageId) {
        return;
      }

      playedInboundMessageIdsRef.current.add(messageId);

      const contactName =
        relatedConversation?.contactName?.trim() || "customer";
      pushToast({
        title: `New message from ${contactName}`,
        description:
          relatedConversation?.assignee?.name && currentUserId
            ? relatedConversation.assignee._id === currentUserId
              ? "This chat is managed by you"
              : `Managed by ${relatedConversation.assignee.name}`
            : "Unassigned chat",
        tone: "info",
      });

      if (notificationsMuted) {
        return;
      }

      const audio = notificationAudioRef.current;
      if (!audio) {
        return;
      }

      audio.currentTime = 0;
      void audio.play().catch(() => {
        // Browser autoplay policies can block audio without prior user interaction.
      });
    };

    socket.on("conversation.created", refreshConversations);
    socket.on("conversation.updated", refreshConversations);
    socket.on("message.received", onMessageReceived);
    socket.on("message.sent", refreshThread);
    socket.on("message.failed", refreshThread);
    socket.on("connection.updated", refreshConnections);

    return () => {
      socket.off("conversation.created", refreshConversations);
      socket.off("conversation.updated", refreshConversations);
      socket.off("message.received", onMessageReceived);
      socket.off("message.sent", refreshThread);
      socket.off("message.failed", refreshThread);
      socket.off("connection.updated", refreshConnections);
      socket.disconnect();
    };
  }, [
    conversations,
    loadConnections,
    loadConversations,
    loadMessages,
    notificationsMuted,
    pushToast,
    session?.user?._id,
    selectedConversationId,
    workspaceId,
  ]);

  const handleSend = async ({ text, attachment }: ComposerSendPayload) => {
    if (!selectedConversationId) return;
    if (selectedConversation && supportedChannels[selectedConversation.channel] === false) {
      const message = `${selectedConversation.channel} is disabled in Admin Settings.`;
      setSendError(message);
      pushToast({
        title: "Send blocked",
        description: message,
        tone: "warn",
      });
      return;
    }

    setSendError("");

    try {
      setIsSending(true);

      const sendBlocks = async (blocks: OutboundContentBlock[]) => {
        await apiRequest(`/api/conversations/${selectedConversationId}/messages`, {
          method: "POST",
          body: JSON.stringify({
            senderType: "agent",
            blocks,
          }),
        });

        await Promise.all([
          loadMessages(selectedConversationId),
          loadConversations(),
          loadConnections(),
        ]);

        pushToast({
          title: "Message sent",
          tone: "success",
        });
      };

      const stickerCommandMatch = text.trim().match(/^\/sticker\s+(.+)$/i);
      if (
        !attachment &&
        stickerCommandMatch &&
        (selectedConversation?.channel === "telegram" ||
          selectedConversation?.channel === "viber")
      ) {
        const platformStickerId = stickerCommandMatch[1].trim();
        await sendBlocks([
          {
            kind: "sticker",
            channel: selectedConversation?.channel ?? undefined,
            sticker: {
              platformStickerId,
            },
          },
        ]);
        return;
      }

      if (attachment) {
        if (selectedConversation?.channel === "tiktok") {
          validateTikTokAttachment(attachment);
        }

        const dataBase64 = await readFileAsBase64(attachment);
        const uploadResponse = await apiRequest<{
          asset: {
            _id: string;
            url: string;
            mimeType: string;
            size: number;
            fileName: string;
          };
        }>("/api/media-assets", {
          method: "POST",
          body: JSON.stringify({
            fileName: attachment.name,
            mimeType: attachment.type || "application/octet-stream",
            dataBase64,
          }),
        });

        const kind = inferOutboundKind(attachment);
        const attachmentBlock: OutboundContentBlock = {
          kind: "attachment",
          attachment: {
            kind,
            text:
              selectedConversation?.channel === "tiktok"
                ? undefined
                : text
                  ? {
                      body: text,
                      plain: text,
                    }
                  : undefined,
            media: [
              {
                url: uploadResponse.asset.url,
                storedAssetId: uploadResponse.asset._id,
                storedAssetUrl: uploadResponse.asset.url,
                mimeType: uploadResponse.asset.mimeType,
                filename: uploadResponse.asset.fileName,
                size: uploadResponse.asset.size,
                isTemporary: false,
              },
            ],
          },
        };

        if (selectedConversation?.channel === "tiktok" && text) {
          await sendBlocks([
            {
              kind: "text",
              text: {
                body: text,
                plain: text,
              },
            },
            attachmentBlock,
          ]);
        } else {
          await sendBlocks([attachmentBlock]);
        }
      } else {
        await sendBlocks([
          {
            kind: "text",
            text: {
              body: text,
              plain: text,
            },
          },
        ]);
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Send failed.");
      pushToast({
        title: "Send failed",
        description: error instanceof Error ? error.message : "Unable to send message.",
        tone: "warn",
      });
    } finally {
      setIsSending(false);
    }
  };

  const handleSendSticker = useCallback(
    async (platformStickerId: string) => {
      if (!selectedConversationId) {
        return;
      }

      const normalizedStickerId = platformStickerId.trim();
      if (
        selectedConversation?.channel === "telegram" &&
        /^AgAD[A-Za-z0-9_-]+$/.test(normalizedStickerId)
      ) {
        const message =
          "Telegram rejected this sticker identifier. Use sticker file_id (usually starts with CAAC), not file_unique_id (starts with AgAD).";
        setSendError(message);
        pushToast({
          title: "Invalid Telegram sticker ID",
          description: message,
          tone: "warn",
        });
        return;
      }

      if (
        selectedConversation &&
        supportedChannels[selectedConversation.channel] === false
      ) {
        const message = `${selectedConversation.channel} is disabled in Admin Settings.`;
        setSendError(message);
        pushToast({
          title: "Send blocked",
          description: message,
          tone: "warn",
        });
        return;
      }

      setSendError("");

      try {
        setIsSending(true);

        await apiRequest(`/api/conversations/${selectedConversationId}/messages`, {
          method: "POST",
          body: JSON.stringify({
            senderType: "agent",
            blocks: [
              {
                kind: "sticker",
                channel: selectedConversation?.channel ?? undefined,
                sticker: {
                  platformStickerId: normalizedStickerId,
                },
              },
            ],
          }),
        });

        await Promise.all([
          loadMessages(selectedConversationId),
          loadConversations(),
          loadConnections(),
        ]);

        pushToast({
          title: "Sticker sent",
          tone: "success",
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to send sticker.";
        setSendError(message);
        pushToast({
          title: "Sticker send failed",
          description: message,
          tone: "warn",
        });
      } finally {
        setIsSending(false);
      }
    },
    [
      loadConnections,
      loadConversations,
      loadMessages,
      pushToast,
      selectedConversation?.channel,
      selectedConversation,
      selectedConversationId,
      supportedChannels,
    ]
  );

  const handleConversationUpdated = useCallback(
    (updatedConversation: Conversation) => {
      setConversations((current) =>
        sortConversationsByLatest(
          current.map((item) =>
            item._id === updatedConversation._id
              ? {
                  ...item,
                  ...updatedConversation,
                }
              : item
          )
        )
      );

      if (selectedConversationId === updatedConversation._id) {
        void loadMessages(updatedConversation._id);
      }
    },
    [loadMessages, selectedConversationId]
  );

  const handleStatusUpdate = useCallback(
    async (nextStatus: ConversationStatus) => {
      if (!selectedConversationId || !selectedConversation) {
        return;
      }

      if (selectedConversation.status === nextStatus) {
        return;
      }

      try {
        setIsUpdatingStatus(true);
        setPageError(null);

        setConversations((current) =>
          current.map((item) =>
            item._id === selectedConversationId
              ? {
                  ...item,
                  status: nextStatus,
                }
              : item
          )
        );

        await apiRequest(`/api/conversations/${selectedConversationId}`, {
          method: "PATCH",
          body: JSON.stringify({ status: nextStatus }),
        });
      } catch (error) {
        setPageError(
          error instanceof Error
            ? error.message
            : "Failed to update conversation status."
        );
        void loadConversations();
      } finally {
        setIsUpdatingStatus(false);
      }
    },
    [selectedConversationId, selectedConversation, loadConversations]
  );

  const handleConversationSelect = useCallback(
    async (conversation: Conversation) => {
      setSelectedConversationId(conversation._id);

      if ((conversation.unreadCount ?? 0) <= 0) {
        return;
      }

      setConversations((current) =>
        current.map((item) =>
          item._id === conversation._id
            ? {
                ...item,
                unreadCount: 0,
              }
            : item
        )
      );

      try {
        await apiRequest(`/api/conversations/${conversation._id}`, {
          method: "PATCH",
          body: JSON.stringify({ unreadCount: 0 }),
        });
      } catch {
        // Keep local UI responsive even if read sync fails.
      }
    },
    []
  );

  const handleDeleteChatUser = useCallback(async () => {
    if (!selectedConversation?.contactId) {
      return;
    }

    const chatUserName = selectedConversation.contactName || "this chat user";
    const firstConfirm = window.confirm(
      `Delete ${chatUserName} and all related messages? This cannot be undone.`
    );
    if (!firstConfirm) {
      return;
    }

    const secondConfirm = window.confirm(
      "Final confirmation: permanently delete this chat user, all conversations, and all messages?"
    );
    if (!secondConfirm) {
      return;
    }

    try {
      setIsDeletingChatUser(true);
      setPageError(null);

      const response = await apiRequest<{
        deleted: boolean;
        result: {
          deletedContactId: string;
          deletedConversations: number;
          deletedMessages: number;
        };
      }>(`/api/contacts/${selectedConversation.contactId}?confirm=true`, {
        method: "DELETE",
      });

      setSelectedConversationId("");
      setMessages([]);
      setContact(null);
      setIsContactPanelOpen(false);

      await Promise.all([loadConversations(), loadConnections()]);

      pushToast({
        title: "Chat user deleted",
        description: `${response.result.deletedConversations} conversation(s), ${response.result.deletedMessages} message(s) removed.`,
        tone: "success",
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to delete chat user and messages.";
      setPageError(message);
      pushToast({
        title: "Delete failed",
        description: message,
        tone: "warn",
      });
    } finally {
      setIsDeletingChatUser(false);
    }
  }, [
    loadConnections,
    loadConversations,
    pushToast,
    selectedConversation?.contactId,
    selectedConversation?.contactName,
  ]);

  const composerDisabledReason = !selectedConversation
    ? "Select a conversation to send a reply."
    : supportedChannels[selectedConversation.channel] === false
      ? `${selectedConversation.channel} is disabled in Admin Settings.`
    : !selectedConnection
      ? "No stored channel connection matches this conversation."
      : selectedConnection.status !== "active"
        ? selectedConnection.lastError ||
          `Connection is ${selectedConnection.status}. Sending is blocked until the provider setup is active.`
        : undefined;

  if (!workspaceId) {
    return (
      <div className="h-dvh p-6">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          No workspace session found.
        </div>
      </div>
    );
  }

  if (isBooting) {
    return (
      <div className="flex h-dvh overflow-hidden bg-white">
        <div className="w-72 shrink-0 border-r border-slate-200" />
        <div className="flex flex-1 flex-col gap-3 p-8">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-14 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-white">
      {/* Left: conversation list */}
      <div className="flex w-72 shrink-0 flex-col border-r border-slate-200">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-100 px-4">
          <h2 className="text-sm font-semibold text-slate-900">Inbox</h2>
          <button
            type="button"
            onClick={() => setNotificationsMuted((current) => !current)}
            className="text-xs text-slate-400 transition-colors hover:text-slate-700"
          >
            {notificationsMuted ? "Unmute" : "Mute"}
          </button>
        </div>

        <div className="shrink-0 px-3 pt-2 pb-1">
          <input
            placeholder="Search..."
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            className="h-8 w-full rounded-lg bg-slate-100 px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:ring-1 focus:ring-slate-300"
          />
        </div>

        <div className="flex shrink-0 gap-1 px-3 py-1.5">
          {statusOptions.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setStatus(option)}
              className={[
                "rounded-full px-2.5 py-1 text-xs font-medium capitalize transition",
                status === option
                  ? "bg-slate-900 text-white"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-700",
              ].join(" ")}
            >
              {option}
            </button>
          ))}
        </div>

        {pageError ? (
          <div className="mx-3 mb-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {pageError}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <ConversationList
            conversations={conversations}
            currentUserId={session?.user?._id ?? null}
            onSelect={handleConversationSelect}
            selectedConversationId={selectedConversationId}
          />
        </div>
      </div>

      {/* Center: conversation thread */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-100 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-slate-900">
              {selectedConversation?.contactName || "No conversation selected"}
            </h3>
            {selectedConversation ? (
              <>
                <span className="shrink-0 text-xs capitalize text-slate-400">
                  {selectedConversation.channel}
                </span>
                <span className="shrink-0 text-xs capitalize text-slate-400">•</span>
                <span className="shrink-0 text-xs capitalize text-slate-400">
                  {selectedConversation.status}
                </span>
              </>
            ) : null}
          </div>
          <div className="inline-flex items-center rounded-full border border-slate-200 bg-white p-0.5">
            {([
              { value: "open", label: "Open" },
              { value: "pending", label: "Pend" },
              { value: "resolved", label: "Done" },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => void handleStatusUpdate(option.value)}
                disabled={!selectedConversation || isUpdatingStatus}
                className={[
                  "h-7 rounded-full px-2.5 text-[11px] font-semibold transition",
                  selectedConversation?.status === option.value
                    ? "bg-slate-900 text-white"
                    : "text-slate-500 hover:bg-slate-100 hover:text-slate-800",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                ].join(" ")}
                aria-label={`Set status ${option.label}`}
              >
                {option.label}
              </button>
            ))}

            <div className="mx-1 h-4 w-px bg-slate-200" />

            <button
              type="button"
              onClick={() => setIsContactPanelOpen(true)}
              disabled={!selectedConversation || isUpdatingStatus || isDeletingChatUser}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Open conversation details"
              title="Details"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-4 w-4"
              >
                <path d="M12 6.75a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 6.75a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 6.75a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" />
              </svg>
            </button>

            <button
              type="button"
              onClick={() => void handleDeleteChatUser()}
              disabled={
                !selectedConversation ||
                !selectedConversation.contactId ||
                isUpdatingStatus ||
                isDeletingChatUser
              }
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-rose-500 transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Delete chat user and messages"
              title="Delete chat user"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                className="h-4 w-4"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18" />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m-9 0l1 14a1 1 0 001 1h6a1 1 0 001-1l1-14"
                />
              </svg>
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden px-2 pt-2">
          {!selectedConversation ? (
            <div className="flex h-full items-center justify-center px-6 text-center">
              <p className="text-sm text-slate-400">Select a conversation</p>
            </div>
          ) : isLoadingThread ? (
            <div className="flex h-full items-center justify-center">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-slate-600" />
            </div>
          ) : (
            <ThreadView messages={messages} />
          )}
        </div>

        {selectedConversation ? (
          <div className="shrink-0 border-t border-slate-100 px-3 py-2">
            <Composer
              disabled={isSending || !selectedConversationId || !!composerDisabledReason}
              disabledReason={composerDisabledReason}
              error={sendError}
              channel={selectedConversation?.channel ?? null}
              cannedReplies={cannedReplies}
              stickerCatalog={stickerCatalog}
              stickerCatalogError={stickerCatalogError}
              isStickerCatalogLoading={isLoadingStickerCatalog}
              onSend={handleSend}
              onSendSticker={handleSendSticker}
            />
          </div>
        ) : null}
      </div>

      {isContactPanelOpen ? (
        <>
          <button
            type="button"
            aria-label="Close details"
            className="fixed inset-0 z-30 bg-slate-900/20"
            onClick={() => setIsContactPanelOpen(false)}
          />

          <aside className="fixed inset-y-0 right-0 z-40 flex w-85 max-w-[90vw] flex-col border-l border-slate-200 bg-white shadow-xl">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-100 px-4">
              <h4 className="text-sm font-semibold text-slate-900">Conversation details</h4>
              <button
                type="button"
                onClick={() => setIsContactPanelOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close details"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  className="h-4 w-4"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <ContactPanel
                contact={contact}
                conversation={selectedConversation}
                currentUserId={session?.user?._id ?? null}
                onConversationUpdated={handleConversationUpdated}
              />
            </div>
          </aside>
        </>
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
