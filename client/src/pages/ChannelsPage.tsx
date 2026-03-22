import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../hooks/use-session";
import { apiRequest } from "../services/api";
import { connectWorkspaceSocket } from "../services/realtime";
import { AISettings, Channel, ChannelConnection } from "../types/models";
import { StatusBadge } from "../features/ui/StatusBadge";

const channelOptions: Channel[] = ["facebook", "telegram", "viber", "tiktok"];

type ConnectionDiagnostics = {
  status: string;
  verificationState: string;
  webhookUrl?: string | null;
  lastError?: string | null;
  diagnostics?: Record<string, unknown>;
};

type ChannelsResponse = {
  items: ChannelConnection[];
  publicWebhookBaseUrl: string;
};

type ChannelFormState = {
  displayName: string;
  token: string;
  refreshToken: string;
  businessId: string;
  webhookSecret: string;
  verifyToken: string;
  appSecret: string;
  connectionKey: string;
};

type FacebookOAuthPage = {
  id: string;
  name: string;
  accessToken: string;
};

const initialFormState: ChannelFormState = {
  displayName: "",
  token: "",
  refreshToken: "",
  businessId: "",
  webhookSecret: "",
  verifyToken: "",
  appSecret: "",
  connectionKey: "",
};

const channelMeta: Record<
  Channel,
  {
    label: string;
    description: string;
    credentialHint: string;
  }
> = {
  facebook: {
    label: "Facebook",
    description: "Connect a Facebook Page to handle Messenger conversations from this workspace.",
    credentialHint:
      "Provide a Page access token for this connection. META_APP_ID, META_APP_SECRET, and META_WEBHOOK_VERIFY_TOKEN remain configured on the server.",
  },
  telegram: {
    label: "Telegram",
    description: "Connect a Telegram bot and register its webhook.",
    credentialHint: "Requires bot token. Webhook secret is optional.",
  },
  viber: {
    label: "Viber",
    description: "Connect a Viber bot and map inbound traffic with a connection key.",
    credentialHint: "Requires auth token. Connection key is optional.",
  },
  tiktok: {
    label: "TikTok",
    description: "Connect a TikTok Business Account for direct-message inbox support.",
    credentialHint:
      "Requires a TikTok Business access token. App ID and secret stay on the server via env vars.",
  },
};

const trimTrailingSlash = (value: string) => value.trim().replace(/\/+$/, "");

function buildWebhookPreviewUrl(params: {
  baseUrl: string;
  channel: Channel;
  connectionKey?: string;
}) {
  const normalizedBaseUrl = trimTrailingSlash(params.baseUrl);
  if (!normalizedBaseUrl) {
    return "";
  }

  const url = new URL(`/webhooks/${params.channel}`, `${normalizedBaseUrl}/`);
  if (params.channel === "viber") {
    url.searchParams.set("connectionKey", params.connectionKey?.trim() || "your-key");
  }

  return url.toString();
}



function getStatusTone(status?: string) {
  switch (status) {
    case "connected":
    case "verified":
    case "active":
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

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-900">
        {label}
      </span>
      {children}
      {hint ? <p className="mt-1.5 text-xs text-slate-500">{hint}</p> : null}
    </label>
  );
}

