import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/app-shell";
import { useSession } from "./hooks/use-session";
import { AISettingsPage } from "./pages/AISettingsPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { AutomationsPage } from "./pages/AutomationsPage";
import { CannedRepliesPage } from "./pages/CannedRepliesPage";
import { ChannelsPage } from "./pages/ChannelsPage";
import { InboxPage } from "./pages/InboxPage";
import { KnowledgePage } from "./pages/KnowledgePage";
import { LoginPage } from "./pages/LoginPage";
import { WorkspaceMembersPage } from "./pages/WorkspaceMembersPage";

function ProtectedLayout() {
  const { session, activeWorkspace, loading } = useSession();

  if (loading) {
    return <div className="page-loader">Loading workspace...</div>;
  }

  if (!session || !activeWorkspace) {
    return <Navigate to="/" replace />;
  }

  return <AppShell />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LoginPage />} />
      <Route element={<ProtectedLayout />}>
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/channels" element={<ChannelsPage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/canned-replies" element={<CannedRepliesPage />} />
        <Route path="/automations" element={<AutomationsPage />} />
        <Route path="/ai-settings" element={<AISettingsPage />} />
        <Route path="/workspace-members" element={<WorkspaceMembersPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
