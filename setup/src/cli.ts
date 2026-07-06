import { validateRepoId } from "./config.js";

export type SetupCommand = { kind: "setup" } | { kind: "update"; spaceRepo?: string };

export function parseSetupCommand(argv: readonly string[]): SetupCommand {
  if (argv.length === 0) return { kind: "setup" };
  const [command, maybeSpaceRepo, ...extra] = argv;
  if (command !== "update") {
    throw new Error(`Unknown command: ${command ?? ""}. Use no arguments or "update".`);
  }
  if (extra.length > 0) throw new Error("Usage: npm run update -- [owner/xtap-pool]");
  if (maybeSpaceRepo === undefined) return { kind: "update" };
  const error = validateRepoId(maybeSpaceRepo);
  if (error !== undefined) throw new Error(error);
  return { kind: "update", spaceRepo: maybeSpaceRepo };
}
