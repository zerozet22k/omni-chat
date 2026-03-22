import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../hooks/use-session";
import { connectWorkspaceSocket } from "../services/realtime";
import {
  shouldPlayInboundNotification,
  type MessageReceivedRealtimePayload,
} from "../utils/inbound-notification";

const navItems = [
  { to: "/inbox", label: "Inbox", adminOnly: false },
  { to: "/channels", label: "Channels", adminOnly: true },
  { to: "/knowledge", label: "Knowledge", adminOnly: false },
  { to: "/canned-replies", label: "Canned Replies", adminOnly: true },
  { to: "/automations", label: "Automations", adminOnly: true },
  { to: "/ai-settings", label: "Admin Settings", adminOnly: true },
  { to: "/workspace-members", label: "Workspace Members", adminOnly: true },
  { to: "/analytics", label: "Analytics", adminOnly: false },
] as const;

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function AppShell() {
  const {
    session,
    activeWorkspace,
    isAdmin,
    deployment,
    setActiveWorkspaceId,
    logout,
  } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const notifiedInboundMessageIdsRef = useRef<Set<string>>(new Set());
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem("omni-chat-sidebar-collapsed") === "true";
  });
  const activeWorkspaceId = activeWorkspace?._id ?? null;

  const showWorkspaceSwitcher =
    deployment.tenantMode !== "single" &&
    (session?.workspaces?.length ?? 0) > 1;

  useEffect(() => {
    if (
      !activeWorkspaceId ||
      typeof window === "undefined" ||
      typeof Notification === "undefined"
    ) {
      return;
    }

    const socket = connectWorkspaceSocket(activeWorkspaceId);

    const showBrowserNotification = async (
      payload: MessageReceivedRealtimePayload
    ) => {
      if (location.pathname === "/inbox" && document.visibilityState === "visible") {
        return;
      }

      let permission = Notification.permission;
      if (permission === "default") {
        permission = await Notification.requestPermission();
      }

      if (permission !== "granted") {
        return;
      }

      const notification = new Notification("New message received", {
        body: "Open inbox to view the latest customer message.",
        tag: payload.messageId ?? payload.conversationId ?? "omni-chat-inbound",
      });

      notification.onclick = () => {
        window.focus();
        navigate("/inbox");
        notification.close();
      };
    };

    const onMessageReceived = (payload: unknown) => {
      const normalized =
        typeof payload === "object" && payload
          ? (payload as MessageReceivedRealtimePayload)
          : {};

      if (
        !shouldPlayInboundNotification(
          normalized,
          notifiedInboundMessageIdsRef.current
        )
      ) {
        return;
      }

      const messageId = normalized.messageId?.trim();
      if (!messageId) {
        return;
      }

      notifiedInboundMessageIdsRef.current.add(messageId);
      void showBrowserNotification(normalized);
    };

    socket.on("message.received", onMessageReceived);

    return () => {
      socket.off("message.received", onMessageReceived);
      socket.disconnect();
    };
  }, [activeWorkspaceId, location.pathname, navigate]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      "omni-chat-sidebar-collapsed",
      isSidebarCollapsed ? "true" : "false"
    );
  }, [isSidebarCollapsed]);

  return (
    <div className="h-dvh max-h-dvh overflow-hidden bg-slate-100 text-slate-900">
      <div
        className={`grid h-full min-h-0 ${
          isSidebarCollapsed ? "grid-cols-[76px_1fr]" : "grid-cols-[260px_1fr]"
        }`}
      >
        <aside className="flex h-full min-h-0 flex-col overflow-hidden border-r border-slate-200 bg-slate-950 text-slate-100">
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-6">
              <div className="flex items-center justify-between gap-2">
                {!isSidebarCollapsed ? (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      Seller Console
                    </p>
                    <h1 className="mt-2 text-2xl font-semibold tracking-tight">
                      Elqen Zero
                    </h1>
                    <p className="mt-1 text-sm text-slate-400">
                      {activeWorkspace?.name ?? "Workspace"}
                    </p>
                  </div>
                ) : (
                  <h1 className="mx-auto text-lg font-semibold tracking-tight">EZ</h1>
                )}

                <button
                  type="button"
                  onClick={() => setIsSidebarCollapsed((current) => !current)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-sm text-slate-200 hover:bg-white/10"
                  title={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                  aria-label={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                >
                  {isSidebarCollapsed ? ">>" : "<<"}
                </button>
              </div>

              {showWorkspaceSwitcher && !isSidebarCollapsed ? (
                <select
                  value={activeWorkspace?._id ?? ""}
                  onChange={(event) => setActiveWorkspaceId(event.target.value)}
                  className="mt-3 w-full rounded-lg border border-white/10 bg-slate-900 px-2 py-2 text-sm text-slate-100"
                >
                  {(session?.workspaces ?? []).map((workspace) => (
                    <option key={workspace._id} value={workspace._id}>
                      {workspace.name} ({workspace.role})
                    </option>
                  ))}
                </select>
              ) : null}
            </div>

            <nav className="space-y-1">
              {navItems
                .filter((item) => !item.adminOnly || isAdmin)
                .map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === "/inbox"}
                    title={item.label}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center rounded-xl px-3 py-2.5 text-sm font-medium transition",
                        isSidebarCollapsed && "justify-center px-2",
                        isActive
                          ? "bg-white text-slate-950 shadow-sm"
                          : "text-slate-300 hover:bg-slate-900 hover:text-white"
                      )
                    }
                  >
                    {isSidebarCollapsed ? item.label.slice(0, 1) : item.label}
                  </NavLink>
                ))}
            </nav>
          </div>

          <div className="border-t border-white/10 p-4">
            <div
              className={cn(
                "flex items-center gap-3",
                isSidebarCollapsed && "justify-center"
              )}
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-800 text-sm font-semibold">
                {(session?.user?.name?.[0] ?? "U").toUpperCase()}
              </div>
              {!isSidebarCollapsed ? (
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">
                    {session?.user?.name ?? "Owner"}
                  </p>
                  <p className="truncate text-xs text-slate-400">
                    {activeWorkspace?.role ?? "Workspace member"}
                  </p>
                </div>
              ) : null}
            </div>

            <button
              type="button"
              onClick={logout}
              className={cn(
                "mt-4 rounded-xl border border-white/10 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/5",
                isSidebarCollapsed ? "w-10 px-0" : "w-full"
              )}
              title="Sign out"
            >
              {isSidebarCollapsed ? "<-" : "Sign out"}
            </button>
          </div>
        </aside>

        <main className="h-full min-w-0 min-h-0 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
