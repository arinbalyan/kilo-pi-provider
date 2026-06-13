/**
 * Tests for usage tracking module.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  recordUsage,
  getUsageByAccount,
  getTotalRequests,
  resetUsage,
} from "../src/usage";

describe("usage tracking", () => {
  beforeEach(() => {
    resetUsage();
  });

  test("starts empty", () => {
    expect(getUsageByAccount()).toHaveLength(0);
    expect(getTotalRequests()).toBe(0);
  });

  test("records a single usage entry", () => {
    recordUsage("user@test.com", "tok_abc123", "model-x", {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 165,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0005, total: 0.0036 },
    });

    const byAccount = getUsageByAccount();
    expect(byAccount).toHaveLength(1);
    expect(byAccount[0]!.accountEmail).toBe("user@test.com");
    expect(byAccount[0]!.models).toHaveLength(1);
    expect(byAccount[0]!.models[0]!.modelId).toBe("model-x");
    expect(byAccount[0]!.models[0]!.input).toBe(100);
    expect(byAccount[0]!.models[0]!.output).toBe(50);
    expect(byAccount[0]!.models[0]!.totalTokens).toBe(165);
    expect(byAccount[0]!.models[0]!.cost).toBeCloseTo(0.0036);
    expect(getTotalRequests()).toBe(1);
  });

  test("aggregates multiple requests for same account and model", () => {
    recordUsage("user@test.com", "tok_abc", "model-x", {
      input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    recordUsage("user@test.com", "tok_abc", "model-x", {
      input: 200, output: 75, cacheRead: 0, cacheWrite: 0, totalTokens: 275,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });

    const byAccount = getUsageByAccount();
    expect(byAccount).toHaveLength(1);
    expect(byAccount[0]!.models).toHaveLength(1);
    expect(byAccount[0]!.models[0]!.requests).toBe(2);
    expect(byAccount[0]!.models[0]!.input).toBe(300);
    expect(byAccount[0]!.models[0]!.output).toBe(125);
    expect(byAccount[0]!.totalTokens).toBe(425);
  });

  test("separates accounts and models correctly", () => {
    recordUsage("alice@test.com", "tok_a", "model-1", {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    recordUsage("alice@test.com", "tok_a", "model-2", {
      input: 20, output: 10, cacheRead: 2, cacheWrite: 1, totalTokens: 33,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    recordUsage("bob@test.com", "tok_b", "model-1", {
      input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    });

    const byAccount = getUsageByAccount();
    expect(byAccount).toHaveLength(2);

    const alice = byAccount.find((a) => a.accountEmail === "alice@test.com")!;
    expect(alice.models).toHaveLength(2);
    expect(alice.requests).toBe(2);
    expect(alice.totalTokens).toBe(48);

    const bob = byAccount.find((a) => a.accountEmail === "bob@test.com")!;
    expect(bob.models).toHaveLength(1);
    expect(bob.cost).toBeCloseTo(0.03);
  });

  test("uses token prefix when email is missing", () => {
    recordUsage(undefined, "tok_secret123", "model-x", {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });

    const byAccount = getUsageByAccount();
    expect(byAccount).toHaveLength(1);
    expect(byAccount[0]!.accountKey).toBe("acct:tok_secr");
  });
});
