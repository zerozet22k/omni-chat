import { useCallback, useLayoutEffect, useRef } from "react";
import { Message } from "../../types/models";
import { resolveRenderableMedia } from "./thread-media-utils";

const GIF_URL_REGEX = /https?:\/\/[^\s]+\.gif(?:\?[^\s]*)?/gi;

function extractGifUrls(text: string) {
  if (!text) {
    return [];
  }
  const matches = text.match(GIF_URL_REGEX);
  return matches ? Array.from(new Set(matches)) : [];
}

function stripGifUrls(text: string) {
  if (!text) {
    return "";
  }
  return text.replace(GIF_URL_REGEX, " ").replace(/\s+/g, " ").trim();
}

function isSingleEmojiText(text: string) {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return false;
  }

  // Covers most standalone and ZWJ-composed emojis.
  return /^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*$/u.test(
    trimmed
  );
}

function isTelegramStickerLike(message: Message) {
  if (message.channel !== "telegram") {
    return message.kind === "sticker";
  }

  if (message.kind === "sticker") {
    return true;
  }

  const meta = message.meta as Record<string, unknown> | undefined;
  if (
    meta?.isAnimated === true ||
    meta?.isVideo === true ||
    meta?.previewFromThumbnail === true
  ) {
    return true;
  }

  const firstMedia = message.media?.[0];
  const mimeType = firstMedia?.mimeType?.toLowerCase();
  const stickerMime =
    mimeType === "image/webp" ||
    mimeType === "video/webm" ||
    mimeType === "application/x-tgsticker";
  if (!stickerMime) {
    return false;
  }

  const text = message.text?.body?.trim() ?? "";
  const looksEmojiLike = text.length > 0 && text.length <= 8 && !/[a-z0-9]/i.test(text);
  return looksEmojiLike;
}

function getAttachmentLinkLabel(message: Message) {
  const filename = message.media?.[0]?.filename?.trim();
  if (filename) {
    return filename;
  }

  switch (message.kind) {
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "file":
      return "File";
    default:
      return "Attachment";
  }
}

