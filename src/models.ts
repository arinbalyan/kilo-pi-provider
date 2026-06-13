/**
 * Model loading from the Kilo/OpenRouter API and mapping to pi's format.
 */

import type { Api } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  KILO_API_BASE,
  KILO_GATEWAY_BASE,
  KILO_OPENROUTER_BASE,
  MODELS_FETCH_TIMEOUT_MS,
  withOrganizationHeader,
} from "./constants";

// ── Types ─────────────────────────────────────────────────────────────────

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  max_completion_tokens?: number | null;
  pricing?: {
    prompt?: string | null;
    completion?: string | null;
    input_cache_write?: string | null;
    input_cache_read?: string | null;
  };
  architecture?: {
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
  };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
  opencode?: {
    family?: string;
    prompt?: string;
    variants?: Record<
      string,
      {
        reasoning?: { enabled?: boolean; effort?: string };
        verbosity?: string;
      }
    >;
    ai_sdk_provider?: string;
  };
}

type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type KiloModelCompat = {
  thinkingFormat?: "openrouter";
  cacheControlFormat?: "anthropic";
  requiresReasoningContentOnAssistantMessages?: boolean;
  supportsStore?: boolean;
  sendSessionIdHeader?: boolean;
  supportsLongCacheRetention?: boolean;
};

// ── Helpers ───────────────────────────────────────────────────────────────

function parsePrice(price: string | null | undefined): number {
  if (!price) return 0;
  const parsed = parseFloat(price);
  if (isNaN(parsed)) return 0;
  return parsed * 1_000_000;
}

export function cleanModelId(id: string): string {
  // Keep the full model ID as-is. Pi's parseModelPattern tries the full match
  // first (step 1 of its algorithm), so model IDs like "model:free" are matched
  // exactly and not misinterpreted as having a thinking-level suffix.
  return id;
}

function isFreeModel(m: OpenRouterModel): boolean {
  const prompt = parseFloat(m.pricing?.prompt ?? "1");
  const completion = parseFloat(m.pricing?.completion ?? "1");
  if (prompt !== 0 || completion !== 0) return false;
  if (m.id === "kilo-auto/free") return true;
  if (m.id.includes(":free")) return true;
  if (!m.id.includes("/")) return true;
  if (m.id.startsWith("kilo/") || m.id.startsWith("openrouter/")) return true;
  return false;
}

function shouldUseResponsesApi(m: OpenRouterModel): boolean {
  const aiSdkProvider = m.opencode?.ai_sdk_provider;
  if (aiSdkProvider === "openai") return true;

  const id = m.id.toLowerCase();
  const shortId = id.includes("/") ? id.split("/").pop() ?? id : id;
  return (
    shortId === "gpt-5" ||
    shortId.startsWith("gpt-5.") ||
    shortId.startsWith("gpt-5-") ||
    shortId.startsWith("o1") ||
    shortId.startsWith("o3") ||
    shortId.startsWith("o4")
  );
}

function getKiloModelCompat(
  m: OpenRouterModel,
  api: Api | undefined,
): ProviderModelConfig["compat"] {
  if (api === "openai-responses") {
    return {
      sendSessionIdHeader: false,
      supportsLongCacheRetention: false,
    } as ProviderModelConfig["compat"];
  }

  const compat: KiloModelCompat = {
    thinkingFormat: "openrouter",
    supportsStore: false,
  };

  if (m.id.startsWith("anthropic/")) {
    compat.cacheControlFormat = "anthropic";
  }

  if (
    m.id === "deepseek/deepseek-v4-flash" ||
    m.id === "deepseek/deepseek-v4-pro"
  ) {
    compat.requiresReasoningContentOnAssistantMessages = true;
  }

  return compat as ProviderModelConfig["compat"];
}

