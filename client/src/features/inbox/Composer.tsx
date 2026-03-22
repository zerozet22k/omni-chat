import type { EmojiClickData } from "emoji-picker-react";
import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  Suspense,
  useEffect,
  useLayoutEffect,
  lazy,
  useMemo,
  useRef,
  useState,
} from "react";
import { API_BASE_URL } from "../../services/api-base";
import { Channel } from "../../types/models";
import { StickerCatalog, StickerCatalogItem } from "./sticker-catalog";

const EmojiPicker = lazy(() => import("emoji-picker-react"));

export type ComposerSendPayload = {
  text: string;
  attachment: File | null;
};

type ComposerProps = {
  disabled?: boolean;
  disabledReason?: string;
  error?: string;
  channel?: Channel | null;
  cannedReplies?: Array<{
    _id: string;
    title: string;
    body: string;
    triggers: string[];
    isActive?: boolean;
  }>;
  stickerCatalog?: StickerCatalog | null;
  stickerCatalogError?: string | null;
  isStickerCatalogLoading?: boolean;
  onSend: (payload: ComposerSendPayload) => Promise<void>;
  onSendSticker?: (platformStickerId: string) => Promise<void>;
};

type UtilityPanelTab = "emoji" | "stickers";

const getChannelLabel = (channel?: Channel | null) => {
  if (!channel) {
    return "Unknown";
  }

  return channel.slice(0, 1).toUpperCase() + channel.slice(1);
};

const resolvePreviewUrl = (url?: string) => {
  if (!url) {
    return undefined;
  }

  try {
    return new URL(url, API_BASE_URL).toString();
  } catch {
    return url;
  }
};

function StickerTilePreview({ item }: { item: StickerCatalogItem }) {
  const [hasPreviewError, setHasPreviewError] = useState(false);
  const preview = item.preview;
  const previewUrl = resolvePreviewUrl(preview?.url);

  if (!hasPreviewError && preview?.kind === "video" && previewUrl) {
    return (
      <video
        autoPlay
        loop
        muted
        playsInline
        src={previewUrl}
        className="h-18 w-18 object-contain"
        onError={() => setHasPreviewError(true)}
      />
    );
  }

  if (
    !hasPreviewError &&
    (preview?.kind === "image" || preview?.kind === "fallback") &&
    previewUrl
  ) {
    return (
      <div className="relative flex h-full w-full items-center justify-center">
        <img
          src={previewUrl}
          alt={item.label}
          className="h-18 w-18 object-contain"
          loading="lazy"
          onError={() => setHasPreviewError(true)}
        />
        {preview.kind === "fallback" ? (
          <span className="absolute right-2 bottom-2 rounded-full bg-slate-900/80 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
            Preview
          </span>
        ) : null}
      </div>
    );
  }

  if (preview?.kind === "tgs") {
    return (
      <div className="flex flex-col items-center justify-center gap-1 text-center">
        <span className="text-4xl leading-none">{item.emoji ?? "✨"}</span>
        <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
          TGS
        </span>
      </div>
    );
  }

  return <span className="text-4xl leading-none">{item.emoji ?? "🙂"}</span>;
}

