const DEFAULT_API_URL = "http://localhost:4000";

const normalizeApiUrl = (value: string | undefined) => {
  const candidate = value?.trim();
  if (!candidate) {
    return DEFAULT_API_URL;
  }

  try {
    return new URL(candidate).toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_API_URL;
  }
};

export const API_BASE_URL = normalizeApiUrl(import.meta.env.VITE_API_URL);