import mongoose from "mongoose";
import { env } from "../config/env";
import { logger } from "./logger";

let isConnected = false;

export const connectMongo = async () => {
  if (isConnected) {
    return mongoose.connection;
  }

  const uri = `${env.MONGO_URL}/${env.MONGO_DB}`;
  await mongoose.connect(uri);
  isConnected = true;
  logger.info("MongoDB connected", { uri });
  return mongoose.connection;
};

export const disconnectMongo = async () => {
  if (!isConnected) {
    return;
  }

  await mongoose.disconnect();
  isConnected = false;
};
