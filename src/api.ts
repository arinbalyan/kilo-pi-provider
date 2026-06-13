/**
 * Kilo API wrappers: profile, balance, organization selection.
 */

import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
  KILO_API_BASE,
  KILO_PROFILE_ENDPOINT,
  withOrganizationHeader,
  getEnvOrganizationId,
} from "./constants";

// ── Types ─────────────────────────────────────────────────────────────────

export interface KiloOrganization {
  id: string;
  name: string;
  role?: string;
}

export interface KiloProfile {
  user?: { email?: string; name?: string };
  email?: string;
  name?: string;
  organizations?: KiloOrganization[];
}

export interface KiloBalance {
  balance?: number;
}

/** A single day of aggregated usage from the Kilo API. */
export interface KiloDailyUsage {
  date: string;
  total_cost: number;
  request_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_write_tokens: number;
  total_cache_hit_tokens: number;
}

export interface KiloUsageResponse {
  usage: KiloDailyUsage[];
}

// ── Profile ───────────────────────────────────────────────────────────────

export async function fetchKiloProfile(
  token: string,
): Promise<KiloProfile> {
  const response = await fetch(KILO_PROFILE_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Kilo profile: ${response.status}`);
  }

  return (await response.json()) as KiloProfile;
}

// ── Organization Selection ────────────────────────────────────────────────

export async function selectKiloOrganization(
  token: string,
  callbacks: OAuthLoginCallbacks,
): Promise<string | undefined> {
  let profile: KiloProfile;
  try {
    callbacks.onProgress?.("Fetching Kilo profile...");
    profile = await fetchKiloProfile(token);
  } catch (error) {
    console.warn(
      "[kilo] Failed to fetch profile for organization selection:",
      error instanceof Error ? error.message : error,
    );
    return getEnvOrganizationId();
  }

  const organizations = profile.organizations ?? [];
  const envOrganizationId = getEnvOrganizationId();
  if (
    envOrganizationId &&
    organizations.some((org) => org.id === envOrganizationId)
  ) {
    return envOrganizationId;
  }
  if (!callbacks.onSelect || organizations.length === 0) {
    return envOrganizationId;
  }

  const selected = await callbacks.onSelect({
    message: "Select Kilo account",
    options: [
      { id: "personal", label: "Personal Account" },
      ...organizations.map((org) => ({
        id: org.id,
        label: `${org.name}${org.role ? ` (${org.role})` : ""}`,
      })),
    ],
  });

  if (!selected || selected === "personal") return undefined;
  return selected;
}

// ── Balance ───────────────────────────────────────────────────────────────

export async function fetchKiloBalance(
  token: string,
  organizationId?: string,
): Promise<number | null> {
  try {
    const response = await fetch(`${KILO_PROFILE_ENDPOINT}/balance`, {
      headers: withOrganizationHeader(
        {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        organizationId,
      ),
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as KiloBalance;
    return data.balance ?? null;
  } catch {
    return null;
  }
}

// ── Usage History ─────────────────────────────────────────────────────────

/**
 * Fetch usage history from Kilo API for a given account.
 * Calls GET /api/profile/usage with the account's bearer token.
 */
/**
 * Fetch daily usage history from Kilo API for a given account.
 * Calls GET /api/profile/usage with the account's bearer token.
 */
export async function fetchKiloUsage(
  token: string,
  organizationId?: string,
): Promise<KiloDailyUsage[]> {
  try {
    const response = await fetch(`${KILO_API_BASE}/api/profile/usage`, {
      headers: withOrganizationHeader(
        {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        organizationId,
      ),
    });

    if (!response.ok) {
      console.warn(
        `[kilo] Usage API returned ${response.status} for token`,
      );
      return [];
    }

    const data = (await response.json()) as KiloUsageResponse;

    if (!data.usage || !Array.isArray(data.usage)) {
      console.warn("[kilo] Usage API returned unexpected format");
      return [];
    }

    return data.usage;
  } catch (error) {
    console.warn(
      "[kilo] Failed to fetch usage:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

// ── Formatting ────────────────────────────────────────────────────────────

export function formatCredits(balance: number): string {
  if (balance >= 1000) {
    return `$${(balance / 1000).toFixed(1)}k`;
  }
  return `$${balance.toFixed(2)}`;
}
