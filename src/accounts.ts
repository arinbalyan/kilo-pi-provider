/**
 * Multi-account management: load, save, pick, track rate-limits.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir,
  readStoredKiloCredentials,
  TOKEN_EXPIRATION_MS,
  COOLDOWN_MS,
} from "./constants";

// ── Types ─────────────────────────────────────────────────────────────────

export interface KiloAccount {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
  balance: number | null;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastUsed: number | null;
}

// ── Module-Level State ────────────────────────────────────────────────────

const ACCOUNTS_PATH = join(getAgentDir(), "kilo-accounts.json");

export let _accounts: KiloAccount[] = [];
let _strategy: "fill-first" | "round-robin" = "round-robin";
let _roundRobinIndex = 0;
export let _lastActiveAccount: KiloAccount | null = null;

// ── Persistence ───────────────────────────────────────────────────────────

export function loadAccounts(): KiloAccount[] {
  try {
    if (!existsSync(ACCOUNTS_PATH)) return [];
    return JSON.parse(readFileSync(ACCOUNTS_PATH, "utf8")) as KiloAccount[];
  } catch {
    return [];
  }
}

export function saveAccounts(): void {
  const dir = join(getAgentDir());
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(ACCOUNTS_PATH, JSON.stringify(_accounts, null, 2), "utf8");
}

export function initAccounts(): void {
  _accounts = loadAccounts();
  _strategy =
    process.env.KILO_STRATEGY === "fill-first" ? "fill-first" : "round-robin";
  _roundRobinIndex = 0;

  // Migrate legacy single credential into account list if empty
  if (_accounts.length === 0) {
    const legacy = readStoredKiloCredentials();
    if (legacy?.access) {
      _accounts.push({
        id: `acct-${Date.now()}`,
        accessToken: legacy.access,
        refreshToken: legacy.refresh ?? legacy.access,
        expiresAt: legacy.expires ?? Date.now() + TOKEN_EXPIRATION_MS,
        accountId: legacy.accountId,
        balance: null,
        consecutiveFailures: 0,
        cooldownUntil: 0,
        lastUsed: null,
      });
      saveAccounts();
    }
  }
}

// ── Account Selection ─────────────────────────────────────────────────────

export function pickAccount(): KiloAccount | undefined {
  const now = Date.now();
  let valid = _accounts.filter((a) => {
    if (a.expiresAt <= now) return false;
    if (a.cooldownUntil > now) return false;
    if (a.balance !== null && a.balance <= 0) return false;
    return true;
  });

  if (valid.length === 0) {
    valid = _accounts.filter((a) => a.expiresAt > now);
    if (valid.length === 0) return undefined;
  }

  if (_strategy === "fill-first") {
    valid.sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));
  }

  const idx = _roundRobinIndex % valid.length;
  _roundRobinIndex++;
  const account = valid[idx]!;
  account.lastUsed = now;
  _lastActiveAccount = account;
  return account;
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export function addAccount(account: KiloAccount): void {
  const existing = _accounts.findIndex(
    (a) => a.accessToken === account.accessToken,
  );
  if (existing >= 0) {
    _accounts[existing] = account;
  } else {
    _accounts.push(account);
  }
  saveAccounts();
}

export function removeAccount(id: string): boolean {
  const before = _accounts.length;
  _accounts = _accounts.filter((a) => a.id !== id);
  if (_accounts.length !== before) {
    saveAccounts();
    return true;
  }
  return false;
}

// ── Rate-Limit Tracking ───────────────────────────────────────────────────

export function markAccountFailure(accessToken: string): void {
  const account = _accounts.find((a) => a.accessToken === accessToken);
  if (!account) return;
  account.consecutiveFailures++;
  account.cooldownUntil = Date.now() + COOLDOWN_MS;
  if (account.consecutiveFailures >= 3) {
    account.balance = 0;
  }
}

export function markAccountSuccess(accessToken: string): void {
  const account = _accounts.find((a) => a.accessToken === accessToken);
  if (!account) return;
  account.consecutiveFailures = 0;
  account.cooldownUntil = 0;
}
