export const PUBLIC_WORKSPACE_ROLES = [
  "owner",
  "admin",
  "manager",
  "agent",
  "viewer",
] as const;

export const ASSIGNABLE_WORKSPACE_ROLES = [
  "admin",
  "manager",
  "agent",
  "viewer",
] as const;

export type PublicWorkspaceRole = (typeof PUBLIC_WORKSPACE_ROLES)[number];

export const serializeWorkspaceRole = (
  role?: string | null
): PublicWorkspaceRole => {
  if (role === "owner" || role === "admin" || role === "manager" || role === "agent" || role === "viewer") {
    return role;
  }

  return "agent";
};

export const isWorkspaceAdminRole = (role?: string | null) => {
  const normalizedRole = serializeWorkspaceRole(role);
  return normalizedRole === "owner" || normalizedRole === "admin";
};

export const hasWorkspaceRoleAccess = (
  role: string | null | undefined,
  allowedRoles: readonly PublicWorkspaceRole[]
) => {
  const normalizedRole = serializeWorkspaceRole(role);

  if (allowedRoles.includes(normalizedRole)) {
    return true;
  }

  if (normalizedRole === "owner" && allowedRoles.includes("admin")) {
    return true;
  }

  return false;
};

export const formatWorkspaceRoleLabel = (role?: string | null) => {
  const normalizedRole = serializeWorkspaceRole(role);
  return normalizedRole.charAt(0).toUpperCase() + normalizedRole.slice(1);
};
