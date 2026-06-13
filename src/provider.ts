/**
 * Provider configuration: base config and factory.
 */

import {
  KILO_GATEWAY_BASE,
  withOrganizationHeader,
  KILO_ORG_HEADER,
} from "./constants";

// ── Base Config ───────────────────────────────────────────────────────────

export const KILO_PROVIDER_CONFIG = {
  baseUrl: KILO_GATEWAY_BASE,
  apiKey: "$KILO_API_KEY",
  api: "openai-completions" as const,
  headers: {
    "X-KILOCODE-EDITORNAME": "Pi",
    "User-Agent": "pi-kilo-provider",
  },
};

// ── Factory ───────────────────────────────────────────────────────────────

export function makeProviderConfig(organizationId?: string) {
  return {
    ...KILO_PROVIDER_CONFIG,
    headers: withOrganizationHeader(
      KILO_PROVIDER_CONFIG.headers,
      organizationId,
    ),
  };
}
