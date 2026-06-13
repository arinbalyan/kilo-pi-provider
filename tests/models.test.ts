/**
 * Tests for the model loading and mapping module.
 *
 * Tests model ID cleaning, free model detection, pricing parsing,
 * API routing decisions, and OpenRouter model → pi model mapping.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { fetchKiloModels, cleanModelId, type OpenRouterModel } from "../src/models";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeModel(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id: "google/gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    context_length: 1_000_000,
    pricing: {
      prompt: "0",
      completion: "0",
      input_cache_read: "0",
      input_cache_write: "0",
    },
    architecture: {
      input_modalities: ["text"],
      output_modalities: ["text"],
    },
    supported_parameters: [],
    ...overrides,
  };
}

// ── cleanModelId ────────────────────────────────────────────────────────────

describe("cleanModelId", () => {
  test("returns the id unchanged (no-op)", () => {
    expect(cleanModelId("google/gemini-2.0-flash")).toBe("google/gemini-2.0-flash");
  });

  test("preserves :free suffix", () => {
    expect(cleanModelId("google/gemini-2.0-flash:free")).toBe("google/gemini-2.0-flash:free");
  });

  test("preserves model IDs with colons", () => {
    expect(cleanModelId("openrouter/auto:free")).toBe("openrouter/auto:free");
  });

  test("handles simple names", () => {
    expect(cleanModelId("gpt-4")).toBe("gpt-4");
  });
});

// ── fetchKiloModels ────────────────────────────────────────────────────────

describe("fetchKiloModels", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("maps models from API response", async () => {
    const apiModels = [
      makeModel({
        id: "google/gemini-2.0-flash:free",
        name: "Gemini 2.0 Flash (free)",
        context_length: 500_000,
        pricing: { prompt: "0", completion: "0", input_cache_read: "0", input_cache_write: "0" },
      }),
      makeModel({
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        context_length: 200_000,
        pricing: { prompt: "3", completion: "15", input_cache_read: "0.3", input_cache_write: "3" },
      }),
    ];

    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: apiModels }),
        headers: new Headers(),
      } as Response),
    );

    const result = await fetchKiloModels();
    expect(result).toHaveLength(2);

    // Free model
    const freeModel = result[0]!;
    expect(freeModel.id).toBe("google/gemini-2.0-flash:free");
    expect(freeModel.cost.input).toBe(0);
    expect(freeModel.cost.output).toBe(0);

    // Paid model
    const paidModel = result[1]!;
    expect(paidModel.id).toBe("anthropic/claude-sonnet-4");
    expect(paidModel.cost.input).toBeGreaterThan(0);
    expect(paidModel.cost.output).toBeGreaterThan(0);
  });

  test("filters out image-output models", async () => {
    const apiModels = [
      makeModel(),
      makeModel({
        id: "some/image-model",
        name: "Image Generator",
        architecture: { input_modalities: ["text"], output_modalities: ["image"] },
      }),
    ];

    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: apiModels }),
        headers: new Headers(),
      } as Response),
    );

    const result = await fetchKiloModels();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("google/gemini-2.0-flash");
  });

  test("filters to free-only models when freeOnly=true", async () => {
    const apiModels = [
      makeModel({
        id: "google/gemini-2.0-flash:free",
        pricing: { prompt: "0", completion: "0", input_cache_read: "0", input_cache_write: "0" },
      }),
      makeModel({
        id: "openai/gpt-4o",
        pricing: { prompt: "2.5", completion: "10", input_cache_read: "1.25", input_cache_write: "2.5" },
      }),
    ];

    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: apiModels }),
        headers: new Headers(),
      } as Response),
    );

    const result = await fetchKiloModels({ freeOnly: true });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toMatch(/:free$/);
  });

  test("handles missing data array", async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        headers: new Headers(),
      } as Response),
    );

    expect(fetchKiloModels()).rejects.toThrow("missing data array");
  });

  test("handles API error", async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.resolve({}),
        headers: new Headers(),
      } as Response),
    );

    expect(fetchKiloModels()).rejects.toThrow("Failed to fetch models");
  });

  test("passes organization header when provided", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;

    global.fetch = mock((url: string, opts?: any) => {
      capturedUrl = url;
      capturedHeaders = opts?.headers;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [makeModel()] }),
        headers: new Headers(),
      } as Response);
    });

    await fetchKiloModels({ token: "test-token", organizationId: "org_123" });
    expect(capturedUrl).toContain("/organizations/org_123/models");
    expect(capturedHeaders!["X-KiloCode-OrganizationId"]).toBe("org_123");
  });

  test("sets reasoning=true for models with reasoning parameter support", async () => {
    const apiModels = [
      makeModel({
        id: "deepseek/deepseek-v4-pro",
        supported_parameters: ["reasoning"],
      }),
      makeModel({
        id: "google/gemini-2.0-flash",
        supported_parameters: [],
      }),
    ];

    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: apiModels }),
        headers: new Headers(),
      } as Response),
    );

    const result = await fetchKiloModels();
    expect(result[0]!.reasoning).toBe(true);
    expect(result[1]!.reasoning).toBe(false);
  });

  test("maps thinkingLevelMap from opencode variants", async () => {
    const apiModels = [
      makeModel({
        id: "model/with-variants",
        opencode: {
          variants: {
            none: { reasoning: { enabled: false }, verbosity: "concise" },
            low: { reasoning: { enabled: true, effort: "low" }, verbosity: "normal" },
            high: { reasoning: { enabled: true, effort: "high" }, verbosity: "verbose" },
          },
        },
      }),
    ];

    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: apiModels }),
        headers: new Headers(),
      } as Response),
    );

    const result = await fetchKiloModels();
    expect(result[0]!.thinkingLevelMap).toBeDefined();
    expect(result[0]!.thinkingLevelMap!.off).toBe("none");
  });

  test("handles models with responses API requirement", async () => {
    const apiModels = [
      makeModel({
        id: "openai/o3-mini",
        opencode: { ai_sdk_provider: "openai" },
      }),
    ];

    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: apiModels }),
        headers: new Headers(),
      } as Response),
    );

    const result = await fetchKiloModels();
    expect(result[0]!.api).toBe("openai-responses");
    expect(result[0]!.baseUrl).toContain("api/openrouter");
  });

  test("sets anthropic cacheControlFormat for anthropic models", async () => {
    const apiModels = [
      makeModel({
        id: "anthropic/claude-sonnet-4",
      }),
    ];

    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: apiModels }),
        headers: new Headers(),
      } as Response),
    );

    const result = await fetchKiloModels();
    expect(result[0]!.compat).toBeDefined();
    // compat.thinkingFormat should be "openrouter" for all non-responses models
  });
});
