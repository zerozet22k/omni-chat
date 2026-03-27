export const PUBLIC_PLATFORM_ROLES = [
  "founder",
  "platform_admin",
  "support",
  "ops",
  "billing",
  "staff",
] as const;

export const MANAGEABLE_PLATFORM_ROLES = [
  "support",
  "ops",
  "billing",
  "staff",
] as const;

export const STORED_PORTAL_ACCESS_ROLES = [
  "founder",
  "platform_admin",
  "support",
  "ops",
  "billing",
  "staff",
] as const;
export type PublicPlatformRole = (typeof PUBLIC_PLATFORM_ROLES)[number];

export const serializePlatformRole = (
  role?: string | null
): PublicPlatformRole | null => {
  if (role === "founder") {
    return "founder";
  }

  if (role === "platform_admin") {
    return "platform_admin";
  }

  if (role === "support" || role === "ops" || role === "billing" || role === "staff") {
    return role;
  }

  return null;
};

export const hasPortalAccess = (role?: string | null) =>
  serializePlatformRole(role) !== null;

export const isPlatformAdmin = (role?: string | null) => {
  const normalizedRole = serializePlatformRole(role);
  return normalizedRole === "founder" || normalizedRole === "platform_admin";
};

export const formatPlatformRoleLabel = (role?: string | null) => {
  const normalizedRole = serializePlatformRole(role);
  if (!normalizedRole) {
    return "No portal access";
  }

  if (normalizedRole === "platform_admin") {
    return "Platform Admin";
  }

  return normalizedRole
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};