function ProviderFields({
  channel,
  form,
  setForm,
  facebookOAuthBusy,
  facebookOAuthPages,
  selectedFacebookPageId,
  onLaunchFacebookOAuth,
  onSelectFacebookPage,
}: {
  channel: Channel;
  form: ChannelFormState;
  setForm: React.Dispatch<React.SetStateAction<ChannelFormState>>;
  facebookOAuthBusy: boolean;
  facebookOAuthPages: FacebookOAuthPage[];
  selectedFacebookPageId: string;
  onLaunchFacebookOAuth: () => Promise<void>;
  onSelectFacebookPage: (pageId: string) => void;
}) {
  const inputClass =
    "h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200";

  if (channel === "telegram") {
    return (
      <>
        <Field label="Bot token">
          <input
            type="password"
            value={form.token}
            onChange={(event) =>
              setForm((current) => ({ ...current, token: event.target.value }))
            }
            autoComplete="new-password"
            className={inputClass}
            placeholder="Telegram bot token"
          />
        </Field>

        <Field
          label="Webhook secret"
          hint="Optional. The backend can generate this if you leave it blank."
        >
          <input
            type="password"
            value={form.webhookSecret}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                webhookSecret: event.target.value,
              }))
            }
            autoComplete="new-password"
            className={inputClass}
            placeholder="Optional webhook secret"
          />
        </Field>
      </>
    );
  }

  if (channel === "viber") {
    return (
      <>
        <Field label="Auth token">
          <input
            type="password"
            value={form.token}
            onChange={(event) =>
              setForm((current) => ({ ...current, token: event.target.value }))
            }
            autoComplete="new-password"
            className={inputClass}
            placeholder="Viber auth token"
          />
        </Field>

        <Field
          label="Connection key"
          hint="Optional. Used in the webhook query string to identify the connection."
        >
          <input
            value={form.connectionKey}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                connectionKey: event.target.value,
              }))
            }
            autoComplete="off"
            className={inputClass}
            placeholder="Optional connection key"
          />
        </Field>
      </>
    );
  }

  if (channel === "facebook") {
    return (
      <>
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-900">Authorize Page access</p>
              <p className="mt-1 text-sm text-slate-600">
                Sign in with Facebook to load the Pages you manage, then select the Page to connect to this workspace.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void onLaunchFacebookOAuth()}
              disabled={facebookOAuthBusy}
              className="inline-flex h-10 items-center justify-center rounded-xl border border-blue-300 bg-white px-4 text-sm font-medium text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {facebookOAuthBusy ? "Opening..." : "Sign in with Facebook"}
            </button>
          </div>

          {facebookOAuthPages.length ? (
            <div className="mt-3">
              <label className="block text-xs font-medium uppercase tracking-widest text-slate-500">
                Managed Page
              </label>
              <select
                value={selectedFacebookPageId}
                onChange={(event) => onSelectFacebookPage(event.target.value)}
                className="mt-1 h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              >
                <option value="">Select a managed Page</option>
                {facebookOAuthPages.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.name} ({page.id})
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-slate-500">
                Selecting a Page fills the access token automatically. You can also enter a Page access token manually if needed.
              </p>
            </div>
          ) : null}
        </div>

        <Field
          label="Page access token"
          hint="Save the Page access token on this workspace connection. Messenger app credentials and webhook verification settings remain on the server."
        >
          <input
            type="password"
            value={form.token}
            onChange={(event) =>
              setForm((current) => ({ ...current, token: event.target.value }))
            }
            autoComplete="new-password"
            className={inputClass}
            placeholder="Facebook page access token"
          />
        </Field>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          Messenger app credentials are managed on the server, not in this form.
          Set `META_APP_ID`, `META_APP_SECRET`, and `META_WEBHOOK_VERIFY_TOKEN`, then verify the callback URL in the Meta App Dashboard using `/webhooks/facebook`.
        </div>
      </>
    );
  }

  if (channel === "tiktok") {
    return (
      <>
        <Field
          label="Business ID"
          hint="The TikTok Business account identifier (business_id / open_id) for this workspace connection."
        >
          <input
            value={form.businessId}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                businessId: event.target.value,
              }))
            }
            autoComplete="off"
            className={inputClass}
            placeholder="TikTok business_id"
          />
        </Field>

        <Field
          label="Access token"
          hint="Short-lived TikTok Business account token. The server will refresh it when a refresh token is available."
        >
          <input
            type="password"
            value={form.token}
            onChange={(event) =>
              setForm((current) => ({ ...current, token: event.target.value }))
            }
            autoComplete="new-password"
            className={inputClass}
            placeholder="TikTok access token"
          />
        </Field>

        <Field
          label="Refresh token"
          hint="Recommended. TikTok access tokens expire quickly; refresh tokens keep the inbox connection working."
        >
          <input
            type="password"
            value={form.refreshToken}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                refreshToken: event.target.value,
              }))
            }
            autoComplete="new-password"
            className={inputClass}
            placeholder="TikTok refresh token"
          />
        </Field>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          TikTok app credentials are not entered here.
          Set `TIKTOK_APP_ID` and `TIKTOK_APP_SECRET` on the server, then store the business access token in this workspace connection.
        </div>
      </>
    );
  }

  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4">
      <p className="text-sm font-medium text-slate-900">Pending provider verification</p>
      <p className="mt-1 text-sm text-slate-500">
        TikTok messaging remains scaffold-only until public business messaging support is verified.
      </p>
    </div>
  );
}

