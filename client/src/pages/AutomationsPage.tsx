import { FormEvent, useCallback, useEffect, useState } from "react";
import { useSession } from "../hooks/use-session";
import { apiRequest } from "../services/api";
import { AutomationState, BusinessHoursDay } from "../types/models";

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DEFAULT_FALLBACK_TEXT = "Thanks for your message. We will reply soon.";

const defaultSchedule = (): BusinessHoursDay[] =>
  weekdayLabels.map((_, dayOfWeek) => ({
    dayOfWeek,
    enabled: dayOfWeek >= 1 && dayOfWeek <= 5,
    windows: [{ start: "09:00", end: "18:00" }],
  }));

type ToggleRowProps = {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
};

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-900">{label}</p>
        <p className="mt-1 text-sm text-slate-500">{description}</p>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={[
          "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition",
          checked ? "bg-slate-900" : "bg-slate-300",
        ].join(" ")}
      >
        <span
          className={[
            "inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition",
            checked ? "translate-x-6" : "translate-x-1",
          ].join(" ")}
        />
      </button>
    </div>
  );
}

type DayScheduleRowProps = {
  day: BusinessHoursDay;
  label: string;
  onToggle: (dayOfWeek: number, enabled: boolean) => void;
  onTimeChange: (dayOfWeek: number, field: "start" | "end", value: string) => void;
};

function DayScheduleRow({
  day,
  label,
  onToggle,
  onTimeChange,
}: DayScheduleRowProps) {
  const start = day.windows[0]?.start ?? "09:00";
  const end = day.windows[0]?.end ?? "18:00";

  return (
    <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center justify-between gap-4 lg:min-w-45">
          <div>
            <p className="text-sm font-medium text-slate-900">{label}</p>
            <p className="mt-1 text-xs text-slate-500">
              {day.enabled ? "Business hours active" : "Closed all day"}
            </p>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={day.enabled}
            onClick={() => onToggle(day.dayOfWeek, !day.enabled)}
            className={[
              "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition",
              day.enabled ? "bg-slate-900" : "bg-slate-300",
            ].join(" ")}
          >
            <span
              className={[
                "inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition",
                day.enabled ? "translate-x-6" : "translate-x-1",
              ].join(" ")}
            />
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:w-[320px]">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
              Start
            </span>
            <input
              type="time"
              value={start}
              disabled={!day.enabled}
              onChange={(event) =>
                onTimeChange(day.dayOfWeek, "start", event.target.value)
              }
              className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
              End
            </span>
            <input
              type="time"
              value={end}
              disabled={!day.enabled}
              onChange={(event) =>
                onTimeChange(day.dayOfWeek, "end", event.target.value)
              }
              className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
            />
          </label>
        </div>
      </div>
    </article>
  );
}

