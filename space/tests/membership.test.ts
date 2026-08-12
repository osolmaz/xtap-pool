import { beforeEach, describe, expect, it } from "vitest";

import { PoolMembership } from "../src/membership.js";
import { FakeLog } from "./fake-log.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");

let log: FakeLog;

beforeEach(() => {
  log = new FakeLog();
});

describe("PoolMembership", () => {
  it("bootstraps members and first-user admin when no config exists", async () => {
    const membership = await PoolMembership.load({
      log,
      bootstrapMembers: ["osolmaz", "alice"],
      bootstrapAdmins: [],
      now: () => NOW,
    });
    expect(membership.snapshot()).toMatchObject({
      members: ["alice", "osolmaz"],
      admins: ["osolmaz"],
      source: "bootstrap",
    });
    expect(membership.isMember("alice")).toBe(true);
    expect(membership.isAdmin("alice")).toBe(false);
  });

  it("loads Bucket config without treating bootstrap members as permanent members", async () => {
    log.files.set(
      "config/pool.json",
      JSON.stringify({
        version: 1,
        admins: ["carol"],
        members: ["carol"],
        updated_at: NOW.toISOString(),
      }),
    );
    const membership = await PoolMembership.load({
      log,
      bootstrapMembers: ["osolmaz", "alice"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    expect(membership.snapshot()).toMatchObject({
      members: ["carol", "osolmaz"],
      admins: ["carol", "osolmaz"],
      source: "bucket",
    });
    expect(membership.isMember("alice")).toBe(false);
  });

  it("authorizes identities through member organization grants", async () => {
    log.files.set(
      "config/pool.json",
      JSON.stringify({
        version: 1,
        admins: ["carol"],
        members: ["carol"],
        member_orgs: [{ name: "huggingface", sub: "org-hf", display_name: "Hugging Face" }],
        updated_at: NOW.toISOString(),
      }),
    );
    const membership = await PoolMembership.load({
      log,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });

    expect(
      membership.accessFor({
        username: "dana",
        orgs: [{ sub: "org-hf", name: "huggingface" }],
      }),
    ).toMatchObject({ type: "member_org", org: { name: "huggingface" } });
    expect(membership.memberOrgId()).toBe("org-hf");
    expect(membership.isAdmin("dana")).toBe(false);
    expect(membership.accessFor({ username: "erin", orgs: [{ sub: "org-other" }] })).toBe(
      undefined,
    );
  });

  it("commits member changes to config/pool.json", async () => {
    const membership = await PoolMembership.load({
      log,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    await membership.addMember("osolmaz", "Alice");
    const raw = log.files.get("config/pool.json");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw ?? "{}")).toMatchObject({
      members: ["alice", "osolmaz"],
      updated_by: "osolmaz",
    });
    expect(log.commits[0]?.title).toBe("config: add pool member alice");
  });

  it("commits one active member organization to config/pool.json", async () => {
    const membership = await PoolMembership.load({
      log,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    await membership.addMemberOrg("osolmaz", {
      name: "HuggingFace",
      sub: "org-hf",
      display_name: "Hugging Face",
    });
    expect(membership.snapshot().member_orgs).toEqual([
      { name: "huggingface", sub: "org-hf", display_name: "Hugging Face" },
    ]);
    expect(log.commits[0]?.title).toBe("config: set member org huggingface");

    await membership.addMemberOrg("osolmaz", {
      name: "dutifuldev",
      sub: "org-dutiful",
      display_name: "Dutiful",
    });
    expect(membership.snapshot().member_orgs).toEqual([
      { name: "dutifuldev", sub: "org-dutiful", display_name: "Dutiful" },
    ]);
    expect(membership.memberOrgId()).toBe("org-dutiful");
    expect(log.commits[1]?.title).toBe("config: set member org dutifuldev");

    await membership.removeMemberOrg("osolmaz", "dutifuldev");
    expect(membership.snapshot().member_orgs).toEqual([]);
    expect(log.commits[2]?.title).toBe("config: remove member org dutifuldev");
  });

  it("loads only the first configured member organization", async () => {
    log.files.set(
      "config/pool.json",
      JSON.stringify({
        version: 1,
        admins: ["carol"],
        members: ["carol"],
        member_orgs: [
          { name: "huggingface", sub: "org-hf" },
          { name: "dutifuldev", sub: "org-dutiful" },
        ],
        updated_at: NOW.toISOString(),
      }),
    );
    const membership = await PoolMembership.load({
      log,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    expect(membership.snapshot().member_orgs).toEqual([{ name: "huggingface", sub: "org-hf" }]);
    expect(membership.memberOrgId()).toBe("org-hf");
  });

  it("leaves membership unchanged when a config commit fails", async () => {
    const membership = await PoolMembership.load({
      log,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    await membership.addMember("osolmaz", "alice");

    log.failNextCommit = true;
    await expect(membership.addMember("osolmaz", "bob")).rejects.toThrow("Bucket unavailable");
    expect(membership.isMember("bob")).toBe(false);
    expect(membership.snapshot().members).toEqual(["alice", "osolmaz"]);

    log.failNextCommit = true;
    await expect(membership.removeMember("osolmaz", "alice")).rejects.toThrow("Bucket unavailable");
    expect(membership.isMember("alice")).toBe(true);
    expect(membership.snapshot().members).toEqual(["alice", "osolmaz"]);
  });

  it("falls back to bootstrap members when config cannot be read", async () => {
    log.failReadAttempts = 1;
    const membership = await PoolMembership.load({
      log,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    expect(membership.snapshot()).toMatchObject({
      source: "bootstrap",
      config_error: "Bucket unavailable",
    });
    expect(membership.isAdmin("osolmaz")).toBe(true);
    expect(membership.hasPermanentConfigError()).toBe(false);
    await expect(membership.repairConfig("osolmaz")).rejects.toThrow(
      "does not have a repairable validation error",
    );
    await expect(membership.addMember("osolmaz", "alice")).rejects.toThrow(
      "pool config is unavailable",
    );
  });

  it("reloads Bucket membership after a transient read failure", async () => {
    log.files.set(
      "config/pool.json",
      JSON.stringify({
        version: 1,
        admins: ["carol"],
        members: ["carol"],
        updated_at: NOW.toISOString(),
      }),
    );
    log.failReadAttempts = 1;
    const membership = await PoolMembership.load({
      log,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    expect(membership.snapshot()).toMatchObject({
      source: "bootstrap",
      config_error: "Bucket unavailable",
    });

    await expect(membership.reload()).resolves.toMatchObject({
      source: "bucket",
      members: ["carol", "osolmaz"],
      admins: ["carol", "osolmaz"],
    });
    expect(membership.snapshot().config_error).toBeUndefined();
    await expect(membership.addMember("carol", "alice")).resolves.toMatchObject({
      members: ["alice", "carol", "osolmaz"],
    });
  });

  it("falls back to bootstrap admins when config is invalid", async () => {
    log.files.set("config/pool.json", "not json");
    const membership = await PoolMembership.load({
      log,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    expect(membership.snapshot().source).toBe("bootstrap");
    expect(membership.snapshot().config_error).toBeDefined();
    expect(membership.isAdmin("osolmaz")).toBe(true);
    expect(membership.hasPermanentConfigError()).toBe(true);

    await expect(membership.repairConfig("osolmaz")).resolves.toMatchObject({
      source: "bucket",
      members: ["osolmaz"],
      admins: ["osolmaz"],
    });
    expect(membership.snapshot().config_error).toBeUndefined();
    expect(JSON.parse(log.files.get("config/pool.json") ?? "{}")).toMatchObject({
      members: ["osolmaz"],
      admins: ["osolmaz"],
      updated_by: "osolmaz",
    });
    expect(log.commits.at(-1)?.title).toBe("config: repair pool membership");
  });

  it("falls back when schema-valid config contains an invalid username", async () => {
    log.files.set(
      "config/pool.json",
      JSON.stringify({
        version: 1,
        admins: ["not a username"],
        members: [],
        updated_at: NOW.toISOString(),
      }),
    );
    const membership = await PoolMembership.load({
      log,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    expect(membership.snapshot()).toMatchObject({
      source: "bootstrap",
      config_error: "invalid Hugging Face username: not a username",
    });
    expect(membership.isAdmin("osolmaz")).toBe(true);
  });
});
