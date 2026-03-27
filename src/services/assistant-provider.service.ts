import axios from "axios";
import { env } from "../config/env";

export type AssistantProviderName = "codex";

type AssistantProviderRequest = {
  provider?: AssistantProviderName;
  apiKey: string;
  model?: string;
  prompt: string;
};

type AssistantProviderResponse = {
  provider: AssistantProviderName;
  model: string;
  text: string;
  raw: unknown;
};

class AssistantProviderService {
  async generateStructuredText(
    params: AssistantProviderRequest
  ): Promise<AssistantProviderResponse> {
    const provider = params.provider ?? "codex";

    if (provider !== "codex") {
      throw new Error(`Unsupported assistant provider: ${provider}`);
    }

    const model = params.model?.trim() || env.OPENAI_MODEL.trim() || "gpt-5.3-codex";
    const apiBaseUrl = env.OPENAI_API_BASE_URL.replace(/\/+$/, "");

    const response = await axios.post(
      `${apiBaseUrl}/responses`,
      {
        model,
        input: params.prompt,
      },
      {
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    return {
      provider,
      model,
      text: this.extractText(response.data),
      raw: response.data,
    };
  }

  private extractText(data: unknown) {
    if (
      typeof data === "object" &&
      data !== null &&
      typeof (data as { output_text?: unknown }).output_text === "string"
    ) {
      return String((data as { output_text: string }).output_text).trim();
    }

    const legacyProviderText =
      (data as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
            }>;
          };
        }>;
      }).candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("")
        .trim() ?? "";

    if (legacyProviderText) {
      return legacyProviderText;
    }

    const output = Array.isArray((data as { output?: unknown[] } | null)?.output)
      ? ((data as { output: Array<Record<string, unknown>> }).output ?? [])
      : [];

    const parts: string[] = [];

    for (const item of output) {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const contentPart of content) {
        if (
          typeof contentPart === "object" &&
          contentPart !== null &&
          typeof (contentPart as { text?: unknown }).text === "string"
        ) {
          parts.push(String((contentPart as { text: string }).text));
        }
      }
    }

    return parts.join("").trim();
  }
}

export const assistantProviderService = new AssistantProviderService();
