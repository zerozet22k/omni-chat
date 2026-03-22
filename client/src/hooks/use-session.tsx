import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { apiRequest, setApiAuthContext } from "../services/api";
import { SessionData } from "../types/models";

const STORAGE_KEY = "omni-chat-session";

export type TenantMode = "single" | "multi";

export type DeploymentConfig = {
  tenantMode: TenantMode;
  allowSignup: boolean;
};

/** Read deployment config from build-time VITE_ env. */
const readDeploymentConfig = (): DeploymentConfig => ({
  tenantMode:
    (import.meta.env.VITE_TENANT_MODE as TenantMode | undefined) === "single"
      ? "single"
      : "multi",
  allowSignup: import.meta.env.VITE_ALLOW_SIGNUP !== "false",
});

type SessionContextValue = {
  session: SessionData | null;
  activeWorkspace: SessionData["workspaces"][number] | null;
  isAdmin: boolean;
  loading: boolean;
  deployment: DeploymentConfig;
  login: (payload: {
    email: string;
    password: string;
  }) => Promise<void>;
  register: (payload: {
    name: string;
    email: string;
    password: string;
    workspaceSlug: string;
    workspaceName: string;
    timeZone?: string;
  }) => Promise<void>;
  setActiveWorkspaceId: (workspaceId: string) => void;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const hydrate = async () => {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        setLoading(false);
        return;
      }

      const parsed = JSON.parse(raw) as SessionData;
      setApiAuthContext({
        token: parsed.token,
        workspaceId: parsed.activeWorkspaceId,
      });

      try {
        const me = await apiRequest<{
          user: SessionData["user"];
          workspaces: SessionData["workspaces"];
        }>("/api/auth/me");

        const fallbackWorkspaceId = me.workspaces[0]?._id ?? "";
        const activeWorkspaceId = me.workspaces.some(
          (workspace) => workspace._id === parsed.activeWorkspaceId
        )
          ? parsed.activeWorkspaceId
          : fallbackWorkspaceId;

        const nextSession: SessionData = {
          token: parsed.token,
          user: me.user,
          workspaces: me.workspaces,
          activeWorkspaceId,
        };

        setApiAuthContext({
          token: nextSession.token,
          workspaceId: nextSession.activeWorkspaceId,
        });
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSession));
        setSession(nextSession);
      } catch {
        window.localStorage.removeItem(STORAGE_KEY);
        setApiAuthContext({ token: null, workspaceId: null });
        setSession(null);
      } finally {
        setLoading(false);
      }
    };

    void hydrate();
  }, []);

  const login = async (payload: {
    email: string;
    password: string;
  }) => {
    const nextSession = await apiRequest<SessionData>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setApiAuthContext({
      token: nextSession.token,
      workspaceId: nextSession.activeWorkspaceId,
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSession));
    setSession(nextSession);
  };

  const register = async (payload: {
    name: string;
    email: string;
    password: string;
    workspaceSlug: string;
    workspaceName: string;
    timeZone?: string;
  }) => {
    const nextSession = await apiRequest<SessionData>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setApiAuthContext({
      token: nextSession.token,
      workspaceId: nextSession.activeWorkspaceId,
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSession));
    setSession(nextSession);
  };

  const setActiveWorkspaceId = (workspaceId: string) => {
    setSession((current) => {
      if (!current) {
        return current;
      }

      const exists = current.workspaces.some((workspace) => workspace._id === workspaceId);
      if (!exists) {
        return current;
      }

      const nextSession = {
        ...current,
        activeWorkspaceId: workspaceId,
      };
      setApiAuthContext({
        token: nextSession.token,
        workspaceId,
      });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSession));
      return nextSession;
    });
  };

  const activeWorkspace = useMemo(() => {
    if (!session) {
      return null;
    }
    return (
      session.workspaces.find(
        (workspace) => workspace._id === session.activeWorkspaceId
      ) ?? null
    );
  }, [session]);

  const isAdmin =
    activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin";

  const deployment = useMemo(() => readDeploymentConfig(), []);

  const logout = async () => {
    if (session?.token) {
      try {
        await apiRequest<{ loggedOut: boolean }>("/api/auth/logout", {
          method: "POST",
        });
      } catch {
        // Ignore logout API errors and clear local session regardless.
      }
    }
    window.localStorage.removeItem(STORAGE_KEY);
    setApiAuthContext({ token: null, workspaceId: null });
    setSession(null);
  };

  return (
    <SessionContext.Provider
      value={{
        session,
        activeWorkspace,
        isAdmin,
        loading,
        deployment,
        login,
        register,
        setActiveWorkspaceId,
        logout,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return value;
}
