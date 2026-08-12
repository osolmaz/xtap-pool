import { describe, expect, it } from "vitest";

import {
  defaultSetupConfig,
  existingSpaceConfig,
  normalizeUsers,
  repoInNamespace,
  spacePublicUrl,
  tokenSettingsUrl,
  usersValue,
  validateNamespace,
  validateRepoId,
  validateUserList,
} from "../src/config.js";

describe("setup config helpers", () => {
  it("derives default repos from the active username", () => {
    expect(defaultSetupConfig("alice")).toEqual({
      namespace: "alice",
      spaceRepo: "alice/xtap-pool",
      rawBucket: "alice/xtap-pool-data",
      indexBucket: "alice/xtap-pool-bucket",
      allowedUsers: ["alice"],
      poolAdmins: ["alice"],
    });
  });

  it("normalizes comma-separated allowlists", () => {
    expect(normalizeUsers("alice, bob,alice,, carol ")).toEqual(["alice", "bob", "carol"]);
    expect(usersValue(["alice", "bob"])).toBe("alice,bob");
  });

  it("derives update config from existing Space variables", () => {
    const config = existingSpaceConfig(
      "alice",
      "team/xtap-pool",
      new Map([
        ["RAW_BUCKET", "team/tweets"],
        ["INDEX_BUCKET", "team/tweets-index-bucket"],
        ["ALLOWED_USERS", "alice,bob"],
        ["POOL_ADMINS", "bob"],
      ]),
    );

    expect(config).toEqual({
      namespace: "team",
      spaceRepo: "team/xtap-pool",
      rawBucket: "team/tweets",
      indexBucket: "team/tweets-index-bucket",
      allowedUsers: ["alice", "bob"],
      poolAdmins: ["bob"],
    });
  });

  it("preserves a custom legacy storage name during cutover", () => {
    const config = existingSpaceConfig(
      "alice",
      "team/xtap-pool",
      new Map([["DATASET_REPO", "archive/custom-pool-data"]]),
    );

    expect(config.rawBucket).toBe("archive/custom-pool-data");
  });

  it("uses sane update defaults when optional Space variables are missing", () => {
    const config = existingSpaceConfig("alice", "team/xtap-pool", new Map());

    expect(config).toEqual({
      namespace: "team",
      spaceRepo: "team/xtap-pool",
      rawBucket: "team/xtap-pool-data",
      indexBucket: "team/xtap-pool-bucket",
      allowedUsers: ["alice"],
      poolAdmins: ["alice"],
    });
  });

  it("rejects invalid existing Space and Bucket configuration", () => {
    expect(() => existingSpaceConfig("alice", "bad", new Map())).toThrow("owner/name");
    expect(() =>
      existingSpaceConfig("alice", "team/xtap-pool", new Map([["RAW_BUCKET", "bad"]])),
    ).toThrow("Invalid RAW_BUCKET");
    expect(() =>
      existingSpaceConfig("alice", "team/xtap-pool", new Map([["INDEX_BUCKET", "bad"]])),
    ).toThrow("Invalid INDEX_BUCKET");
  });

  it("validates repo ids and user lists", () => {
    expect(validateNamespace("dutifuldev")).toBeUndefined();
    expect(validateNamespace("bad namespace")).toContain("username or organization");
    expect(validateRepoId("alice/xtap-pool")).toBeUndefined();
    expect(validateRepoId("xtap-pool")).toContain("owner/name");
    expect(validateUserList("")).toContain("at least one");
    expect(validateUserList("alice,bob")).toBeUndefined();
    expect(validateUserList("alice, bad user")).toContain("comma-separated");
  });

  it("formats derived values", () => {
    expect(
      existingSpaceConfig("alice", "team/xtap-pool", new Map([["ALLOWED_USERS", ""]])).allowedUsers,
    ).toEqual(["alice"]);
    expect(repoInNamespace("alice", "pool")).toBe("alice/pool");
    expect(spacePublicUrl("alice/xtap-pool")).toBe("https://alice-xtap-pool.hf.space");
    expect(tokenSettingsUrl()).toContain("tokenType=fineGrained");
  });
});