function renderMessageContent(
  message: Message,
  isOutbound: boolean,
  isSystem: boolean,
  onMediaLoad?: () => void
) {
  const textClass =
    isOutbound && !isSystem ? "text-slate-100" : "text-slate-800";
  const mediaState = resolveRenderableMedia(message);
  const attachmentUrl = mediaState.preferredUrl;
  const mediaCount = message.media?.length ?? 0;
  const isSticker = isTelegramStickerLike(message);

  if (isSticker) {
    const isVideoSticker =
      message.media?.[0]?.mimeType === "video/webm" ||
      (message.meta as Record<string, unknown> | undefined)?.isVideo === true;
    const stickerUrl = attachmentUrl;
    const emoji = message.text?.body;
    const stickerLabel =
      typeof (message.meta as Record<string, unknown> | undefined)?.stickerLabel === "string"
        ? String((message.meta as Record<string, unknown>).stickerLabel)
        : undefined;

    return (
      <div className="flex flex-col items-start gap-1">
        {stickerUrl ? (
          isVideoSticker ? (
            <video
              autoPlay
              loop
              muted
              playsInline
              src={stickerUrl}
              className="h-32 w-32 object-contain"
              onLoadedMetadata={onMediaLoad}
            />
          ) : (
            <img
              src={stickerUrl}
              alt={emoji ?? "Sticker"}
              className="h-32 w-32 object-contain"
              onLoad={onMediaLoad}
            />
          )
        ) : emoji ? (
          <span className="text-5xl leading-none">{emoji}</span>
        ) : stickerLabel ? (
          <span className={`text-xs ${textClass} opacity-70`}>{stickerLabel}</span>
        ) : (
          <span className={`text-xs ${textClass} opacity-60`}>Sticker</span>
        )}
      </div>
    );
  }

  switch (message.kind) {
    case "text":
    case "system":
    case "interactive":
      {
        const rawText = message.text?.body || "";
        const gifUrls = extractGifUrls(rawText);
        const textWithoutGifs = stripGifUrls(rawText);

        if (isSingleEmojiText(textWithoutGifs)) {
          return <span className="text-5xl leading-none">{textWithoutGifs}</span>;
        }

        return (
          <div className="space-y-3">
            {textWithoutGifs ? (
              <p className={`whitespace-pre-wrap text-sm leading-6 ${textClass}`}>
                {textWithoutGifs}
              </p>
            ) : null}

            {gifUrls.map((gifUrl, index) => (
              <img
                key={`${message._id}-gif-${index}`}
                alt={`GIF ${index + 1}`}
                src={gifUrl}
                onLoad={onMediaLoad}
                className="max-h-80 w-full rounded-xl object-cover"
              />
            ))}

            {!textWithoutGifs && gifUrls.length === 0 ? (
              <p className={`whitespace-pre-wrap text-sm leading-6 ${textClass}`}>
                No text content
              </p>
            ) : null}
          </div>
        );
      }

    case "image":
      return (
        <div className="space-y-3">
          {message.text?.body ? <p className={`text-sm ${textClass}`}>{message.text.body}</p> : null}

          {mediaState.items.some((item) => item.preferredUrl) ? (
            <div
              className={
                mediaState.items.length > 1
                  ? "grid grid-cols-2 gap-2"
                  : "grid grid-cols-1"
              }
            >
              {mediaState.items
                .filter((item) => item.preferredUrl)
                .map((item, index) => (
                  <img
                    key={`${message._id}-media-${index}`}
                    alt={`Message media ${index + 1}`}
                    src={item.preferredUrl as string}
                    onLoad={onMediaLoad}
                    className="max-h-80 w-full rounded-xl object-cover"
                  />
                ))}
            </div>
          ) : mediaState.isExpired ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Media expired. No durable copy available.
            </div>
          ) : null}
        </div>
      );

    case "video":
      return (
        <div className="space-y-3">
          {message.text?.body ? <p className={`text-sm leading-6 ${textClass}`}>{message.text.body}</p> : null}

          {attachmentUrl ? (
            <video
              controls
              preload="metadata"
              src={attachmentUrl}
              className="max-h-96 w-full rounded-xl border border-slate-200 bg-black"
              onLoadedMetadata={onMediaLoad}
            />
          ) : mediaCount > 1 ? (
            <p className={`text-sm leading-6 ${textClass}`}>{`${mediaCount} videos received`}</p>
          ) : null}
        </div>
      );

    case "audio":
      return (
        <div className="space-y-3">
          {message.text?.body ? <p className={`text-sm leading-6 ${textClass}`}>{message.text.body}</p> : null}

          {attachmentUrl ? (
            <audio controls src={attachmentUrl} className="w-full" preload="metadata">
              Your browser does not support audio playback.
            </audio>
          ) : mediaCount > 1 ? (
            <p className={`text-sm leading-6 ${textClass}`}>{`${mediaCount} audio files received`}</p>
          ) : null}
        </div>
      );

    case "file":
      return (
        <div className="space-y-2">
          {message.text?.body ? <p className={`text-sm leading-6 ${textClass}`}>{message.text.body}</p> : null}
          
          {mediaState.items.some((item) => item.preferredUrl) ? (
            <div className="space-y-2">
              {mediaState.items
                .filter((item) => item.preferredUrl)
                .map((item, index) => {
                  const filename = item.filename || `file-${index + 1}`;
                  const filesize = item.size ? `${(item.size / 1024 / 1024).toFixed(2)}MB` : "Unknown size";
                  
                  return (
                    <a
                      key={`${message._id}-file-${index}`}
                      href={item.preferredUrl as string}
                      download={filename}
                      className={
                        isOutbound && !isSystem
                          ? "inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700"
                          : "inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                      }
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      <div className="text-left">
                        <p className="truncate">{filename}</p>
                        <p className="text-xs opacity-70">{filesize}</p>
                      </div>
                    </a>
                  );
                })}
            </div>
          ) : mediaState.isExpired ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              File expired. No durable copy available.
            </div>
          ) : mediaCount > 0 ? (
            <p className={`text-sm leading-6 ${textClass}`}>{`${mediaCount} file(s) received`}</p>
          ) : null}
        </div>
      );

    case "location":
      return (
        <div className="space-y-2">
          {message.text?.body ? <p className={`text-sm leading-6 ${textClass}`}>{message.text.body}</p> : null}
          {typeof message.location?.lat === "number" && typeof message.location?.lng === "number" ? (
            <>
              <p className={`text-sm leading-6 ${textClass}`}>
                {message.location.lat.toFixed(6)}, {message.location.lng.toFixed(6)}
              </p>
              <a
                href={`https://www.google.com/maps?q=${message.location.lat},${message.location.lng}`}
                rel="noreferrer"
                target="_blank"
                className={
                  isOutbound && !isSystem
                    ? "text-sm font-medium text-slate-100 underline underline-offset-4"
                    : "text-sm font-medium text-slate-700 underline underline-offset-4"
                }
              >
                Open location in maps
              </a>
            </>
          ) : (
            <p className={`text-sm leading-6 ${textClass}`}>Location received</p>
          )}
          {message.location?.label ? (
            <p className={`text-xs ${textClass} opacity-80`}>{message.location.label}</p>
          ) : null}
        </div>
      );

    case "contact":
      return (
        <div className="space-y-1">
          {message.contact?.name ? (
            <p className={`text-sm leading-6 ${textClass}`}>{message.contact.name}</p>
          ) : (
            <p className={`text-sm leading-6 ${textClass}`}>Contact received</p>
          )}
          {message.contact?.phone ? (
            <a
              href={`tel:${message.contact.phone}`}
              className={
                isOutbound && !isSystem
                  ? "text-sm font-medium text-slate-100 underline underline-offset-4"
                  : "text-sm font-medium text-slate-700 underline underline-offset-4"
              }
            >
              {message.contact.phone}
            </a>
          ) : null}
        </div>
      );

    case "unsupported":
      return (
        <p className="text-sm leading-6 text-rose-600">
          Unsupported content: {message.unsupportedReason || "Unknown type"}
        </p>
      );

    default:
      return (
        <p className={`text-sm leading-6 ${textClass}`}>Unsupported message type</p>
      );
  }
}

