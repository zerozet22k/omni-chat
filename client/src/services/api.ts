import { API_BASE_URL } from "./api-base";

type Query = Record<string, string | number | boolean | undefined | null>;

type ApiAuthContext = {
  token: string | null;
  workspaceId: string | null;
};

let apiAuthContext: ApiAuthContext = {
  token: null,
  workspaceId: null,
};

export const setApiAuthContext = (value: ApiAuthContext) => {
  apiAuthContext = value;
};

const buildUrl = (path: string, query?: Query) => {
  const url = new URL(path, API_BASE_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
};

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  query?: Query
): Promise<T> {
  const authHeaders: Record<string, string> = {};
  if (apiAuthContext.token) {
    authHeaders.Authorization = `Bearer ${apiAuthContext.token}`;
  }
  if (apiAuthContext.workspaceId) {
    authHeaders["X-Workspace-Id"] = apiAuthContext.workspaceId;
  }

  const explicitHeaders = (options.headers ?? {}) as Record<string, string>;
  const isFormDataBody =
    typeof FormData !== "undefined" && options.body instanceof FormData;
  const contentTypeHeader: Record<string, string> = isFormDataBody
    ? {}
    : { "Content-Type": "application/json" };
  const mergedHeaders: Record<string, string> = {
    ...contentTypeHeader,
    ...authHeaders,
    ...explicitHeaders,
  };

  const response = await fetch(buildUrl(path, query), {
    ...options,
    headers: mergedHeaders,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error?.message ?? "Request failed");
  }

  return response.json() as Promise<T>;
}
