import {
  Job,
  Queue,
  QueueEvents,
  Worker,
  type JobsOptions,
  type Processor,
} from "bullmq";
import { env } from "../config/env";
import { normalizeBullMqJobOptions } from "./bullmq-job-id";
import {
  buildBullMQConnectionOptions,
  isBullMqCompatibleRedisRuntime,
  isRedisConfigured,
} from "./redis";
import { logger } from "./logger";

export type InboundWebhookJobPayload = {
  channel:
    | "facebook"
    | "instagram"
    | "telegram"
    | "viber"
    | "tiktok"
    | "line"
    | "website";
  body: unknown;
  rawBody?: string;
  headers: Record<string, unknown>;
  query: Record<string, string | string[] | undefined>;
  receivedAt: string;
};

export type OutboundSendJobPayload = {
  messageId: string;
  conversationId: string;
  source?: string;
};

export type OutboundSendJobResult = {
  messageId: string;
  deliveryId: string | null;
  status: "sent" | "queued" | "failed";
};

export type BillingEventJobPayload = {
  provider: string;
  eventId: string;
  payload: Record<string, unknown>;
};

export type NotificationJobPayload = {
  kind: string;
  payload: Record<string, unknown>;
};

type QueueDefinition<TPayload, TResult = unknown> = {
  name: string;
  defaultJobOptions: JobsOptions;
  processorName: string;
  queue: Queue<TPayload, TResult> | null;
  queueEvents: QueueEvents | null;
};

const queuePrefix = env.BULLMQ_PREFIX.trim() || "omni-chat";
const sharedConnection = buildBullMQConnectionOptions();
const workerSet = new Set<Worker>();
const queueDefinitions = {
  inboundWebhooks: {
    name: "inbound-webhooks",
    processorName: "process-inbound-webhook",
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
      removeOnComplete: 250,
      removeOnFail: 500,
    },
    queue: null,
    queueEvents: null,
  } satisfies QueueDefinition<InboundWebhookJobPayload>,
  outboundSends: {
    name: "outbound-sends",
    processorName: "process-outbound-send",
    defaultJobOptions: {
      attempts: 4,
      backoff: {
        type: "exponential",
        delay: 1500,
      },
      removeOnComplete: 250,
      removeOnFail: 500,
    },
    queue: null,
    queueEvents: null,
  } satisfies QueueDefinition<OutboundSendJobPayload, OutboundSendJobResult>,
  billingEvents: {
    name: "billing-events",
    processorName: "process-billing-event",
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
      removeOnComplete: 250,
      removeOnFail: 500,
    },
    queue: null,
    queueEvents: null,
  } satisfies QueueDefinition<BillingEventJobPayload>,
  notifications: {
    name: "notifications",
    processorName: "process-notification",
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
      removeOnComplete: 250,
      removeOnFail: 500,
    },
    queue: null,
    queueEvents: null,
  } satisfies QueueDefinition<NotificationJobPayload>,
};

const isQueueingAvailable = () =>
  isRedisConfigured() && !!sharedConnection && isBullMqCompatibleRedisRuntime();

const bindWorkerEvents = (worker: Worker, queueName: string) => {
  worker.on("completed", (job) => {
    logger.debug("BullMQ job completed", {
      queueName,
      jobId: job.id,
      name: job.name,
    });
  });

  worker.on("failed", (job, error) => {
    logger.error("BullMQ job failed", {
      queueName,
      jobId: job?.id ?? null,
      name: job?.name ?? null,
      error: error instanceof Error ? error.message : error,
    });
  });
};

const getQueue = <TPayload, TResult = unknown>(
  definition: QueueDefinition<TPayload, TResult>
) => {
  if (!isQueueingAvailable()) {
    return null;
  }

  if (!definition.queue) {
    definition.queue = new Queue<TPayload, TResult>(definition.name, {
      connection: sharedConnection!,
      prefix: queuePrefix,
      defaultJobOptions: definition.defaultJobOptions,
    });
  }

  return definition.queue;
};

const getQueueEvents = <TPayload, TResult = unknown>(
  definition: QueueDefinition<TPayload, TResult>
) => {
  if (!isQueueingAvailable()) {
    return null;
  }

  if (!definition.queueEvents) {
    definition.queueEvents = new QueueEvents(definition.name, {
      connection: sharedConnection!,
      prefix: queuePrefix,
    });
  }

  return definition.queueEvents;
};