function mapVariantEffort(
  variants: NonNullable<OpenRouterModel["opencode"]>["variants"],
  key: string,
): string | undefined {
  const variant = variants?.[key];
  if (!variant) return undefined;
  const reasoning = variant.reasoning;
  if (!reasoning) return key;
  if (reasoning.enabled === false || reasoning.effort === "none") return "none";
  return reasoning.effort ?? key;
}

function thinkingLevelMapFromVariants(
  variants: NonNullable<OpenRouterModel["opencode"]>["variants"],
): ProviderModelConfig["thinkingLevelMap"] | undefined {
  if (!variants || Object.keys(variants).length === 0) return undefined;

  const map: Partial<Record<PiThinkingLevel, string | null>> = {};
  const off =
    mapVariantEffort(variants, "none") ??
    mapVariantEffort(variants, "instant");
  if (off !== undefined) map.off = off;

  for (const level of ["minimal", "low", "medium", "high", "xhigh"] as const) {
    const effort = mapVariantEffort(variants, level);
    map[level] = effort === undefined ? null : effort;
  }

  if (map.xhigh === null) {
    const max = mapVariantEffort(variants, "max");
    if (max !== undefined) map.xhigh = max;
  }

  return map as ProviderModelConfig["thinkingLevelMap"];
}

function getKiloThinkingLevelMap(
  m: OpenRouterModel,
): ProviderModelConfig["thinkingLevelMap"] | undefined {
  const fromVariants = thinkingLevelMapFromVariants(m.opencode?.variants);
  if (fromVariants) return fromVariants;

  if (m.id === "deepseek/deepseek-v4-pro") {
    return {
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "max",
    };
  }

  if (m.id.includes("gpt-5.5")) {
    return {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    };
  }

  return undefined;
}

function mapOpenRouterModel(m: OpenRouterModel): ProviderModelConfig {
  const inputModalities = m.architecture?.input_modalities ?? ["text"];
  const supportsImages = inputModalities.includes("image");
  const supportsReasoning =
    m.supported_parameters?.includes("reasoning") ?? false;
  const maxTokens =
    m.top_provider?.max_completion_tokens ??
    m.max_completion_tokens ??
    Math.ceil(m.context_length * 0.2);
  const api = shouldUseResponsesApi(m)
    ? ("openai-responses" as const)
    : undefined;

  return {
    id: cleanModelId(m.id),
    name: m.name,
    ...(api ? { api, baseUrl: KILO_OPENROUTER_BASE } : {}),
    reasoning: supportsReasoning,
    input: supportsImages ? ["text", "image"] : ["text"],
    cost: {
      input: parsePrice(m.pricing?.prompt),
      output: parsePrice(m.pricing?.completion),
      cacheRead: parsePrice(m.pricing?.input_cache_read),
      cacheWrite: parsePrice(m.pricing?.input_cache_write),
    },
    contextWindow: m.context_length,
    maxTokens: maxTokens,
    thinkingLevelMap: getKiloThinkingLevelMap(m),
    compat: getKiloModelCompat(m, api),
  };
}

// ── Fetch Models ──────────────────────────────────────────────────────────

export async function fetchKiloModels(options?: {
  token?: string;
  organizationId?: string;
  freeOnly?: boolean;
}): Promise<ProviderModelConfig[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "pi-kilo-provider",
  };
  if (options?.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  const organizationId = options?.organizationId;
  const requestHeaders = withOrganizationHeader(headers, organizationId);
  const modelsUrl = organizationId
    ? `${KILO_API_BASE}/api/organizations/${encodeURIComponent(organizationId)}/models`
    : `${KILO_GATEWAY_BASE}/models`;

  const response = await fetch(modelsUrl, {
    headers: requestHeaders,
    signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch models: ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as { data?: OpenRouterModel[] };
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error("Invalid models response: missing data array");
  }

  return json.data
    .filter((m) => {
      const outputMods = m.architecture?.output_modalities ?? [];
      if (outputMods.includes("image")) return false;
      if (options?.freeOnly && !isFreeModel(m)) return false;
      return true;
    })
    .map(mapOpenRouterModel);
}