function ConnectionCard({
  connection,
  isSelected,
  busyAction,
  onEdit,
  onReconnect,
  onDelete,
}: {
  connection: ChannelConnection;
  isSelected: boolean;
  busyAction: "reconnect" | "delete" | null;
  onEdit: (connection: ChannelConnection) => void;
  onReconnect: (connection: ChannelConnection) => void;
  onDelete: (connection: ChannelConnection) => void;
}) {
  return (
    <article
      className={[
        "rounded-2xl border p-4 transition",
        isSelected
          ? "border-slate-900 bg-slate-50 shadow-sm"
          : "border-slate-200 bg-white",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-900">
              {connection.displayName || channelMeta[connection.channel].label}
            </h3>
            <StatusBadge
              label={connection.status}
              tone={getStatusTone(connection.status)}
            />
            <StatusBadge label={connection.channel} />
          </div>

          <p className="mt-2 text-sm text-slate-500">
            {connection.externalAccountId || "No external account id"}
          </p>
        </div>

        {isSelected ? <StatusBadge label="Selected" tone="blue" /> : null}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <p className="text-xs uppercase tracking-[0.12em] text-slate-500">
            Verification
          </p>
          <p className="mt-1 text-sm font-medium text-slate-90 capitalize">
            {connection.verificationState}
          </p>
        </div>

        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <p className="text-xs uppercase tracking-[0.12em] text-slate-500">
            Webhook verified
          </p>
          <p className="mt-1 text-sm font-medium text-slate-900">
            {connection.webhookVerified ? "Yes" : "No"}
          </p>
        </div>

        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <p className="text-xs uppercase tracking-[0.12em] text-slate-500">
            Last inbound
          </p>
          <p className="mt-1 text-sm font-medium text-slate-900">
            {connection.lastInboundAt
              ? new Date(connection.lastInboundAt).toLocaleString()
              : "None"}
          </p>
        </div>

        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <p className="text-xs uppercase tracking-[0.12em] text-slate-500">
            Last outbound
          </p>
          <p className="mt-1 text-sm font-medium text-slate-900">
            {connection.lastOutboundAt
              ? new Date(connection.lastOutboundAt).toLocaleString()
              : "None"}
          </p>
        </div>
      </div>

      {connection.webhookUrl ? (
        <div className="mt-4 rounded-xl bg-slate-950 px-3 py-2 text-xs text-slate-100">
          {connection.webhookUrl}
        </div>
      ) : null}

      {connection.lastError ? (
        <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {connection.lastError}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onEdit(connection)}
          className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-300 px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => onReconnect(connection)}
          disabled={busyAction !== null}
          className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-300 px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busyAction === "reconnect" ? "Reconnecting..." : "Reconnect"}
        </button>
        <button
          type="button"
          onClick={() => onDelete(connection)}
          disabled={busyAction !== null}
          className="inline-flex h-10 items-center justify-center rounded-xl border border-rose-300 px-4 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busyAction === "delete" ? "Deleting..." : "Delete"}
        </button>
      </div>
    </article>
  );
}

function formStateFromConnection(connection: ChannelConnection): ChannelFormState {
  return {
    displayName: connection.displayName || "",
    token: "",
    refreshToken: "",
    businessId:
      (typeof connection.credentials.businessId === "string" &&
        connection.credentials.businessId) ||
      connection.externalAccountId ||
      "",
    webhookSecret: "",
    verifyToken: "",
    appSecret: "",
    connectionKey:
      typeof connection.webhookConfig.connectionKey === "string"
        ? connection.webhookConfig.connectionKey
        : "",
  };
}

export function ChannelsPage() {
  const { activeWorkspace } = useSession();
  const workspaceId = activeWorkspace?._id;

  const [connections, setConnections] = useState<ChannelConnection[]>([]);
  const [channel, setChannel] = useState<Channel>("telegram");
  const [form, setForm] = useState<ChannelFormState>(initialFormState);
  const [diagnostics, setDiagnostics] = useState<ConnectionDiagnostics | null>(null);

  const [isBooting, setIsBooting] = useState(true);
  const [action, setAction] = useState<"connect" | "test" | null>(null);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const [cardActionById, setCardActionById] = useState<Record<string, "reconnect" | "delete" | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [publicWebhookBaseUrl, setPublicWebhookBaseUrl] = useState("");
  const [supportedChannels, setSupportedChannels] = useState<Record<Channel, boolean>>({
    facebook: true,
    telegram: true,
    viber: true,
    tiktok: true,
  });
  const [facebookOAuthBusy, setFacebookOAuthBusy] = useState(false);
  const [facebookOAuthPages, setFacebookOAuthPages] = useState<FacebookOAuthPage[]>([]);
  const [selectedFacebookPageId, setSelectedFacebookPageId] = useState("");

  const loadConnections = useCallback(async () => {
    if (!workspaceId) return;

    const response = await apiRequest<ChannelsResponse>(
      "/api/channels",
      {},
      { workspaceId }
    );

    setConnections(response.items);
    setPublicWebhookBaseUrl(response.publicWebhookBaseUrl || "");
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;

    let cancelled = false;

    async function boot() {
      try {
        setIsBooting(true);
        setError(null);

        const [response, settingsResponse] = await Promise.all([
          apiRequest<ChannelsResponse>("/api/channels", {}, { workspaceId }),
          apiRequest<{ settings: AISettings | null }>("/api/ai-settings", {}, { workspaceId }),
        ]);

        if (!cancelled) {
          setConnections(response.items);
          setPublicWebhookBaseUrl(response.publicWebhookBaseUrl || "");
          setSupportedChannels(
            settingsResponse.settings?.supportedChannels ?? {
              facebook: true,
              telegram: true,
              viber: true,
              tiktok: true,
            }
          );
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load channel connections.");
        }
      } finally {
        if (!cancelled) {
          setIsBooting(false);
        }
      }
    }

    void boot();

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }

    const socket = connectWorkspaceSocket(workspaceId);
    const refreshConnections = () => {
      void loadConnections();
    };

    socket.on("connection.updated", refreshConnections);

    return () => {
      socket.off("connection.updated", refreshConnections);
      socket.disconnect();
    };
  }, [loadConnections, workspaceId]);

  useEffect(() => {
    setDiagnostics(null);
    setError(null);
    setForm((current) => ({
      ...current,
      token: "",
      refreshToken: "",
      businessId: "",
      webhookSecret: "",
      verifyToken: "",
      appSecret: "",
      connectionKey: "",
    }));
    if (channel !== "facebook") {
      setSelectedFacebookPageId("");
    }
  }, [channel]);

  const formPayload = useMemo(() => {
    const credentials: Record<string, unknown> = {};
    const webhookConfig: Record<string, unknown> = {};

    if (channel === "telegram") {
      if (form.token.trim()) {
        credentials.botToken = form.token.trim();
      }
      if (form.webhookSecret.trim()) {
        credentials.webhookSecret = form.webhookSecret.trim();
      }
    }

    if (channel === "viber") {
      if (form.token.trim()) {
        credentials.authToken = form.token.trim();
      }
      if (form.connectionKey.trim()) {
        webhookConfig.connectionKey = form.connectionKey.trim();
      }
    }

    if (channel === "facebook") {
      if (form.token.trim()) {
        credentials.pageAccessToken = form.token.trim();
      }
    }

    if (channel === "tiktok") {
      if (form.token.trim()) {
        credentials.accessToken = form.token.trim();
      }
      if (form.refreshToken.trim()) {
        credentials.refreshToken = form.refreshToken.trim();
      }
      if (form.businessId.trim()) {
        credentials.businessId = form.businessId.trim();
      }
    }

    return {
      workspaceId,
      displayName: form.displayName.trim() || undefined,
      credentials,
      webhookConfig,
    };
  }, [channel, form, workspaceId]);

  const handleConnect = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspaceId) return;

    try {
      setAction("connect");
      setError(null);

      const response = editingConnectionId
        ? await apiRequest<{ connection: ChannelConnection }>(
            `/api/channels/${editingConnectionId}`,
            {
              method: "PATCH",
              body: JSON.stringify(formPayload),
            }
          )
        : await apiRequest<{ connection: ChannelConnection }>(
            `/api/channels/${channel}/connect`,
            {
              method: "POST",
              body: JSON.stringify(formPayload),
            }
          );

      setDiagnostics({
        status: response.connection.status,
        verificationState: response.connection.verificationState,
        webhookUrl: response.connection.webhookUrl,
        lastError: response.connection.lastError,
      });

      setEditingConnectionId(null);
      setForm(initialFormState);

      await loadConnections();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed.");
    } finally {
      setAction(null);
    }
  };

  const handleEdit = (connection: ChannelConnection) => {
    setChannel(connection.channel);
    setEditingConnectionId(connection._id);
    setDiagnostics(null);
    setError(null);
    setForm(formStateFromConnection(connection));
  };

  const handleCancelEdit = () => {
    setEditingConnectionId(null);
    setDiagnostics(null);
    setError(null);
    setForm(initialFormState);
  };

  const handleLaunchFacebookOAuth = async () => {
    if (!workspaceId) {
      return;
    }

    try {
      setFacebookOAuthBusy(true);
      setError(null);

      const start = await apiRequest<{
        state: string;
        authUrl: string;
        callbackOrigin: string;
      }>("/api/channels/facebook/oauth/start", {
        method: "POST",
        body: JSON.stringify({}),
      });

      const popup = window.open(
        start.authUrl,
        "facebook_oauth",
        "width=520,height=720,menubar=no,toolbar=no"
      );

      if (!popup) {
        throw new Error("Popup blocked. Allow popups and try again.");
      }

      const oauthPayload = await new Promise<{ code: string; state: string }>(
        (resolve, reject) => {
          const timeoutId = window.setTimeout(() => {
            cleanup();
            reject(new Error("Facebook login timed out. Please try again."));
          }, 120000);

          const closeWatcher = window.setInterval(() => {
            if (popup.closed) {
              cleanup();
              reject(new Error("Facebook login window was closed."));
            }
          }, 400);

          const cleanup = () => {
            window.clearTimeout(timeoutId);
            window.clearInterval(closeWatcher);
            window.removeEventListener("message", onMessage);
            try {
              if (!popup.closed) {
                popup.close();
              }
            } catch {}
          };

          const onMessage = (event: MessageEvent) => {
            if (event.origin !== start.callbackOrigin) {
              return;
            }

            const data = event.data as {
              source?: string;
              state?: string;
              code?: string;
              error?: string;
              errorDescription?: string;
            };

            if (data?.source !== "facebook-oauth") {
              return;
            }

            if (data.error) {
              cleanup();
              reject(new Error(data.errorDescription || "Facebook login failed."));
              return;
            }

            const incomingCode = typeof data.code === "string" ? data.code.trim() : "";
            const incomingState = typeof data.state === "string" ? data.state.trim() : "";

            if (!incomingCode || !incomingState) {
              cleanup();
              reject(new Error("Facebook login did not return a valid code."));
              return;
            }

            cleanup();
            resolve({
              code: incomingCode,
              state: incomingState,
            });
          };

          window.addEventListener("message", onMessage);
        }
      );

      const exchange = await apiRequest<{ pages: FacebookOAuthPage[] }>(
        "/api/channels/facebook/oauth/exchange",
        {
          method: "POST",
          body: JSON.stringify(oauthPayload),
        }
      );

      setFacebookOAuthPages(exchange.pages);

      if (!exchange.pages.length) {
        setSelectedFacebookPageId("");
        setError("No pages were returned for this Facebook account.");
        return;
      }

      const defaultPage = exchange.pages[0];
      setSelectedFacebookPageId(defaultPage.id);
      setForm((current) => ({
        ...current,
        token: defaultPage.accessToken,
        displayName: current.displayName.trim() ? current.displayName : defaultPage.name,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Facebook login failed.");
    } finally {
      setFacebookOAuthBusy(false);
    }
  };

  const handleSelectFacebookPage = (pageId: string) => {
    setSelectedFacebookPageId(pageId);
    const page = facebookOAuthPages.find((item) => item.id === pageId);
    if (!page) {
      return;
    }

    setForm((current) => ({
      ...current,
      token: page.accessToken,
      displayName: current.displayName.trim() ? current.displayName : page.name,
    }));
  };

  const handleReconnect = async (connection: ChannelConnection) => {
    try {
      setCardActionById((current) => ({ ...current, [connection._id]: "reconnect" }));
      setError(null);

      const response = await apiRequest<{ connection: ChannelConnection }>(
        `/api/channels/${connection._id}/reconnect`,
        {
          method: "POST",
          body: JSON.stringify({}),
        }
      );

      setDiagnostics({
        status: response.connection.status,
        verificationState: response.connection.verificationState,
        webhookUrl: response.connection.webhookUrl,
        lastError: response.connection.lastError,
      });

      await loadConnections();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reconnect failed.");
    } finally {
      setCardActionById((current) => ({ ...current, [connection._id]: null }));
    }
  };

  const handleDelete = async (connection: ChannelConnection) => {
    const confirmed = window.confirm(
      `Delete the ${channelMeta[connection.channel].label} connection \"${connection.displayName || connection.externalAccountId}\"?`
    );

    if (!confirmed) {
      return;
    }

    try {
      setCardActionById((current) => ({ ...current, [connection._id]: "delete" }));
      setError(null);

      await apiRequest<{ deleted: boolean }>(`/api/channels/${connection._id}`, {
        method: "DELETE",
      });

      if (editingConnectionId === connection._id) {
        handleCancelEdit();
      }

      await loadConnections();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setCardActionById((current) => ({ ...current, [connection._id]: null }));
    }
  };

  const handleTest = async () => {
    if (!workspaceId) return;

    try {
      setAction("test");
      setError(null);

      const response = await apiRequest<{ diagnostics: ConnectionDiagnostics }>(
        `/api/channels/${channel}/test`,
        {
          method: "POST",
          body: JSON.stringify(formPayload),
        }
      );

      setDiagnostics(response.diagnostics);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed.");
    } finally {
      setAction(null);
    }
  };

  const selectedConnection =
    connections.find((item) => item.channel === channel) ?? null;
  const selectedConnectionId =
    editingConnectionId ??
    (connections.find((item) => item.channel === channel)?._id ?? null);
  const selectedChannelSupported = supportedChannels[channel];
  const selectedWebhookUrl = buildWebhookPreviewUrl({
    baseUrl: publicWebhookBaseUrl,
    channel,
    connectionKey: form.connectionKey,
  });

  if (!workspaceId) {
    return (
      <div className="p-6">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          No workspace session found.
        </div>
      </div>
    );
  }

  if (isBooting) {
    return (
      <div className="space-y-6 p-6">
        <div className="animate-pulse rounded-3xl border border-slate-200 bg-white p-6">
          <div className="h-4 w-24 rounded bg-slate-200" />
          <div className="mt-3 h-8 w-64 rounded bg-slate-200" />
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(360px,0.95fr)_minmax(0,1.05fr)]">
          <div className="space-y-4 rounded-3xl border border-slate-200 bg-white p-6">
            <div className="h-24 rounded-2xl bg-slate-100" />
            <div className="h-12 rounded-2xl bg-slate-100" />
            <div className="h-12 rounded-2xl bg-slate-100" />
            <div className="h-40 rounded-2xl bg-slate-100" />
          </div>

          <div className="space-y-3 rounded-3xl border border-slate-200 bg-white p-6">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-40 rounded-2xl bg-slate-100" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6 p-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Channels
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
              Real provider connections
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-slate-500">
              Connect external messaging providers, validate credentials, and inspect current channel health.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <StatusBadge label={`${connections.length} connections`} />
            {selectedConnection ? (
              <StatusBadge
                label={`${channelMeta[channel].label}: ${selectedConnection.status}`}
                tone={getStatusTone(selectedConnection.status)}
              />
            ) : (
              <StatusBadge label={`${channelMeta[channel].label}: not connected`} />
            )}
          </div>
        </div>
      </header>

      {error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(360px,0.95fr)_minmax(0,1.05fr)]">
        <section className="space-y-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">
              {editingConnectionId ? "Edit connection" : "Connect a channel"}
            </h3>
          </div>

          {!selectedChannelSupported ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              {channelMeta[channel].label} is currently disabled in Admin Settings. Enable it there before testing or saving a connection.
            </div>
          ) : null}

          <form className="space-y-5" onSubmit={handleConnect} autoComplete="off">
            <Field label="Channel">
              <select
                value={channel}
                onChange={(event) => setChannel(event.target.value as Channel)}
                className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              >
                {channelOptions.map((option) => (
                  <option key={option} value={option}>
                    {channelMeta[option].label}
                  </option>
                ))}
              </select>
            </Field>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-slate-900">
                  {channelMeta[channel].label}
                </p>
                <StatusBadge label={channel} />
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {channelMeta[channel].description}
              </p>
              <p className="mt-2 text-xs text-slate-500">
                {channelMeta[channel].credentialHint}
              </p>
              {selectedWebhookUrl ? (
                <div className="mt-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Callback URL
                  </p>
                  <div className="mt-1 rounded-xl bg-white px-3 py-2 text-xs text-slate-700 ring-1 ring-slate-200">
                    {selectedWebhookUrl}
                  </div>
                </div>
              ) : (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Set `PUBLIC_WEBHOOK_BASE_URL` on the server to generate the public callback URL for this channel.
                </div>
              )}
            </div>

            <Field label="Display name" hint="Optional internal label for this connection.">
              <input
                value={form.displayName}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    displayName: event.target.value,
                  }))
                }
                placeholder="Optional label"
                autoComplete="off"
                className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </Field>

            <ProviderFields
              channel={channel}
              form={form}
              setForm={setForm}
              facebookOAuthBusy={facebookOAuthBusy}
              facebookOAuthPages={facebookOAuthPages}
              selectedFacebookPageId={selectedFacebookPageId}
              onLaunchFacebookOAuth={handleLaunchFacebookOAuth}
              onSelectFacebookPage={handleSelectFacebookPage}
            />

            <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
              <button
                className="inline-flex h-11 items-center justify-center rounded-xl bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                disabled={action !== null || !selectedChannelSupported}
                type="submit"
              >
                {action === "connect"
                  ? "Saving..."
                  : editingConnectionId
                  ? "Save changes"
                  : "Save connection"}
              </button>

              <button
                className="inline-flex h-11 items-center justify-center rounded-xl border border-slate-300 px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={action !== null || !selectedChannelSupported}
                onClick={() => void handleTest()}
                type="button"
              >
                {action === "test" ? "Testing..." : "Test credentials"}
              </button>

              {editingConnectionId ? (
                <button
                  className="inline-flex h-11 items-center justify-center rounded-xl border border-slate-300 px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                  onClick={handleCancelEdit}
                  type="button"
                >
                  Cancel edit
                </button>
              ) : null}
            </div>
          </form>

          {diagnostics ? (
            <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold text-slate-900">Latest validation</h4>
                <StatusBadge
                  label={diagnostics.status}
                  tone={getStatusTone(diagnostics.status)}
                />
                <StatusBadge label={diagnostics.verificationState} />
              </div>

              {diagnostics.webhookUrl ? (
                <div className="mt-3 rounded-xl bg-slate-950 px-3 py-2 text-xs text-slate-100">
                  {diagnostics.webhookUrl}
                </div>
              ) : null}

              {diagnostics.lastError ? (
                <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {diagnostics.lastError}
                </div>
              ) : null}

              {diagnostics.diagnostics ? (
                <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-950 p-3 text-xs text-slate-100">
                  {JSON.stringify(diagnostics.diagnostics, null, 2)}
                </pre>
              ) : null}
            </article>
          ) : null}

          {selectedConnection ? (
            <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <h4 className="text-sm font-semibold text-slate-900">Selected channel state</h4>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-500">Status</p>
                  <p className="mt-1 text-sm font-medium text-slate-900">
                    {selectedConnection.status}
                  </p>
                </div>
                <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-500">
                    Verification
                  </p>
                  <p className="mt-1 text-sm font-medium text-slate-900 capitalize">
                    {selectedConnection.verificationState}
                  </p>
                </div>
                <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-500">
                    Webhook verified
                  </p>
                  <p className="mt-1 text-sm font-medium text-slate-900">
                    {selectedConnection.webhookVerified ? "Yes" : "No"}
                  </p>
                </div>
              </div>
            </article>
          ) : null}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Workspace connections
            </p>
            <h3 className="mt-2 text-lg font-semibold text-slate-900">
              Current provider states
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Review existing channel connections, verification state, and recent delivery activity.
            </p>
          </div>

          <div className="mt-6 space-y-3">
            {connections.length ? (
              connections.map((connection) => (
                <ConnectionCard
                  key={connection._id}
                  connection={connection}
                  isSelected={connection._id === selectedConnectionId}
                  busyAction={cardActionById[connection._id] ?? null}
                  onEdit={handleEdit}
                  onReconnect={(item) => void handleReconnect(item)}
                  onDelete={(item) => void handleDelete(item)}
                />
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-500">
                No channel connections yet. This workspace stays empty until real provider credentials are saved and validated.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
