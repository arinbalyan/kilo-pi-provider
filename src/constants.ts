/**
 * Constants, environment helpers, and shared utilities for the Kilo provider.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai";

// ── API Endpoints ─────────────────────────────────────────────────────────

export const KILO_API_BASE = process.env.KILO_API_URL || "https://api.kilo.ai";
export const KILO_GATEWAY_BASE = `${KILO_API_BASE}/api/gateway`;
export const KILO_OPENROUTER_BASE = `${KILO_API_BASE}/api/openrouter`;
export const KILO_DEVICE_AUTH_ENDPOINT = `${KILO_API_BASE}/api/device-auth/codes`;
export const KILO_PROFILE_ENDPOINT = `${KILO_API_BASE}/api/profile`;
export const KILO_ORG_HEADER = "X-KiloCode-OrganizationId";

// ── Timing ────────────────────────────────────────────────────────────────

export const POLL_INTERVAL_MS = 3000;
export const MODELS_FETCH_TIMEOUT_MS = 10_000;
export const TOKEN_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
export const COOLDOWN_MS = 60_000;

// ── Other ─────────────────────────────────────────────────────────────────

export const KILO_TOS_URL = "https://kilo.ai/terms";

// ── Environment Helpers ───────────────────────────────────────────────────

export function getEnvOrganizationId(): string | undefined {
  return process.env.KILO_ORG_ID || process.env.KILOCODE_ORGANIZATION_ID;
}

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function readStoredKiloCredentials(): OAuthCredentials | undefined {
  try {
    const authPath = join(getAgentDir(), "auth.json");
    if (!existsSync(authPath)) return undefined;
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as {
      kilo?: { type?: string } & OAuthCredentials;
    };
    const cred = auth.kilo;
    if (cred?.type !== "oauth" || !cred.access) return undefined;
    return cred;
  } catch {
    return undefined;
  }
}

export function getCredentialOrganizationId(
  credentials?: OAuthCredentials,
): string | undefined {
  const accountId = credentials?.accountId;
  return typeof accountId === "string" && accountId.trim() ? accountId : undefined;
}

export function getEffectiveOrganizationId(
  credentials?: OAuthCredentials,
): string | undefined {
  return getCredentialOrganizationId(credentials) ?? getEnvOrganizationId();
}

export function withOrganizationHeader(
  headers: Record<string, string>,
  organizationId?: string,
): Record<string, string> {
  if (!organizationId) return headers;
  return { ...headers, [KILO_ORG_HEADER]: organizationId };
}
