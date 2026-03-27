import mongoose from "mongoose";
import { env } from "../config/env";
import { logger } from "./logger";

let isConnected = false;

const buildMongoUri = (baseUri: string, dbName: string) => {
  const trimmedBaseUri = baseUri.trim();
  const trimmedDbName = dbName.trim().replace(/^\/+/, "");

  if (!trimmedDbName) {
    return trimmedBaseUri;
  }

  const queryIndex = trimmedBaseUri.indexOf("?");
  const uriWithoutQuery =
    queryIndex >= 0 ? trimmedBaseUri.slice(0, queryIndex) : trimmedBaseUri;
  const query = queryIndex >= 0 ? trimmedBaseUri.slice(queryIndex) : "";

  const normalizedBaseUri = uriWithoutQuery.replace(/\/+$/, "");
  const schemeIndex = normalizedBaseUri.indexOf("://");
  const pathIndex =
    schemeIndex >= 0
      ? normalizedBaseUri.indexOf("/", schemeIndex + 3)
      : normalizedBaseUri.indexOf("/");

  if (pathIndex >= 0 && normalizedBaseUri.slice(pathIndex + 1).length > 0) {
    return trimmedBaseUri;
  }

  return `${normalizedBaseUri}/${encodeURIComponent(trimmedDbName)}${query}`;
};

const redactMongoUriForLog = (uri: string) =>
  uri.replace(/(mongodb(?:\+srv)?:\/\/)([^@/]+)@/i, "$1***:***@");

export const connectMongo = async () => {
  if (isConnected) {
    return mongoose.connection;
  }

  const uri = buildMongoUri(env.MONGO_URL, env.MONGO_DB);
  await mongoose.connect(uri);
  isConnected = true;
  logger.info("MongoDB connected", { uri: redactMongoUriForLog(uri) });
  return mongoose.connection;
};

export const disconnectMongo = async () => {
  if (!isConnected) {
    return;
  }

  await mongoose.disconnect();
  isConnected = false;
};