export const getInboundWebhookQueue = () => getQueue(queueDefinitions.inboundWebhooks);
export const getOutboundSendQueue = () => getQueue(queueDefinitions.outboundSends);
export const getBillingEventQueue = () => getQueue(queueDefinitions.billingEvents);
export const getNotificationQueue = () => getQueue(queueDefinitions.notifications);

export const addInboundWebhookJob = async (
  payload: InboundWebhookJobPayload,
  options?: JobsOptions
): Promise<Job<InboundWebhookJobPayload> | null> => {
  const queue = getInboundWebhookQueue();
  if (!queue) {
    return null;
  }

  return queue.add(
    queueDefinitions.inboundWebhooks.processorName,
    payload,
    normalizeBullMqJobOptions(options)
  ) as Promise<Job<InboundWebhookJobPayload> | null>;
};

export const addOutboundSendJob = async (
  payload: OutboundSendJobPayload,
  options?: JobsOptions
): Promise<Job<OutboundSendJobPayload, OutboundSendJobResult> | null> => {
  const queue = getOutboundSendQueue();
  if (!queue) {
    return null;
  }

  return queue.add(
    queueDefinitions.outboundSends.processorName,
    payload,
    normalizeBullMqJobOptions(options)
  ) as Promise<Job<OutboundSendJobPayload, OutboundSendJobResult> | null>;
};

export const addBillingEventJob = async (
  payload: BillingEventJobPayload,
  options?: JobsOptions
): Promise<Job<BillingEventJobPayload> | null> => {
  const queue = getBillingEventQueue();
  if (!queue) {
    return null;
  }

  return queue.add(
    queueDefinitions.billingEvents.processorName,
    payload,
    normalizeBullMqJobOptions(options)
  ) as Promise<Job<BillingEventJobPayload> | null>;
};

export const addNotificationJob = async (
  payload: NotificationJobPayload,
  options?: JobsOptions
): Promise<Job<NotificationJobPayload> | null> => {
  const queue = getNotificationQueue();
  if (!queue) {
    return null;
  }

  return queue.add(
    queueDefinitions.notifications.processorName,
    payload,
    normalizeBullMqJobOptions(options)
  ) as Promise<Job<NotificationJobPayload> | null>;
};

export const waitForOutboundSendJob = async (
  job: Job<OutboundSendJobPayload, OutboundSendJobResult>,
  timeoutMs = 30000
) => {
  const queueEvents = getQueueEvents(queueDefinitions.outboundSends);
  if (!queueEvents) {
    return null;
  }

  return job.waitUntilFinished(queueEvents, timeoutMs);
};

const createWorker = <TPayload, TResult = unknown>(
  definition: QueueDefinition<TPayload, TResult>,
  processor: Processor<TPayload, TResult>,
  concurrency = 4
) => {
  if (!isQueueingAvailable()) {
    return null;
  }

  const worker = new Worker<TPayload, TResult>(definition.name, processor, {
    connection: sharedConnection!,
    prefix: queuePrefix,
    concurrency,
  });
  bindWorkerEvents(worker, definition.name);
  workerSet.add(worker);
  return worker;
};

export const createInboundWebhookWorker = (
  processor: Processor<InboundWebhookJobPayload>
) => createWorker(queueDefinitions.inboundWebhooks, processor, 8);

export const createOutboundSendWorker = (
  processor: Processor<OutboundSendJobPayload, OutboundSendJobResult>
) => createWorker(queueDefinitions.outboundSends, processor, 4);

export const createBillingEventWorker = (
  processor: Processor<BillingEventJobPayload>
) => createWorker(queueDefinitions.billingEvents, processor, 2);

export const createNotificationWorker = (
  processor: Processor<NotificationJobPayload>
) => createWorker(queueDefinitions.notifications, processor, 2);

export const closeQueues = async () => {
  await Promise.all(
    Array.from(workerSet.values()).map((worker) => worker.close())
  );
  workerSet.clear();

  const definitions = Object.values(queueDefinitions) as Array<QueueDefinition<unknown, unknown>>;
  const queueClosers = definitions.flatMap((definition) => {
    const closers: Array<Promise<void>> = [];
    const queueEvents = definition.queueEvents;
    if (queueEvents) {
      closers.push(queueEvents.close());
      definition.queueEvents = null;
    }
    const queue = definition.queue;
    if (queue) {
      closers.push(queue.close());
      definition.queue = null;
    }
    return closers;
  });

  await Promise.all(queueClosers);
};
