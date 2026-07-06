import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { captureCommand } from "../src/process.js";
import { collectUploadFiles, createSpaceStage, shouldUploadPath } from "../src/stage.js";

describe("space staging helpers", () => {
  it("excludes local-only roots from the Space upload", () => {
    expect(shouldUploadPath("package.json")).toBe(true);
    expect(shouldUploadPath("space/src/server.ts")).toBe(true);
    expect(shouldUploadPath("docs/implementation-plan.md")).toBe(false);
    expect(shouldUploadPath("extension/manifest.json")).toBe(false);
    expect(shouldUploadPath("setup/package.json")).toBe(true);
    expect(shouldUploadPath("setup/src/main.ts")).toBe(false);
  });

  it("collects upload files with portable paths", async () => {
    const root = join(tmpdir(), `xtap-pool-stage-${String(process.pid)}`);
    await mkdir(root, { recursive: true });
    try {
      await mkdir(join(root, "space"), { recursive: true });
      await writeFile(join(root, "package.json"), "{}");
      await writeFile(join(root, "space", "app.ts"), "export {};");
      const files = await collectUploadFiles(root);
      const names = files.map((file) => file.path).sort();
      expect(names).toEqual(["package.json", "space/app.ts"]);
      await expect(readFile(join(root, "package.json"), "utf8")).resolves.toBe("{}");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages the Space from the current git commit", async () => {
    const repo = join(tmpdir(), `xtap-pool-repo-${String(process.pid)}`);
    const stage = join(tmpdir(), `xtap-pool-space-${String(process.pid)}`);
    await mkdir(repo, { recursive: true });
    await mkdir(stage, { recursive: true });
    try {
      await captureCommand("git", ["init"], { cwd: repo });
      await mkdir(join(repo, "space"), { recursive: true });
      await mkdir(join(repo, "docs"), { recursive: true });
      await mkdir(join(repo, "extension"), { recursive: true });
      await mkdir(join(repo, "setup", "src"), { recursive: true });
      await writeFile(join(repo, "README.md"), "root readme");
      await writeFile(join(repo, "space", "hf-space-README.md"), "space readme");
      await writeFile(join(repo, "space", "server.ts"), "export {};");
      await writeFile(join(repo, "docs", "plan.md"), "internal");
      await writeFile(join(repo, "extension", "manifest.json"), "{}");
      await writeFile(join(repo, "setup", "package.json"), "{}");
      await writeFile(join(repo, "setup", "src", "main.ts"), "export {};");
      await captureCommand("git", ["add", "."], { cwd: repo });
      await captureCommand(
        "git",
        ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"],
        {
          cwd: repo,
        },
      );
      await writeFile(join(repo, "setup", "package.json"), '{"dirty":true}');

      await createSpaceStage(repo, stage);

      await expect(readFile(join(stage, "README.md"), "utf8")).resolves.toBe("space readme");
      await expect(readFile(join(stage, "space", "server.ts"), "utf8")).resolves.toBe("export {};");
      await expect(readFile(join(stage, "setup", "package.json"), "utf8")).resolves.toBe("{}");
      await expect(readdir(join(stage, "docs"))).rejects.toThrow();
      await expect(readdir(join(stage, "extension"))).rejects.toThrow();
      await expect(readdir(join(stage, "setup", "src"))).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(stage, { recursive: true, force: true });
    }
  });
});