export function ThreadView({ messages }: { messages: Message[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTo({
      top: container.scrollHeight,
      behavior,
    });
  }, []);

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      scrollToBottom("auto");
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [messages, scrollToBottom]);

  if (!messages.length) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        No messages yet.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 flex-col overflow-y-auto pr-2"
    >
      <div className="mt-auto space-y-2">
        {messages.map((message) => {
          const isOutbound = message.direction === "outbound";
          const isSystem =
            message.kind === "system" || message.senderType === "system";
          const isSticker = isTelegramStickerLike(message);
          const hasDeliveryError =
            message.delivery?.error || message.meta?.deliveryError;
          const mediaState = resolveRenderableMedia(message);
          const attachmentUrl = mediaState.preferredUrl;
          const attachmentLinkLabel = getAttachmentLinkLabel(message);

          const wrapperClass = isSystem
            ? "flex justify-center"
            : isOutbound
              ? "flex justify-end"
              : "flex justify-start";

          const bubbleClass = isSticker
            ? ""
            : isSystem
              ? "max-w-[80%] rounded-xl bg-slate-50 px-3 py-1.5"
              : isOutbound
                ? "max-w-[72%] rounded-2xl rounded-br-sm bg-slate-800 px-3.5 py-2.5 text-white"
                : "max-w-[72%] rounded-2xl rounded-bl-sm bg-slate-100 px-3.5 py-2.5";

          return (
            <article key={message._id} className={wrapperClass}>
              <div className={bubbleClass}>
                {renderMessageContent(
                  message,
                  isOutbound,
                  isSystem,
                  () => scrollToBottom("auto")
                )}

                {attachmentUrl && message.kind !== "image" && !isSticker ? (
                  <div className="mt-2">
                    <a
                      href={attachmentUrl}
                      rel="noreferrer"
                      target="_blank"
                      className={
                        isOutbound && !isSystem
                          ? "text-sm font-medium text-slate-200 underline underline-offset-4"
                          : "text-sm font-medium text-slate-600 underline underline-offset-4"
                      }
                    >
                      {attachmentLinkLabel}
                    </a>
                  </div>
                ) : mediaState.isExpired && message.kind !== "image" && !isSticker ? (
                  <div className="mt-2 rounded-lg bg-amber-100 px-2.5 py-1.5 text-xs text-amber-800">
                    Attachment expired.
                  </div>
                ) : null}

                {hasDeliveryError ? (
                  <div
                    className={
                      isOutbound && !isSystem
                        ? "mt-2 rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-xs text-rose-200"
                        : "mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-600"
                    }
                  >
                    {message.delivery?.error ?? message.meta?.deliveryError}
                  </div>
                ) : null}

                {!isSticker ? (
                  <div className="mt-1 flex justify-end">
                    <span
                      className={`text-[10px] ${
                        isOutbound && !isSystem ? "text-white/40" : "text-slate-400"
                      }`}
                    >
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                ) : null}
              </div>
            </article>
          );
        })}

        <div ref={bottomRef} className="h-px w-full shrink-0" />
      </div>
    </div>
  );
}
