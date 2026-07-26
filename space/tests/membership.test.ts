import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatasetMirror } from "../src/dataset.js";
import { PoolMembership } from "../src/membership.js";
import { TweetStore } from "../src/store.js";
import { FakeHub } from "./helpers.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");

let dir: string;
let hub: FakeHub;
let mirror: DatasetMirror;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xtap-pool-membership-"));
  hub = new FakeHub();
  mirror = new DatasetMirror(hub, dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PoolMembership", () => {
  it("bootstraps members and first-user admin when no config exists", async () => {
    const membership = await PoolMembership.load({
      mirror,
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

  it("loads dataset config without treating bootstrap members as permanent members", async () => {
    hub.files.set(
      "config/pool.json",
      JSON.stringify({
        version: 1,
        admins: ["carol"],
        members: ["carol"],
        updated_at: NOW.toISOString(),
      }),
    );
    const membership = await PoolMembership.load({
      mirror,
      bootstrapMembers: ["osolmaz", "alice"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    expect(membership.snapshot()).toMatchObject({
      members: ["carol", "osolmaz"],
      admins: ["carol", "osolmaz"],
      source: "dataset",
    });
    expect(membership.isMember("alice")).toBe(false);
  });

  it("authorizes identities through member organization grants", async () => {
    hub.files.set(
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
      mirror,
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
      mirror,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    await membership.addMember("osolmaz", "Alice");
    const raw = hub.files.get("config/pool.json");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw ?? "{}")).toMatchObject({
      members: ["alice", "osolmaz"],
      updated_by: "osolmaz",
    });
    expect(hub.commits[0]?.title).toBe("config: add pool member alice");
  });

  it("commits one active member organization to config/pool.json", async () => {
    const membership = await PoolMembership.load({
      mirror,
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
    expect(hub.commits[0]?.title).toBe("config: set member org huggingface");

    await membership.addMemberOrg("osolmaz", {
      name: "dutifuldev",
      sub: "org-dutiful",
      display_name: "Dutiful",
    });
    expect(membership.snapshot().member_orgs).toEqual([
      { name: "dutifuldev", sub: "org-dutiful", display_name: "Dutiful" },
    ]);
    expect(membership.memberOrgId()).toBe("org-dutiful");
    expect(hub.commits[1]?.title).toBe("config: set member org dutifuldev");

    await membership.removeMemberOrg("osolmaz", "dutifuldev");
    expect(membership.snapshot().member_orgs).toEqual([]);
    expect(hub.commits[2]?.title).toBe("config: remove member org dutifuldev");
  });

  it("loads only the first configured member organization", async () => {
    hub.files.set(
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
      mirror,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    expect(membership.snapshot().member_orgs).toEqual([{ name: "huggingface", sub: "org-hf" }]);
    expect(membership.memberOrgId()).toBe("org-hf");
  });

  it("leaves membership unchanged when a config commit fails", async () => {
    const membership = await PoolMembership.load({
      mirror,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    await membership.addMember("osolmaz", "alice");

    hub.failNextCommit = true;
    await expect(membership.addMember("osolmaz", "bob")).rejects.toThrow("hub unavailable");
    expect(membership.isMember("bob")).toBe(false);
    expect(membership.snapshot().members).toEqual(["alice", "osolmaz"]);

    hub.failNextCommit = true;
    await expect(membership.removeMember("osolmaz", "alice")).rejects.toThrow("hub unavailable");
    expect(membership.isMember("alice")).toBe(true);
    expect(membership.snapshot().members).toEqual(["alice", "osolmaz"]);
  });

  it("falls back to bootstrap members when config cannot be read", async () => {
    const brokenMirror = new DatasetMirror(
      {
        listJsonlFiles: () => Promise.resolve([]),
        downloadFile: () => Promise.reject(new Error("cannot read dataset")),
        commitFiles: () => Promise.resolve(),
      },
      dir,
    );
    const membership = await PoolMembership.load({
      mirror: brokenMirror,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    expect(membership.snapshot()).toMatchObject({
      source: "bootstrap",
      config_error: "cannot read dataset",
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

  it("reloads dataset membership after a transient read failure", async () => {
    hub.files.set(
      "config/pool.json",
      JSON.stringify({
        version: 1,
        admins: ["carol"],
        members: ["carol"],
        updated_at: NOW.toISOString(),
      }),
    );
    let failReads = true;
    const flakyMirror = new DatasetMirror(
      {
        listJsonlFiles: (prefix) => hub.listJsonlFiles(prefix),
        downloadFile: (path) => {
          if (failReads) return Promise.reject(new Error("temporary hub failure"));
          return hub.downloadFile(path);
        },
        commitFiles: (files, title) => hub.commitFiles(files, title),
      },
      dir,
    );
    const membership = await PoolMembership.load({
      mirror: flakyMirror,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    expect(membership.snapshot()).toMatchObject({
      source: "bootstrap",
      config_error: "temporary hub failure",
    });

    failReads = false;
    await expect(membership.reload()).resolves.toMatchObject({
      source: "dataset",
      members: ["carol", "osolmaz"],
      admins: ["carol", "osolmaz"],
    });
    expect(membership.snapshot().config_error).toBeUndefined();
    await expect(membership.addMember("carol", "alice")).resolves.toMatchObject({
      members: ["alice", "carol", "osolmaz"],
    });
  });

  it("falls back to bootstrap admins when config is invalid", async () => {
    hub.files.set("config/pool.json", "not json");
    const membership = await PoolMembership.load({
      mirror,
      bootstrapMembers: ["osolmaz"],
      bootstrapAdmins: ["osolmaz"],
      now: () => NOW,
    });
    expect(membership.snapshot().source).toBe("bootstrap");
    expect(membership.snapshot().config_error).toBeDefined();
    expect(membership.isAdmin("osolmaz")).toBe(true);
    expect(membership.hasPermanentConfigError()).toBe(true);

    await expect(membership.repairConfig("osolmaz")).resolves.toMatchObject({
      source: "dataset",
      members: ["osolmaz"],
      admins: ["osolmaz"],
    });
    expect(membership.snapshot().config_error).toBeUndefined();
    expect(JSON.parse(hub.files.get("config/pool.json") ?? "{}")).toMatchObject({
      members: ["osolmaz"],
      admins: ["osolmaz"],
      updated_by: "osolmaz",
    });
    expect(hub.commits.at(-1)?.title).toBe("config: repair pool membership");
  });

  it("falls back when schema-valid config contains an invalid username", async () => {
    hub.files.set(
      "config/pool.json",
      JSON.stringify({
        version: 1,
        admins: ["not a username"],
        members: [],
        updated_at: NOW.toISOString(),
      }),
    );
    const membership = await PoolMembership.load({
      mirror,
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

describe("DatasetMirror metadata files", () => {
  it("does not include config files in data rebuilds", async () => {
    hub.files.set("config/pool.json", "{}");
    const store = new TweetStore();
    try {
      await expect(mirror.rebuild(store)).resolves.toEqual({ files: 0, tweets: 0 });
    } finally {
      store.close();
    }
  });
});
