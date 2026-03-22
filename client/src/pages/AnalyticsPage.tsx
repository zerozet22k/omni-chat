import { useEffect, useMemo, useState } from "react";
import { useSession } from "../hooks/use-session";
import { apiRequest } from "../services/api";
import { Conversation } from "../types/models";

type StatCardProps = {
  label: string;
  value: number;
  tone?: "default" | "amber" | "blue" | "emerald";
};

function StatCard({ label, value, tone = "default" }: StatCardProps) {
  const toneClass =
    tone === "amber"
      ? "bg-amber-50 text-amber-700 ring-amber-200"
      : tone === "blue"
        ? "bg-blue-50 text-blue-700 ring-blue-200"
        : tone === "emerald"
          ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
          : "bg-slate-100 text-slate-700 ring-slate-200";

  return (
    <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            {label}
          </p>
          <strong className="mt-3 block text-3xl font-semibold tracking-tight text-slate-900">
            {value}
          </strong>
        </div>

        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${toneClass}`}>
          {label}
        </span>
      </div>
    </article>
  );
}

type ChannelRowProps = {
  label: string;
  total: number;
  percentage: number;
};

function ChannelRow({ label, total, percentage }: ChannelRowProps) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium capitalize text-slate-900">{label}</p>
          <p className="mt-1 text-xs text-slate-500">{percentage}% of total conversations</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold text-slate-900">{total}</p>
          <p className="text-xs text-slate-500">conversations</p>
        </div>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full rounded-full bg-slate-900 transition-all"
          style={{ width: `${Math.max(percentage, total > 0 ? 6 : 0)}%` }}
        />
      </div>
    </article>
  );
}

export function AnalyticsPage() {
  const { activeWorkspace } = useSession();
  const workspaceId = activeWorkspace?._id;

  const [items, setItems] = useState<Conversation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;

    let cancelled = false;

    async function loadConversations() {
      try {
        setIsLoading(true);
        setError(null);

        const response = await apiRequest<{ items: Conversation[] }>(
          "/api/conversations",
          {},
          { workspaceId }
        );

        if (!cancelled) {
          setItems(response.items);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load analytics data."
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadConversations();

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const handleRefresh = async () => {
    if (!workspaceId) return;

    try {
      setIsRefreshing(true);
      setError(null);

      const response = await apiRequest<{ items: Conversation[] }>(
        "/api/conversations",
        {},
        { workspaceId }
      );

      setItems(response.items);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to refresh analytics data."
      );
    } finally {
      setIsRefreshing(false);
    }
  };

  const metrics = useMemo(() => {
    const unread = items.reduce((sum, item) => sum + item.unreadCount, 0);
    const open = items.filter((item) => item.status === "open").length;
    const pending = items.filter((item) => item.status === "pending").length;
    const resolved = items.filter((item) => item.status === "resolved").length;

    const channels = ["facebook", "telegram", "viber", "tiktok"] as const;

    const byChannel = channels.map((channel) => {
      const total = items.filter((item) => item.channel === channel).length;
      const percentage = items.length ? Math.round((total / items.length) * 100) : 0;

      return {
        channel,
        total,
        percentage,
      };
    });

    return {
      total: items.length,
      unread,
      open,
      pending,
      resolved,
      byChannel,
    };
  }, [items]);

  if (!workspaceId) {
    return (
      <div className="p-6">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          No workspace session found.
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <div className="animate-pulse rounded-3xl border border-slate-200 bg-white p-6">
          <div className="h-4 w-24 rounded bg-slate-200" />
          <div className="mt-3 h-8 w-72 rounded bg-slate-200" />
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="h-32 animate-pulse rounded-3xl border border-slate-200 bg-white"
            />
          ))}
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
          <div className="h-72 animate-pulse rounded-3xl border border-slate-200 bg-white" />
          <div className="h-72 animate-pulse rounded-3xl border border-slate-200 bg-white" />
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
              Analytics
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
              Basic operational summary
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-slate-500">
              Monitor inbox volume, response load, and channel mix across the workspace.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
            className="inline-flex h-11 items-center justify-center rounded-xl border border-slate-300 px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </header>

      {error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Unread" value={metrics.unread} tone="amber" />
        <StatCard label="Open" value={metrics.open} tone="blue" />
        <StatCard label="Pending" value={metrics.pending} tone="default" />
        <StatCard label="Resolved" value={metrics.resolved} tone="emerald" />
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Overview
              </p>
              <h3 className="mt-2 text-lg font-semibold text-slate-900">
                Conversation breakdown
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Quick summary of current inbox state.
              </p>
            </div>

            <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
              {metrics.total} total
            </span>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Unread per conversation</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
                {metrics.total ? (metrics.unread / metrics.total).toFixed(1) : "0.0"}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Resolution rate</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
                {metrics.total
                  ? `${Math.round((metrics.resolved / metrics.total) * 100)}%`
                  : "0%"}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Open + pending</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
                {metrics.open + metrics.pending}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Resolved conversations</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
                {metrics.resolved}
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Channels
            </p>
            <h3 className="mt-2 text-lg font-semibold text-slate-900">
              Distribution by platform
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              See where conversation volume is coming from.
            </p>
          </div>

          <div className="mt-6 space-y-3">
            {metrics.byChannel.map((entry) => (
              <ChannelRow
                key={entry.channel}
                label={entry.channel}
                total={entry.total}
                percentage={entry.percentage}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}