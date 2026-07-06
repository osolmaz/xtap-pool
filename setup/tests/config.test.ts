import { describe, expect, it } from "vitest";

import {
  defaultSetupConfig,
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
      datasetRepo: "alice/xtap-pool-data",
      allowedUsers: ["alice"],
    });
  });

  it("normalizes comma-separated allowlists", () => {
    expect(normalizeUsers("alice, bob,alice,, carol ")).toEqual(["alice", "bob", "carol"]);
    expect(usersValue(["alice", "bob"])).toBe("alice,bob");
  });

  it("validates repo ids and user lists", () => {
    expect(validateNamespace("dutifuldev")).toBeUndefined();
    expect(validateNamespace("bad namespace")).toContain("username or organization");
    expect(validateRepoId("alice/xtap-pool")).toBeUndefined();
    expect(validateRepoId("xtap-pool")).toContain("owner/name");
    expect(validateUserList("alice,bob")).toBeUndefined();
    expect(validateUserList("alice, bad user")).toContain("comma-separated");
  });

  it("formats derived values", () => {
    expect(repoInNamespace("alice", "pool")).toBe("alice/pool");
    expect(spacePublicUrl("alice/xtap-pool")).toBe("https://alice-xtap-pool.hf.space");
    expect(tokenSettingsUrl()).toContain("tokenType=fineGrained");
  });
});
