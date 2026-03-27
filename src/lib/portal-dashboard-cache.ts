import { deleteCachedKeys, getCachedJson, setCachedJson } from "./redis-cache";

const PORTAL_DASHBOARD_CACHE_KEY = "cache:portal:dashboard:summary";
const PORTAL_DASHBOARD_CACHE_TTL_SECONDS = 15;

export const getPortalDashboardCache = async <T>() =>
  getCachedJson<T>(PORTAL_DASHBOARD_CACHE_KEY);

export const setPortalDashboardCache = async (value: unknown) =>
  setCachedJson(
    PORTAL_DASHBOARD_CACHE_KEY,
    value,
    PORTAL_DASHBOARD_CACHE_TTL_SECONDS
  );

export const invalidatePortalDashboardCache = async () =>
  deleteCachedKeys(PORTAL_DASHBOARD_CACHE_KEY);
