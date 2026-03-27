import { type JobsOptions } from "bullmq";

export const normalizeBullMqJobId = (jobId: string) => encodeURIComponent(jobId);

export const normalizeBullMqJobOptions = (options?: JobsOptions) => {
  if (!options || typeof options.jobId !== "string") {
    return options;
  }

  const normalizedJobId = normalizeBullMqJobId(options.jobId);
  if (normalizedJobId === options.jobId) {
    return options;
  }

  return {
    ...options,
    jobId: normalizedJobId,
  };
};
