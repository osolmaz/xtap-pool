import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function findProjectRoot(start: string): string {
  let current = start;
  for (;;) {
    if (isProjectRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("Could not find xtap-pool project root.");
    current = parent;
  }
}

function isProjectRoot(path: string): boolean {
  return (
    existsSync(join(path, "package.json")) && existsSync(join(path, "space", "hf-space-README.md"))
  );
}