export function Composer({
  disabled = false,
  disabledReason,
  error,
  channel,
  cannedReplies = [],
  stickerCatalog,
  stickerCatalogError,
  isStickerCatalogLoading = false,
  onSend,
  onSendSticker,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachment, setAttachment] = useState<File | null>(null);
  const [activeUtilityPanel, setActiveUtilityPanel] = useState<UtilityPanelTab | null>(null);
  const [activeCannedReplyIndex, setActiveCannedReplyIndex] = useState(0);
  const [customStickerId, setCustomStickerId] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaSelectionRef = useRef({ start: 0, end: 0 });
  const utilityPanelRef = useRef<HTMLDivElement | null>(null);

  const trimmedText = useMemo(() => text.trim(), [text]);
  const isDisabled = disabled || sending;
  const canSend = !isDisabled && (Boolean(trimmedText) || Boolean(attachment));
  const stickerChannelSupported =
    stickerCatalog?.supported ?? (channel === "telegram" || channel === "viber");
  const canUseStickerPicker =
    stickerChannelSupported && (channel === "telegram" || channel === "viber");
  const stickerItems = stickerCatalog?.items ?? [];
  const cannedReplyMatch =
    !attachment && !/^\/sticker\b/i.test(trimmedText)
      ? trimmedText.match(/^\/(.*)$/)
      : null;
  const cannedReplyQuery = cannedReplyMatch?.[1]?.trim().toLowerCase() ?? null;
  const cannedReplySuggestions = useMemo(() => {
    if (cannedReplyQuery === null) {
      return [];
    }

    const activeReplies = cannedReplies.filter((item) => item.isActive !== false);
    if (!cannedReplyQuery) {
      return activeReplies.slice(0, 6);
    }

    return activeReplies
      .filter((item) => {
        const haystack = `${item.title} ${item.body} ${item.triggers.join(" ")}`.toLowerCase();
        return haystack.includes(cannedReplyQuery);
      })
      .slice(0, 6);
  }, [cannedReplies, cannedReplyQuery]);

  const resetComposer = () => {
    setText("");
    setAttachment(null);
    textareaSelectionRef.current = { start: 0, end: 0 };
  };

  const syncTextareaSelection = () => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textareaSelectionRef.current = {
      start: textarea.selectionStart ?? textarea.value.length,
      end: textarea.selectionEnd ?? textarea.value.length,
    };
  };

  const insertTextAtCursor = (value: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setText((current) => `${current}${value}`);
      return;
    }

    const { start, end } = textareaSelectionRef.current;
    const nextText = `${textarea.value.slice(0, start)}${value}${textarea.value.slice(end)}`;
    const nextCaretPosition = start + value.length;

    setText(nextText);
    textareaSelectionRef.current = {
      start: nextCaretPosition,
      end: nextCaretPosition,
    };

    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCaretPosition, nextCaretPosition);
    });
  };

  const applyCannedReply = (replyBody: string) => {
    const normalizedBody = replyBody.trim();
    setText(normalizedBody);
    setActiveCannedReplyIndex(0);

    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }

      const caret = normalizedBody.length;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
      textareaSelectionRef.current = { start: caret, end: caret };
    });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (isDisabled || (!trimmedText && !attachment)) {
      return;
    }

    try {
      setSending(true);
      await onSend({ text: trimmedText, attachment });
      resetComposer();
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = async (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (cannedReplySuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveCannedReplyIndex((current) =>
          Math.min(current + 1, cannedReplySuggestions.length - 1)
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveCannedReplyIndex((current) => Math.max(current - 1, 0));
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyCannedReply(
          cannedReplySuggestions[activeCannedReplyIndex]?.body ??
            cannedReplySuggestions[0]?.body ??
            ""
        );
        return;
      }
    }

    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (!canSend) {
        return;
      }

      try {
        setSending(true);
        await onSend({ text: trimmedText, attachment });
        resetComposer();
      } finally {
        setSending(false);
      }
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setAttachment(file);
  };

  const handleSendSticker = async (platformStickerId: string) => {
    if (isDisabled || !onSendSticker) {
      return;
    }

    const normalizedId = platformStickerId.trim();
    if (!normalizedId) {
      return;
    }

    try {
      setSending(true);
      await onSendSticker(normalizedId);
      setActiveUtilityPanel(null);
      setCustomStickerId("");
    } finally {
      setSending(false);
    }
  };

  const handleTogglePanel = (nextPanel: UtilityPanelTab) => {
    if (sending) {
      return;
    }

    setActiveUtilityPanel((current) => (current === nextPanel ? null : nextPanel));
  };

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    insertTextAtCursor(emojiData.emoji);
  };

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const minHeight = 24;
    const maxHeight = 200;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
  }, [text]);

  useEffect(() => {
    setActiveUtilityPanel(null);
    setCustomStickerId("");
  }, [channel]);

  useEffect(() => {
    if (activeUtilityPanel === "stickers" && !canUseStickerPicker) {
      setActiveUtilityPanel(null);
    }
  }, [activeUtilityPanel, canUseStickerPicker]);

  useEffect(() => {
    setActiveCannedReplyIndex(0);
  }, [cannedReplyQuery]);

  useEffect(() => {
    syncTextareaSelection();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!utilityPanelRef.current) {
        return;
      }

      if (!utilityPanelRef.current.contains(event.target as Node)) {
        setActiveUtilityPanel(null);
      }
    };

    if (activeUtilityPanel) {
      document.addEventListener("mousedown", onPointerDown);
    }

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [activeUtilityPanel]);

  return (
    <form className="space-y-1.5" onSubmit={handleSubmit}>
      {disabledReason ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {disabledReason}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      {attachment ? (
        <div className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600">
          <span className="max-w-55 truncate">{attachment.name}</span>
          <button
            type="button"
            className="text-slate-400 transition-colors hover:text-slate-700"
            onClick={() => setAttachment(null)}
            disabled={isDisabled}
            aria-label="Remove attachment"
          >
            x
          </button>
        </div>
      ) : null}

      {cannedReplyQuery !== null ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-2 py-2 shadow-sm">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Canned Replies
          </div>
          {cannedReplySuggestions.length ? (
            <div className="space-y-1">
              {cannedReplySuggestions.map((reply, index) => (
                <button
                  key={reply._id}
                  type="button"
                  className={[
                    "w-full rounded-xl px-3 py-2 text-left transition",
                    index === activeCannedReplyIndex
                      ? "bg-slate-900 text-white"
                      : "hover:bg-slate-50",
                  ].join(" ")}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyCannedReply(reply.body)}
                >
                  <p
                    className={`truncate text-sm font-semibold ${
                      index === activeCannedReplyIndex ? "text-white" : "text-slate-800"
                    }`}
                  >
                    {reply.title}
                  </p>
                  <p
                    className={`truncate text-xs ${
                      index === activeCannedReplyIndex
                        ? "text-slate-200"
                        : "text-slate-500"
                    }`}
                  >
                    {reply.body}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <div className="px-3 py-2 text-sm text-slate-500">
              No canned replies match. Type to search by title or trigger.
            </div>
          )}
          <div className="px-3 pt-2 text-[11px] text-slate-400">
            Press `Enter` or `Tab` to insert. `/sticker &lt;id&gt;` still works separately.
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2">
        <label
          className="shrink-0 cursor-pointer text-slate-400 transition-colors hover:text-slate-600"
          aria-label="Attach file"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.75}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
            />
          </svg>
          <input
            type="file"
            disabled={isDisabled}
            onChange={onFileChange}
            className="hidden"
          />
        </label>

        <textarea
          ref={textareaRef}
          disabled={isDisabled}
          placeholder="Write a message..."
          value={text}
          onChange={(event) => setText(event.target.value)}
          onClick={syncTextareaSelection}
          onKeyDown={handleKeyDown}
          onKeyUp={syncTextareaSelection}
          onSelect={syncTextareaSelection}
          onBlur={syncTextareaSelection}
          rows={1}
          className="min-h-6 max-h-50 flex-1 resize-none overflow-y-auto bg-transparent text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:text-slate-400"
        />

        <div ref={utilityPanelRef} className="relative flex shrink-0 items-center gap-1.5">
          {activeUtilityPanel ? (
            <div className="absolute right-0 bottom-11 z-20 w-88 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-3 py-2">
                <div className="inline-flex items-center rounded-full bg-white p-1 shadow-sm">
                  <button
                    type="button"
                    className={[
                      "rounded-full px-3 py-1 text-xs font-semibold transition",
                      activeUtilityPanel === "emoji"
                        ? "bg-slate-900 text-white"
                        : "text-slate-500 hover:text-slate-800",
                    ].join(" ")}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setActiveUtilityPanel("emoji")}
                  >
                    Emoji
                  </button>
                  {canUseStickerPicker ? (
                    <button
                      type="button"
                      className={[
                        "rounded-full px-3 py-1 text-xs font-semibold transition",
                        activeUtilityPanel === "stickers"
                          ? "bg-slate-900 text-white"
                          : "text-slate-500 hover:text-slate-800",
                      ].join(" ")}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setActiveUtilityPanel("stickers")}
                    >
                      Stickers
                    </button>
                  ) : null}
                </div>

                <span className="rounded-full bg-white px-2 py-1 text-[11px] font-medium text-slate-500 shadow-sm">
                  {getChannelLabel(channel)}
                </span>
              </div>

              <div className="max-h-96 overflow-y-auto p-3">
                {activeUtilityPanel === "emoji" ? (
                  <div className="overflow-hidden rounded-xl border border-slate-200">
                    <Suspense
                      fallback={
                        <div className="flex h-90 items-center justify-center text-sm text-slate-500">
                          Loading emoji picker...
                        </div>
                      }
                    >
                      <EmojiPicker
                        onEmojiClick={handleEmojiClick}
                        width="100%"
                        height={360}
                        lazyLoadEmojis
                        previewConfig={{ showPreview: false }}
                        searchPlaceholder="Search emoji"
                        skinTonesDisabled
                      />
                    </Suspense>
                  </div>
                ) : canUseStickerPicker ? (
                  <div className="space-y-3">
                    {stickerCatalogError ? (
                      <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                        {stickerCatalogError}
                      </div>
                    ) : null}

                    {isStickerCatalogLoading ? (
                      <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-3 text-xs text-slate-500">
                        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-200 border-t-slate-600" />
                        Loading stickers...
                      </div>
                    ) : stickerChannelSupported ? (
                      <>
                        {stickerItems.length ? (
                          <div className="grid grid-cols-2 gap-2">
                            {stickerItems.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                className="rounded-2xl border border-slate-200 bg-slate-50 p-2 text-left transition hover:border-slate-300 hover:bg-slate-100"
                                onClick={() => void handleSendSticker(item.id)}
                                disabled={isDisabled}
                                title={`${item.label} (${item.id})`}
                              >
                                <div className="flex h-20 items-center justify-center overflow-hidden rounded-xl bg-white">
                                  <StickerTilePreview item={item} />
                                </div>
                                <p className="mt-2 truncate text-xs font-semibold text-slate-800">
                                  {item.label}
                                </p>
                                {item.description ? (
                                  <p className="truncate text-[11px] text-slate-500">{item.description}</p>
                                ) : null}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-500">
                            No stickers are available for this conversation yet.
                          </div>
                        )}

                        <div className="space-y-1.5 rounded-xl border border-slate-200 bg-slate-50 p-2">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                            Custom Sticker ID
                          </p>
                          <input
                            value={customStickerId}
                            onChange={(event) => setCustomStickerId(event.target.value)}
                            placeholder={
                              channel === "viber"
                                ? "Paste Viber sticker_id"
                                : "Paste Telegram file_id"
                            }
                            className="h-9 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs text-slate-700 outline-none focus:border-slate-400"
                          />
                          <button
                            type="button"
                            className="h-9 w-full rounded-xl bg-slate-900 text-xs font-semibold text-white transition hover:bg-slate-950 disabled:bg-slate-300"
                            onClick={() => void handleSendSticker(customStickerId)}
                            disabled={isDisabled || !customStickerId.trim()}
                          >
                            Send sticker ID
                          </button>
                          <p className="text-[11px] text-slate-400">
                            `/sticker &lt;id&gt;` still works as a fallback.
                          </p>
                        </div>
                      </>
                    ) : (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
                        Direct sticker sending is available for Telegram and Viber conversations.
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
                    Sticker sending is not available for this channel.
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <button
            type="button"
            className={[
              "rounded-full p-1 text-slate-400 transition-colors hover:text-slate-600",
              activeUtilityPanel === "emoji" ? "text-slate-700" : "",
            ].join(" ")}
            aria-label="Emoji"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => handleTogglePanel("emoji")}
            disabled={sending}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.75}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </button>

          {canUseStickerPicker ? (
            <button
              type="button"
              className={[
                "rounded-full p-1 text-slate-400 transition-colors hover:text-slate-600",
                activeUtilityPanel === "stickers" ? "text-slate-700" : "",
              ].join(" ")}
              aria-label="Open sticker picker"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => handleTogglePanel("stickers")}
              disabled={sending}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.75}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M7 3h10a2 2 0 012 2v10a2 2 0 01-2 2h-4l-4 4v-4H7a2 2 0 01-2-2V5a2 2 0 012-2z"
                />
              </svg>
            </button>
          ) : null}

          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-700 text-white transition hover:bg-slate-900 disabled:bg-slate-200 disabled:text-slate-400"
          >
            {sending ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </form>
  );
}
