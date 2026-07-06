import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findProjectRoot } from "../src/root.js";

describe("project root discovery", () => {
  it("walks up from source or dist paths to the repo root", async () => {
    const root = join(tmpdir(), `xtap-pool-root-${String(process.pid)}`);
    try {
      await mkdir(join(root, "setup", "dist", "src"), { recursive: true });
      await mkdir(join(root, "space"), { recursive: true });
      await writeFile(join(root, "package.json"), "{}");
      await writeFile(join(root, "space", "hf-space-README.md"), "space");

      expect(findProjectRoot(join(root, "setup", "src"))).toBe(root);
      expect(findProjectRoot(join(root, "setup", "dist", "src"))).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws when no project marker exists", () => {
    expect(() => findProjectRoot(tmpdir())).toThrow("Could not find xtap-pool project root.");
  });
});
