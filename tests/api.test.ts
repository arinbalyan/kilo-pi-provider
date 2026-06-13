/**
 * Tests for API wrappers.
 *
 * These tests mock the global fetch function to simulate Kilo API responses.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { fetchKiloProfile, fetchKiloBalance, selectKiloOrganization, formatCredits } from "../src/api";

// ── Helpers ────────────────────────────────────────────────────────────────

function mockFetch(response: Partial<Response>, body?: unknown) {
  const bodyText = body !== undefined ? JSON.stringify(body) : "";
  return mock(() =>
    Promise.resolve({
      ok: response.status ? response.status < 400 : true,
      status: response.status ?? 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(bodyText),
      headers: new Headers(response.headers as Record<string, string> ?? {}),
      ...response,
    } as Response),
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("fetchKiloProfile", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("returns profile on success", async () => {
    const profileData = {
      user: { email: "test@example.com", name: "Test User" },
      organizations: [{ id: "org_1", name: "My Org" }],
    };
    global.fetch = mockFetch({ status: 200 }, profileData);

    const result = await fetchKiloProfile("valid-token");
    expect(result.user?.email).toBe("test@example.com");
    expect(result.user?.name).toBe("Test User");
    expect(result.organizations).toHaveLength(1);
  });

  test("throws on non-ok response", async () => {
    global.fetch = mockFetch({ status: 401 });

    expect(fetchKiloProfile("bad-token")).rejects.toThrow(
      "Failed to fetch Kilo profile: 401",
    );
  });

  test("sends Authorization header", async () => {
    let capturedHeaders: HeadersInit | undefined;
    global.fetch = mock(async (url, opts) => {
      capturedHeaders = opts?.headers;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await fetchKiloProfile("my-secret-token");
    const headers = capturedHeaders as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-secret-token");
  });
});

describe("fetchKiloBalance", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("returns balance on success", async () => {
    global.fetch = mockFetch({ status: 200 }, { balance: 5000 });

    const result = await fetchKiloBalance("valid-token");
    expect(result).toBe(5000);
  });

  test("returns null on non-ok response", async () => {
    global.fetch = mockFetch({ status: 500 });

    const result = await fetchKiloBalance("any-token");
    expect(result).toBeNull();
  });

  test("returns null on network error", async () => {
    global.fetch = mock(() => Promise.reject(new Error("Network error")));

    const result = await fetchKiloBalance("any-token");
    expect(result).toBeNull();
  });

  test("handles null balance in response", async () => {
    global.fetch = mockFetch({ status: 200 }, { balance: null });

    const result = await fetchKiloBalance("any-token");
    expect(result).toBeNull();
  });
});

describe("formatCredits", () => {
  test("formats small balances as dollars", () => {
    expect(formatCredits(500)).toBe("$500.00");
    expect(formatCredits(12.5)).toBe("$12.50");
    expect(formatCredits(0)).toBe("$0.00");
  });

  test("formats large balances as k", () => {
    expect(formatCredits(1000)).toBe("$1.0k");
    expect(formatCredits(25000)).toBe("$25.0k");
    expect(formatCredits(1500000)).toBe("$1500.0k");
  });
});
