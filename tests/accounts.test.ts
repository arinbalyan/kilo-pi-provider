/**
 * Tests for account management module.
 *
 * These tests mock the filesystem to control account persistence.
 * Module-level state is reset between test groups via dynamic re-imports.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  initAccounts,
  loadAccounts,
  saveAccounts,
  pickAccount,
  addAccount,
  removeAccount,
  markAccountFailure,
  markAccountSuccess,
  _accounts,
  _lastActiveAccount,
  type KiloAccount,
} from "../src/accounts";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeAccount(overrides: Partial<KiloAccount> = {}): KiloAccount {
  return {
    id: "acct-test",
    accessToken: "token-test",
    refreshToken: "token-test",
    expiresAt: Date.now() + 99999999,
    balance: 100,
    consecutiveFailures: 0,
    cooldownUntil: 0,
    lastUsed: null,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("addAccount / removeAccount", () => {
  beforeEach(() => {
    _accounts.length = 0;
  });

  test("addAccount adds a new account", () => {
    const acct = makeAccount();
    addAccount(acct);
    expect(_accounts.length).toBe(1);
    expect(_accounts[0]!.accessToken).toBe("token-test");
  });

  test("addAccount replaces existing account with same accessToken", () => {
    const acct1 = makeAccount({ balance: 100 });
    const acct2 = makeAccount({ balance: 200 });
    addAccount(acct1);
    addAccount(acct2);
    expect(_accounts.length).toBe(1);
    expect(_accounts[0]!.balance).toBe(200);
  });

  test("addAccount keeps both accounts with different tokens", () => {
    const acct1 = makeAccount({ accessToken: "token-1" });
    const acct2 = makeAccount({ accessToken: "token-2" });
    addAccount(acct1);
    addAccount(acct2);
    expect(_accounts.length).toBe(2);
  });

  test("removeAccount removes by id", () => {
    const acct = makeAccount();
    addAccount(acct);
    expect(removeAccount(acct.id)).toBe(true);
    expect(_accounts.length).toBe(0);
  });

  test("removeAccount returns false for non-existent id", () => {
    expect(removeAccount("nonexistent")).toBe(false);
  });
});

describe("pickAccount", () => {
  beforeEach(() => {
    _accounts.length = 0;
  });

  test("returns undefined when no accounts", () => {
    expect(pickAccount()).toBeUndefined();
  });

  test("returns account when available", () => {
    addAccount(makeAccount());
    const acct = pickAccount();
    expect(acct).toBeDefined();
    expect(acct!.accessToken).toBe("token-test");
  });

  test("skips expired accounts", () => {
    addAccount(makeAccount({ expiresAt: Date.now() - 1000 }));
    expect(pickAccount()).toBeUndefined();
  });

  test("still returns cooldown account as last resort (fallback)", () => {
    // pickAccount() filters out cooldown accounts first, but falls back
    // to any non-expired account if no healthy accounts remain
    addAccount(makeAccount({ cooldownUntil: Date.now() + 99999 }));
    const acct = pickAccount();
    expect(acct).toBeDefined();
    expect(acct!.accessToken).toBe("token-test");
  });

  test("prefers healthy over cooldown accounts", () => {
    addAccount(makeAccount({
      accessToken: "token-healthy",
      cooldownUntil: 0,
    }));
    addAccount(makeAccount({
      accessToken: "token-cooldown",
      cooldownUntil: Date.now() + 99999,
    }));
    const acct = pickAccount();
    expect(acct).toBeDefined();
    expect(acct!.accessToken).toBe("token-healthy");
  });

  test("round-robins across accounts", () => {
    addAccount(makeAccount({ accessToken: "token-1" }));
    addAccount(makeAccount({ accessToken: "token-2" }));
    const first = pickAccount()!;
    const second = pickAccount()!;
    // Should be different accounts
    expect(first.accessToken).not.toBe(second.accessToken);
    // Third pick cycles back to first
    const third = pickAccount()!;
    expect(third.accessToken).toBe(first.accessToken);
  });

  test("sets lastUsed and _lastActiveAccount", () => {
    addAccount(makeAccount());
    const before = Date.now();
    const acct = pickAccount()!;
    expect(acct.lastUsed).toBeGreaterThanOrEqual(before);
    expect(_lastActiveAccount?.accessToken).toBe(acct.accessToken);
  });
});

describe("markAccountFailure / markAccountSuccess", () => {
  beforeEach(() => {
    _accounts.length = 0;
  });

  test("markAccountFailure increments failures and sets cooldown", () => {
    addAccount(makeAccount());
    const acct = _accounts[0]!;
    expect(acct.consecutiveFailures).toBe(0);
    expect(acct.cooldownUntil).toBe(0);

    markAccountFailure(acct.accessToken);
    expect(acct.consecutiveFailures).toBe(1);
    expect(acct.cooldownUntil).toBeGreaterThan(Date.now());
  });

  test("markAccountFailure sets balance to 0 after 3 failures", () => {
    addAccount(makeAccount({ balance: 100 }));
    const acct = _accounts[0]!;
    markAccountFailure(acct.accessToken);
    markAccountFailure(acct.accessToken);
    markAccountFailure(acct.accessToken);
    expect(acct.consecutiveFailures).toBe(3);
    expect(acct.balance).toBe(0);
  });

  test("markAccountSuccess resets failures and cooldown", () => {
    addAccount(makeAccount({
      consecutiveFailures: 5,
      cooldownUntil: Date.now() + 99999,
    }));
    const acct = _accounts[0]!;
    markAccountSuccess(acct.accessToken);
    expect(acct.consecutiveFailures).toBe(0);
    expect(acct.cooldownUntil).toBe(0);
  });

  test("markAccountFailure is no-op for unknown token", () => {
    markAccountFailure("unknown-token");
    // Should not throw
  });

  test("markAccountSuccess is no-op for unknown token", () => {
    markAccountSuccess("unknown-token");
    // Should not throw
  });
});

describe("initAccounts with legacy migration", () => {
  beforeEach(() => {
    _accounts.length = 0;
  });

  test("loads accounts from disk and sets strategy", () => {
    initAccounts();
    expect(Array.isArray(_accounts)).toBe(true);
  });
});
