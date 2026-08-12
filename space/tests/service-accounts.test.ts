import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SERVICE_ACCOUNTS_PATH, ServiceAccountRegistry } from "../src/service-accounts.js";
import { FakeLog } from "./fake-log.js";

const NOW = new Date("2026-07-27T00:00:00.000Z");

let dir: string;
let log: FakeLog;
let registry: ServiceAccountRegistry;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "xtap-service-accounts-"));
  log = new FakeLog();
  registry = await ServiceAccountRegistry.load({
    log,
    now: () => NOW,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ServiceAccountRegistry", () => {
  it("starts deny-by-default when the registry file is absent", () => {
    expect(registry.snapshot()).toEqual({ version: 1, accounts: [], source: "empty" });
    expect(registry.authorize("xtap_sa_missing", "units:read")).toBeUndefined();
  });

  it("issues a one-time credential and persists only its hash", async () => {
    const issued = await registry.issue("osolmaz", "local-frontier", [
      "units:read",
      "taxonomy:read",
    ]);
    expect(issued.token).toMatch(/^xtap_sa_[a-f0-9]+_[a-f0-9]+_[A-Za-z0-9_-]+$/);
    expect(registry.authorize(issued.token, "units:read")).toMatchObject({
      id: issued.account.id,
      name: "local-frontier",
    });
    expect(registry.authorize(issued.token, "taxonomy:read")).toBeDefined();

    const durable = log.files.get(SERVICE_ACCOUNTS_PATH) ?? "";
    const secret = /^xtap_sa_[^_]+_[^_]+_(.+)$/.exec(issued.token)?.[1];
    if (secret === undefined) throw new Error("issued token is malformed");
    expect(durable).not.toContain(issued.token);
    expect(durable).not.toContain(secret);
    expect(durable).toContain("token_hash");
  });

  it("enforces scopes and supports overlap-safe key rotation", async () => {
    const first = await registry.issue("osolmaz", "reader", ["units:read"]);
    expect(registry.authorize(first.token, "taxonomy:read")).toBeUndefined();

    const second = await registry.rotate("osolmaz", first.account.id);
    expect(registry.authorize(first.token, "units:read")).toBeDefined();
    expect(registry.authorize(second.token, "units:read")).toBeDefined();

    const firstKey = first.account.keys[0];
    expect(firstKey).toBeDefined();
    await registry.revokeKey("osolmaz", first.account.id, firstKey?.id ?? "");
    expect(registry.authorize(first.token, "units:read")).toBeUndefined();
    expect(registry.authorize(second.token, "units:read")).toBeDefined();

    await registry.revoke("osolmaz", first.account.id);
    expect(registry.authorize(second.token, "units:read")).toBeUndefined();
    expect(registry.snapshot().accounts[0]?.status).toBe("revoked");
  });

  it("fails closed when a durable key has an invalid expiration timestamp", async () => {
    log.files.set(
      SERVICE_ACCOUNTS_PATH,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "account",
            name: "reader",
            scopes: ["units:read"],
            status: "active",
            created_at: NOW.toISOString(),
            updated_at: NOW.toISOString(),
            keys: [
              {
                id: "key",
                token_hash: "0".repeat(64),
                created_at: NOW.toISOString(),
                expires_at: "not-a-timestamp",
              },
            ],
          },
        ],
      }),
    );
    registry = await ServiceAccountRegistry.load({
      log,
      now: () => NOW,
    });

    expect(registry.hasPermanentConfigError()).toBe(true);
    expect(registry.snapshot().accounts).toEqual([]);
  });

  it("fails closed on malformed durable configuration and repairs explicitly", async () => {
    log.files.set(SERVICE_ACCOUNTS_PATH, "not json");
    registry = await ServiceAccountRegistry.load({
      log,
      now: () => NOW,
    });
    expect(registry.hasPermanentConfigError()).toBe(true);
    await expect(registry.issue("osolmaz", "blocked", ["units:read"])).rejects.toThrow(
      "service account config is unavailable",
    );

    await registry.repair("osolmaz");
    expect(registry.snapshot()).toEqual({ version: 1, accounts: [], source: "bucket" });
  });
});
