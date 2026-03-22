import { ChannelConnection } from "../../types/models";
import { StatusBadge } from "../ui/StatusBadge";

type ChannelMetaMap = Record<
  string,
  {
    label: string;
  }
>;

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

type Props = {
  connection: ChannelConnection;
  isSelected: boolean;
  channelMeta: ChannelMetaMap;
};

export function ChannelConnectionCard({
  connection,
  isSelected,
  channelMeta,
}: Props) {
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
          <p className="mt-1 text-sm font-medium text-slate-900 capitalize">
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
    </article>
  );
}