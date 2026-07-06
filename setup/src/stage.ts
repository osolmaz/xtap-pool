import { Blob } from "node:buffer";
import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";

import { captureCommand, inheritCommand } from "./process.js";

export type UploadFile = {
  path: string;
  content: Blob;
};

const SPACE_EXCLUDED_ROOTS = new Set(["docs", "extension", "setup"]);
const SPACE_ALLOWED_FILES = new Set(["setup/package.json"]);

export async function createSpaceStage(root: string, stageDir: string): Promise<void> {
  const archivePath = join(stageDir, "repo.tar");
  await captureCommand("git", ["-C", root, "archive", "--format=tar", "-o", archivePath, "HEAD"]);
  await inheritCommand("tar", ["-xf", archivePath, "-C", stageDir]);
  await fs.rm(archivePath, { force: true });
  const setupPackageJson = await fs.readFile(join(stageDir, "setup", "package.json"));
  await fs.copyFile(join(root, "space", "hf-space-README.md"), join(stageDir, "README.md"));
  await Promise.all(
    [...SPACE_EXCLUDED_ROOTS].map((name) =>
      fs.rm(join(stageDir, name), { recursive: true, force: true }),
    ),
  );
  await fs.mkdir(join(stageDir, "setup"), { recursive: true });
  await fs.writeFile(join(stageDir, "setup", "package.json"), setupPackageJson);
}

export async function collectUploadFiles(root: string): Promise<readonly UploadFile[]> {
  const files = await listFiles(root, root);
  return Promise.all(
    files.filter(shouldUploadPath).map(async (path) => ({
      path,
      content: new Blob([await fs.readFile(join(root, path))]),
    })),
  );
}

export function shouldUploadPath(path: string): boolean {
  if (SPACE_ALLOWED_FILES.has(path)) return true;
  const [first] = path.split("/");
  return first !== undefined && !SPACE_EXCLUDED_ROOTS.has(first) && first !== ".git";
}

async function listFiles(root: string, current: string): Promise<readonly string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => listEntry(root, current, entry)));
  return nested.flat();
}

async function listEntry(
  root: string,
  current: string,
  entry: { name: string; isDirectory: () => boolean },
): Promise<readonly string[]> {
  const absolute = join(current, entry.name);
  if (entry.isDirectory()) return listFiles(root, absolute);
  return [relative(root, absolute).split(sep).join("/")];
}
