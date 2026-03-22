import { FormEvent, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useSession } from "../hooks/use-session";

const POST_LOGIN_WORKSPACE_PICK_KEY = "omni-chat-post-login-workspace-pick";

export function LoginPage() {
  const { session, login, register, deployment, setActiveWorkspaceId } = useSession();

  const canRegister = deployment.allowSignup && deployment.tenantMode !== "single";

  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [timeZone, setTimeZone] = useState("Asia/Bangkok");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  const trimmedPassword = password.trim();
  const trimmedWorkspaceSlug = workspaceSlug.trim();
  const trimmedWorkspaceName = workspaceName.trim();

  const workspaceMode = useMemo(() => {
    if (trimmedWorkspaceSlug) return "existing";
    if (trimmedWorkspaceName) return "new";
    return "unset";
  }, [trimmedWorkspaceSlug, trimmedWorkspaceName]);

  const postLoginWorkspacePickPending =
    typeof window !== "undefined" &&
    window.localStorage.getItem(POST_LOGIN_WORKSPACE_PICK_KEY) === "true";

  const showWorkspacePicker =
    !!session &&
    postLoginWorkspacePickPending &&
    (session.workspaces?.length ?? 0) > 1;

  if (session && !showWorkspacePicker) {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(POST_LOGIN_WORKSPACE_PICK_KEY);
    }
    return <Navigate to="/inbox" replace />;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();

    if (!trimmedEmail || !trimmedPassword) {
      setError("Email and password are required.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      if (mode === "login") {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(POST_LOGIN_WORKSPACE_PICK_KEY, "true");
        }

        await login({
          email: trimmedEmail,
          password: trimmedPassword,
        });
      } else {
        if (!canRegister) {
          setError("Registration is not available on this deployment.");
          return;
        }

        if (!trimmedName) {
          setError("Name is required to register.");
          return;
        }

        if (!trimmedWorkspaceSlug || !trimmedWorkspaceName) {
          setError("Workspace slug and workspace name are required for registration.");
          return;
        }

        await register({
          name: trimmedName,
          email: trimmedEmail,
          password: trimmedPassword,
          workspaceSlug: trimmedWorkspaceSlug,
          workspaceName: trimmedWorkspaceName,
          timeZone,
        });
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Login failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm lg:grid-cols-[1.05fr_0.95fr]">
        <section className="relative hidden overflow-hidden bg-slate-950 p-10 text-slate-100 lg:block">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_35%),radial-gradient(circle_at_bottom_left,rgba(255,255,255,0.08),transparent_30%)]" />

          <div className="relative flex h-full flex-col justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                Elqen Zero
              </p>

              <h1 className="mt-6 max-w-md text-4xl font-semibold tracking-tight text-white">
                Run your seller inbox from one dashboard.
              </h1>

              <p className="mt-4 max-w-xl text-sm leading-7 text-slate-300">
                Connect channels, manage conversations, reuse replies, and keep
                policy knowledge in one workspace.
              </p>
            </div>

            <div className="grid gap-4">
              <div className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur-sm">
                <p className="text-sm font-medium text-white">One inbox</p>
                <p className="mt-1 text-sm text-slate-300">
                  View Facebook, Telegram, Viber, and other provider traffic in one place.
                </p>
              </div>

              <div className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur-sm">
                <p className="text-sm font-medium text-white">Operational controls</p>
                <p className="mt-1 text-sm text-slate-300">
                  Manage canned replies, AI rules, automations, and channel health from the same console.
                </p>
              </div>

              <div className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur-sm">
                <p className="text-sm font-medium text-white">
                  {mode === "login" ? "Secure sign in" : "Workspace onboarding"}
                </p>
                <p className="mt-1 text-sm text-slate-300">
                  {mode === "login"
                    ? "Sign in with your existing account, then pick your workspace if you belong to multiple."
                    : "Registration creates your first workspace and signs you in as owner."}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="flex items-center justify-center p-6 sm:p-10">
          <div className="w-full max-w-lg">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Elqen Zero
              </p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
                {mode === "login" ? "Sign in" : "Create account"}
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                {mode === "login"
                  ? "Sign in with your account to continue."
                  : "Register a new account and create your first workspace."}
              </p>
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setMode("login")}
                className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ring-1 ${
                  mode === "login"
                    ? "bg-slate-900 text-white ring-slate-900"
                    : "bg-slate-100 text-slate-700 ring-slate-200"
                }`}
              >
                Login
              </button>
              {canRegister ? (
                <button
                  type="button"
                  onClick={() => setMode("register")}
                  className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ring-1 ${
                    mode === "register"
                      ? "bg-slate-900 text-white ring-slate-900"
                      : "bg-slate-100 text-slate-700 ring-slate-200"
                  }`}
                >
                  Register
                </button>
              ) : null}
              {canRegister && mode === "register" ? (
                <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                  {workspaceMode === "existing"
                    ? "Using provided slug"
                    : workspaceMode === "new"
                    ? "Creating workspace"
                    : "Provide workspace details"}
                </span>
              ) : null}
            </div>

            {error ? (
              <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {error}
              </div>
            ) : null}

            {showWorkspacePicker && session ? (
              <div className="mt-6 space-y-4">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-medium text-slate-900">Choose workspace</p>
                  <p className="mt-1 text-sm text-slate-500">
                    Your account belongs to multiple workspaces. Select one to continue.
                  </p>
                </div>

                <div className="space-y-2">
                  {session.workspaces.map((workspace) => (
                    <button
                      key={workspace._id}
                      type="button"
                      onClick={() => {
                        setActiveWorkspaceId(workspace._id);
                        if (typeof window !== "undefined") {
                          window.localStorage.removeItem(POST_LOGIN_WORKSPACE_PICK_KEY);
                        }
                      }}
                      className="flex w-full items-center justify-between rounded-xl border border-slate-300 bg-white px-4 py-3 text-left text-sm text-slate-900 transition hover:border-slate-900"
                    >
                      <span className="font-medium">{workspace.name}</span>
                      <span className="text-xs uppercase tracking-[0.12em] text-slate-500">{workspace.role}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
            <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
              {mode === "register" ? (
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-slate-900">
                    Name
                  </span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Your name"
                    className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  />
                </label>
              ) : null}

              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-slate-900">
                  Email
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-slate-900">
                  Password
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Your password"
                  className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
              </label>

              {mode === "register" ? (
                <>
                  <div className="grid gap-5 md:grid-cols-2">
                    <label className="block">
                      <span className="mb-1.5 block text-sm font-medium text-slate-900">
                        Workspace slug
                      </span>
                      <input
                        value={workspaceSlug}
                        onChange={(event) => setWorkspaceSlug(event.target.value)}
                        placeholder="my-workspace"
                        className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                      <p className="mt-1.5 text-xs text-slate-500">
                        Required during registration.
                      </p>
                    </label>

                    <label className="block">
                      <span className="mb-1.5 block text-sm font-medium text-slate-900">
                        Workspace name
                      </span>
                      <input
                        value={workspaceName}
                        onChange={(event) => setWorkspaceName(event.target.value)}
                        placeholder="My Workspace"
                        className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                      <p className="mt-1.5 text-xs text-slate-500">
                        Required during registration.
                      </p>
                    </label>
                  </div>

                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium text-slate-900">
                      Time zone
                    </span>
                    <input
                      value={timeZone}
                      onChange={(event) => setTimeZone(event.target.value)}
                      className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                    />
                  </label>
                </>
              ) : null}

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-900">How it works</p>
                <ul className="mt-2 space-y-1.5 text-sm text-slate-500">
                  {mode === "login" ? (
                    <>
                      <li>Use your registered account email and password.</li>
                      <li>Your available workspaces are loaded after login.</li>
                    </>
                  ) : (
                    <>
                      <li>Registration creates your account and first workspace.</li>
                      <li>Your account is added as workspace owner.</li>
                    </>
                  )}
                </ul>
              </div>

              <button
                className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                disabled={submitting}
                type="submit"
              >
                {submitting
                  ? mode === "login"
                    ? "Signing in..."
                    : "Creating account..."
                  : mode === "login"
                  ? "Sign in"
                  : "Create account"}
              </button>
            </form>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}