export function AutomationsPage() {
  const { activeWorkspace } = useSession();
  const workspaceId = activeWorkspace?._id;

  const [timeZone, setTimeZone] = useState("UTC");
  const [schedule, setSchedule] = useState<BusinessHoursDay[]>(defaultSchedule());
  const [ruleName, setRuleName] = useState("After Hours");
  const [fallbackText, setFallbackText] = useState(DEFAULT_FALLBACK_TEXT);
  const [isActive, setIsActive] = useState(true);

  const [isBooting, setIsBooting] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    if (!workspaceId) return;

    const response = await apiRequest<AutomationState>(
      "/api/automations",
      {},
      { workspaceId }
    );

    if (response.businessHours) {
      setTimeZone(response.businessHours.timeZone || "UTC");
      setSchedule(
        response.businessHours.weeklySchedule?.length
          ? response.businessHours.weeklySchedule
          : defaultSchedule()
      );
    } else {
      setTimeZone("UTC");
      setSchedule(defaultSchedule());
    }

    if (response.afterHoursRule) {
      setRuleName(response.afterHoursRule.name || "After Hours");
      setIsActive(Boolean(response.afterHoursRule.isActive));
      setFallbackText(
        response.afterHoursRule.action?.fallbackText ?? DEFAULT_FALLBACK_TEXT
      );
    } else {
      setRuleName("After Hours");
      setIsActive(true);
      setFallbackText(DEFAULT_FALLBACK_TEXT);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;

    let cancelled = false;

    async function boot() {
      try {
        setIsBooting(true);
        setError(null);
        await loadState();
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load automation settings."
          );
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
  }, [workspaceId, loadState]);

  const handleScheduleToggle = (dayOfWeek: number, enabled: boolean) => {
    setSchedule((current) =>
      current.map((day) =>
        day.dayOfWeek === dayOfWeek ? { ...day, enabled } : day
      )
    );
  };

  const handleScheduleTimeChange = (
    dayOfWeek: number,
    field: "start" | "end",
    value: string
  ) => {
    setSchedule((current) =>
      current.map((day) => {
        if (day.dayOfWeek !== dayOfWeek) return day;

        const currentWindow = day.windows[0] ?? { start: "09:00", end: "18:00" };

        return {
          ...day,
          windows: [
            {
              ...currentWindow,
              [field]: value,
            },
          ],
        };
      })
    );
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspaceId) return;

    try {
      setIsSaving(true);
      setError(null);

      await apiRequest("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({
          workspaceId,
          businessHours: {
            timeZone,
            weeklySchedule: schedule,
          },
          afterHoursRule: {
            name: ruleName,
            isActive,
            fallbackText,
          },
        }),
      });

      await loadState();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save automation settings."
      );
    } finally {
      setIsSaving(false);
    }
  };

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
          <div className="mt-3 h-8 w-80 rounded bg-slate-200" />
        </div>

        <div className="space-y-6 rounded-3xl border border-slate-200 bg-white p-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="h-24 rounded-2xl bg-slate-100" />
            <div className="h-24 rounded-2xl bg-slate-100" />
          </div>
          <div className="h-32 rounded-2xl bg-slate-100" />
          <div className="h-24 rounded-2xl bg-slate-100" />
          <div className="space-y-3">
            {Array.from({ length: 7 }).map((_, index) => (
              <div key={index} className="h-24 rounded-2xl bg-slate-100" />
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
              Automation
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
              Business hours and after-hours reply policy
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-slate-500">
              Define your staff&rsquo;s weekly working hours and configure the
              automated reply sent to customers who contact you outside those
              hours.
            </p>
          </div>

          <span
            className={[
              "inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1",
              isActive
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                : "bg-slate-100 text-slate-600 ring-slate-200",
            ].join(" ")}
          >
            {isActive ? "After-hours reply on" : "After-hours reply off"}
          </span>
        </div>
      </header>

      {error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      <form
        className="space-y-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
        onSubmit={handleSubmit}
      >
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            Rule configuration
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            Configure the automated reply sent to customers when your team is
            offline. This only fires when using the AI auto-reply feature.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-900">
              Time zone
            </span>
            <input
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
              placeholder="UTC"
              className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-900">
              Rule name
            </span>
            <input
              value={ruleName}
              onChange={(event) => setRuleName(event.target.value)}
              placeholder="After Hours"
              className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            />
          </label>
        </div>

        <ToggleRow
          label="After-hours reply enabled"
          description="When enabled, customers who message outside your staff working hours automatically receive the fallback reply below."
          checked={isActive}
          onChange={setIsActive}
        />

        <div>
          <label
            htmlFor="automation-fallback-text"
            className="text-sm font-medium text-slate-900"
          >
            Fallback text
          </label>
          <p className="mt-1 text-sm text-slate-500">
            Sent when a message arrives outside your configured business hours.
          </p>

          <textarea
            id="automation-fallback-text"
            rows={5}
            value={fallbackText}
            onChange={(event) => setFallbackText(event.target.value)}
            className="mt-3 w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            placeholder={DEFAULT_FALLBACK_TEXT}
          />
        </div>

        <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div>
            <h4 className="text-sm font-semibold text-slate-900">
              Staff working hours
            </h4>
            <p className="mt-1 text-sm text-slate-500">
              Set the hours your team is available each day. Messages received
              outside these windows are treated as after-hours. Disabled days
              are treated as fully closed.
            </p>
          </div>

          <div className="mt-4 space-y-3">
            {schedule.map((day) => (
              <DayScheduleRow
                key={day.dayOfWeek}
                day={day}
                label={weekdayLabels[day.dayOfWeek]}
                onToggle={handleScheduleToggle}
                onTimeChange={handleScheduleTimeChange}
              />
            ))}
          </div>
        </section>

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-4">
          <p className="text-sm text-slate-500">
            Changes apply immediately to the workspace-level after-hours rule.
          </p>

          <button
            className="inline-flex h-11 items-center justify-center rounded-xl bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            type="submit"
            disabled={isSaving}
          >
            {isSaving ? "Saving..." : "Save automation"}
          </button>
        </div>
      </form>
    </div>
  );
}