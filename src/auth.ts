/**
 * Device authorization flow: initiate, poll, login, refresh.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
  KILO_DEVICE_AUTH_ENDPOINT,
  POLL_INTERVAL_MS,
  TOKEN_EXPIRATION_MS,
} from "./constants";
import { fetchKiloProfile, selectKiloOrganization } from "./api";
import { type KiloAccount, addAccount, _accounts } from "./accounts";

// ── Types ─────────────────────────────────────────────────────────────────

interface DeviceAuthResponse {
  code: string;
  verificationUrl: string;
  expiresIn: number;
}

interface DeviceAuthPollResponse {
  status: "pending" | "approved" | "denied" | "expired";
  token?: string;
  userEmail?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Login cancelled"));
      },
      { once: true },
    );
  });
}

// ── Device Auth API ───────────────────────────────────────────────────────

async function initiateDeviceAuth(): Promise<DeviceAuthResponse> {
  const response = await fetch(KILO_DEVICE_AUTH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(
        "Too many pending authorization requests. Please try again later.",
      );
    }
    throw new Error(
      `Failed to initiate device authorization: ${response.status}`,
    );
  }

  return (await response.json()) as DeviceAuthResponse;
}

async function pollDeviceAuth(
  code: string,
): Promise<DeviceAuthPollResponse> {
  const response = await fetch(`${KILO_DEVICE_AUTH_ENDPOINT}/${code}`);

  if (response.status === 202) return { status: "pending" };
  if (response.status === 403) return { status: "denied" };
  if (response.status === 410) return { status: "expired" };

  if (!response.ok) {
    throw new Error(
      `Failed to poll device authorization: ${response.status}`,
    );
  }

  return (await response.json()) as DeviceAuthPollResponse;
}

// ── Login Flow ────────────────────────────────────────────────────────────

export async function loginKilo(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  callbacks.onProgress?.("Initiating device authorization...");
  const authData = await initiateDeviceAuth();
  const { code, verificationUrl, expiresIn } = authData;

  callbacks.onAuth({
    url: verificationUrl,
    instructions: `Enter code: ${code}`,
  });

  callbacks.onProgress?.("Waiting for browser authorization...");

  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    if (callbacks.signal?.aborted) {
      throw new Error("Login cancelled");
    }

    await abortableSleep(POLL_INTERVAL_MS, callbacks.signal);

    const result = await pollDeviceAuth(code);

    if (result.status === "approved") {
      if (!result.token) {
        throw new Error("Authorization approved but no token received");
      }
      callbacks.onProgress?.("Login successful!");

      const organizationId = await selectKiloOrganization(
        result.token,
        callbacks,
      );

      let accountEmail: string | undefined;
      try {
        const profile = await fetchKiloProfile(result.token);
        accountEmail = profile.user?.email || profile.email;
      } catch {}

      const expiresAt = Date.now() + TOKEN_EXPIRATION_MS;

      const newAccount: KiloAccount = {
        id: `acct-${Date.now()}`,
        accessToken: result.token,
        refreshToken: result.token,
        expiresAt,
        accountId: organizationId,
        email: accountEmail,
        balance: null,
        consecutiveFailures: 0,
        cooldownUntil: 0,
        lastUsed: null,
      };
      addAccount(newAccount);

      console.warn(
        `[kilo] Added account ${newAccount.id}${accountEmail ? ` (${accountEmail})` : ""} (total: ${_accounts.length})`,
      );

      return {
        refresh: result.token,
        access: result.token,
        expires: expiresAt,
        ...(organizationId ? { accountId: organizationId } : {}),
      };
    }

    if (result.status === "denied") {
      throw new Error("Authorization denied by user.");
    }

    if (result.status === "expired") {
      throw new Error("Authorization code expired. Please try again.");
    }

    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    callbacks.onProgress?.(
      `Waiting for browser authorization... (${remaining}s remaining)`,
    );
  }

  throw new Error("Authentication timed out. Please try again.");
}

// ── Token Refresh ─────────────────────────────────────────────────────────

export async function refreshKiloToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (credentials.expires > Date.now()) {
    return credentials;
  }
  throw new Error(
    "Kilo token expired. Please run /login kilo to re-authenticate.",
  );
}
