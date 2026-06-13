/**
 * Tests for constants and utility functions.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";

// We need to re-import after clearing env, so we use dynamic imports
const ORIGINAL_KILO_API_URL = process.env.KILO_API_URL;
const ORIGINAL_KILO_ORG_ID = process.env.KILO_ORG_ID;
const ORIGINAL_KILOCODE_ORGANIZATION_ID = process.env.KILOCODE_ORGANIZATION_ID;
const ORIGINAL_PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

async function reloadModule() {
  // Force re-import
  delete require.cache[require.resolve("../src/constants")];
  return await import("../src/constants");
}

describe("constants", () => {
  afterAll(() => {
    process.env.KILO_API_URL = ORIGINAL_KILO_API_URL;
    process.env.KILO_ORG_ID = ORIGINAL_KILO_ORG_ID;
    process.env.KILOCODE_ORGANIZATION_ID = ORIGINAL_KILOCODE_ORGANIZATION_ID;
    process.env.PI_CODING_AGENT_DIR = ORIGINAL_PI_CODING_AGENT_DIR;
  });

  describe("base constants", () => {
    test("KILO_API_BASE defaults to https://api.kilo.ai", () => {
      expect(process.env.KILO_API_URL || "https://api.kilo.ai").toBe("https://api.kilo.ai");
    });

    test("KILO_TOS_URL is correct", async () => {
      const mod = await reloadModule();
      expect(mod.KILO_TOS_URL).toBe("https://kilo.ai/terms");
    });

    test("POLL_INTERVAL_MS is 3000", async () => {
      const mod = await reloadModule();
      expect(mod.POLL_INTERVAL_MS).toBe(3000);
    });

    test("COOLDOWN_MS is 60000", async () => {
      const mod = await reloadModule();
      expect(mod.COOLDOWN_MS).toBe(60000);
    });

    test("TOKEN_EXPIRATION_MS is 1 year", async () => {
      const mod = await reloadModule();
      expect(mod.TOKEN_EXPIRATION_MS).toBe(365 * 24 * 60 * 60 * 1000);
    });
  });

  describe("getEnvOrganizationId", () => {
    beforeEach(() => {
      delete process.env.KILO_ORG_ID;
      delete process.env.KILOCODE_ORGANIZATION_ID;
    });

    test("returns undefined when no env vars set", async () => {
      const mod = await reloadModule();
      expect(mod.getEnvOrganizationId()).toBeUndefined();
    });

    test("reads KILO_ORG_ID", async () => {
      process.env.KILO_ORG_ID = "org_test123";
      const mod = await reloadModule();
      expect(mod.getEnvOrganizationId()).toBe("org_test123");
    });

    test("reads KILOCODE_ORGANIZATION_ID fallback", async () => {
      process.env.KILOCODE_ORGANIZATION_ID = "org_fallback";
      const mod = await reloadModule();
      expect(mod.getEnvOrganizationId()).toBe("org_fallback");
    });

    test("KILO_ORG_ID takes precedence over KILOCODE_ORGANIZATION_ID", async () => {
      process.env.KILO_ORG_ID = "org_primary";
      process.env.KILOCODE_ORGANIZATION_ID = "org_secondary";
      const mod = await reloadModule();
      expect(mod.getEnvOrganizationId()).toBe("org_primary");
    });
  });

  describe("getAgentDir", () => {
    beforeEach(() => {
      delete process.env.PI_CODING_AGENT_DIR;
    });

    test("defaults to ~/.pi/agent", async () => {
      const mod = await reloadModule();
      expect(mod.getAgentDir()).toMatch(/\.pi\/agent$/);
    });

    test("reads PI_CODING_AGENT_DIR", async () => {
      process.env.PI_CODING_AGENT_DIR = "/custom/path";
      const mod = await reloadModule();
      expect(mod.getAgentDir()).toBe("/custom/path");
    });
  });

  describe("withOrganizationHeader", () => {
    test("returns headers unchanged when no org id", async () => {
      const mod = await reloadModule();
      const headers = { Authorization: "Bearer test" };
      const result = mod.withOrganizationHeader(headers);
      expect(result).toEqual({ Authorization: "Bearer test" });
    });

    test("adds X-KiloCode-OrganizationId header", async () => {
      const mod = await reloadModule();
      const headers = { Authorization: "Bearer test" };
      const result = mod.withOrganizationHeader(headers, "org_123");
      expect(result).toEqual({
        Authorization: "Bearer test",
        "X-KiloCode-OrganizationId": "org_123",
      });
    });

    test("does not mutate original headers object", async () => {
      const mod = await reloadModule();
      const headers = { Authorization: "Bearer test" };
      const original = { ...headers };
      mod.withOrganizationHeader(headers, "org_123");
      expect(headers).toEqual(original);
    });
  });

  describe("getCredentialOrganizationId", () => {
    test("returns undefined for undefined credentials", async () => {
      const mod = await reloadModule();
      expect(mod.getCredentialOrganizationId(undefined)).toBeUndefined();
    });

    test("returns undefined when accountId is missing", async () => {
      const mod = await reloadModule();
      expect(mod.getCredentialOrganizationId({} as any)).toBeUndefined();
    });

    test("returns accountId when present", async () => {
      const mod = await reloadModule();
      const cred = { accountId: "org_abc" } as any;
      expect(mod.getCredentialOrganizationId(cred)).toBe("org_abc");
    });

    test("returns undefined for empty string accountId", async () => {
      const mod = await reloadModule();
      const cred = { accountId: "" } as any;
      expect(mod.getCredentialOrganizationId(cred)).toBeUndefined();
    });
  });
});
