type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const activeLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";

const shouldLog = (level: LogLevel) => {
  return levelOrder[level] >= levelOrder[activeLevel];
};

const serializeMeta = (meta: unknown): unknown => {
  if (meta instanceof Error) {
    return {
      name: meta.name,
      message: meta.message,
      stack: meta.stack,
      ...(meta && typeof meta === "object" && "statusCode" in meta
        ? {
            statusCode: (meta as { statusCode?: unknown }).statusCode,
          }
        : {}),
      ...(meta && typeof meta === "object" && "code" in meta
        ? {
            code: (meta as { code?: unknown }).code,
          }
        : {}),
    };
  }

  return meta;
};

const write = (level: LogLevel, message: string, meta?: unknown) => {
  if (!shouldLog(level)) {
    return;
  }

  const serializedMeta = serializeMeta(meta);
  const payload = {
    level,
    message,
    ...(serializedMeta ? { meta: serializedMeta } : {}),
    timestamp: new Date().toISOString(),
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
};

export const logger = {
  debug: (message: string, meta?: unknown) => write("debug", message, meta),
  info: (message: string, meta?: unknown) => write("info", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  error: (message: string, meta?: unknown) => write("error", message, meta),
};
