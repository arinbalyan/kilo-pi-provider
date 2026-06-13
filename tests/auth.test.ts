/**
 * Tests for authentication module.
 *
 * Tests the auth flow logic including device auth polling,
 * token refresh, and the abortable sleep helper.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { loginKilo, refreshKiloToken } from "../src/auth";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { _accounts } from "../src/accounts";

// ── Mocks ───────────────────────────────────────────────────────────────────

function makeJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(),
  } as Response;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("refreshKiloToken", () => {
  test("returns credentials when not expired", async () => {
    const cred = {
      access: "token",
      refresh: "token",
      expires: Date.now() + 999999,
    } as OAuthCredentials;
    const result = await refreshKiloToken(cred);
    expect(result).toBe(cred);
  });

  test("throws when token is expired", async () => {
    const cred = {
      access: "token",
      refresh: "token",
      expires: Date.now() - 1000,
    } as OAuthCredentials;
    expect(refreshKiloToken(cred)).rejects.toThrow(/expired/i);
  });
});

describe("loginKilo", () => {
  let originalFetch: typeof global.fetch;
  const mockCallbacks: OAuthLoginCallbacks = {
    onAuth: mock(() => {}),
    onProgress: mock(() => {}),
    onSelect: mock(() => Promise.resolve("personal")),
    signal: undefined,
  };

  beforeEach(() => {
    originalFetch = global.fetch;
    _accounts.length = 0;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    _accounts.length = 0;
  });

  test("completes full login flow successfully", async () => {
    let pollCount = 0;

    global.fetch = mock((url: string, opts?: any) => {
      const path = new URL(url).pathname;

      // Initiate device auth: POST /api/device-auth/codes
      if (path.endsWith("/device-auth/codes") && opts?.method === "POST") {
        return Promise.resolve(
          makeJsonResponse(200, {
            code: "ABC123",
            verificationUrl: "https://kilo.ai/activate",
            expiresIn: 300,
          }),
        );
      }

      // Poll device auth: GET /api/device-auth/codes/<code>
      if (path.includes("/device-auth/codes/")) {
        pollCount++;
        // Return approved immediately on first poll
        return Promise.resolve(
          makeJsonResponse(200, {
            status: "approved",
            token: "new-auth-token",
            userEmail: "user@example.com",
          }),
        );
      }

      // Profile (not balance)
      if (path.endsWith("/profile") && !path.includes("/balance")) {
        return Promise.resolve(
          makeJsonResponse(200, {
            user: { email: "user@example.com", name: "Test" },
            organizations: [],
          }),
        );
      }

      // Balance
      if (path.includes("/balance")) {
        return Promise.resolve(makeJsonResponse(200, { balance: 100 }));
      }

      return Promise.resolve(makeJsonResponse(404, { error: "not found" }));
    });

    const result = await loginKilo(mockCallbacks);

    expect(result.access).toBe("new-auth-token");
    expect(result.refresh).toBe("new-auth-token");
    expect(typeof result.expires).toBe("number");
    expect(result.expires).toBeGreaterThan(Date.now());
  });

  test("throws on denied auth", async () => {
    global.fetch = mock((url: string, opts?: any) => {
      const path = new URL(url).pathname;

      if (path.endsWith("/device-auth/codes") && opts?.method === "POST") {
        return Promise.resolve(
          makeJsonResponse(200, {
            code: "XYZ",
            verificationUrl: "https://kilo.ai/activate",
            expiresIn: 300,
          }),
        );
      }

      if (path.includes("/device-auth/codes/")) {
        return Promise.resolve(makeJsonResponse(403, { status: "denied" }));
      }

      return Promise.resolve(makeJsonResponse(404, {}));
    });

    await expect(loginKilo(mockCallbacks)).rejects.toThrow(/denied/i);
  });

  test("throws on expired auth", async () => {
    global.fetch = mock((url: string, opts?: any) => {
      const path = new URL(url).pathname;

      if (path.endsWith("/device-auth/codes") && opts?.method === "POST") {
        return Promise.resolve(
          makeJsonResponse(200, {
            code: "XYZ",
            verificationUrl: "https://kilo.ai/activate",
            expiresIn: 300,
          }),
        );
      }

      if (path.includes("/device-auth/codes/")) {
        return Promise.resolve(makeJsonResponse(410, { status: "expired" }));
      }

      return Promise.resolve(makeJsonResponse(404, {}));
    });

    await expect(loginKilo(mockCallbacks)).rejects.toThrow(/expired/i);
  });

  test("throws on rate-limited initiation", async () => {
    global.fetch = mock((url: string, opts?: any) => {
      const path = new URL(url).pathname;

      if (path.endsWith("/device-auth/codes") && opts?.method === "POST") {
        return Promise.resolve(makeJsonResponse(429, {}));
      }

      return Promise.resolve(makeJsonResponse(404, {}));
    });

    await expect(loginKilo(mockCallbacks)).rejects.toThrow(/Too many pending/i);
  });
});
