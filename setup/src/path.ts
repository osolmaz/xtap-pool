import { homedir } from "node:os";
import { join } from "node:path";

export function defaultTweetsDirectory(home = homedir()): string {
  return join(home, "Downloads/xtap");
}

export function expandHomePath(value: string, home = homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}
