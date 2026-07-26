import { validateRepoId } from "./config.js";

export type SetupCommand =
  | { kind: "setup" }
  | { kind: "update"; spaceRepo?: string }
  | { kind: "doctor"; spaceRepo?: string; json: boolean; fix: boolean };

export function parseSetupCommand(argv: readonly string[]): SetupCommand {
  if (argv.length === 0) return { kind: "setup" };
  const [command, ...args] = argv;
  if (command === "update") return parseUpdate(args);
  if (command === "doctor") return parseDoctor(args);
  throw new Error(`Unknown command: ${command ?? ""}. Use setup, update, or doctor.`);
}

function parseUpdate(args: readonly string[]): SetupCommand {
  const [maybeSpaceRepo, ...extra] = args;
  if (extra.length > 0) throw new Error("Usage: npm run update -- [owner/xtap-pool]");
  if (maybeSpaceRepo === undefined) return { kind: "update" };
  const error = validateRepoId(maybeSpaceRepo);
  if (error !== undefined) throw new Error(error);
  return { kind: "update", spaceRepo: maybeSpaceRepo };
}

function parseDoctor(args: readonly string[]): SetupCommand {
  let spaceRepo: string | undefined;
  let json = false;
  let fix = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--fix") fix = true;
    else if (spaceRepo === undefined) spaceRepo = arg;
    else throw new Error("Usage: npm run doctor -- [owner/xtap-pool] [--json] [--fix]");
  }
  if (spaceRepo !== undefined) {
    const error = validateRepoId(spaceRepo);
    if (error !== undefined) throw new Error(error);
  }
  return { kind: "doctor", ...(spaceRepo === undefined ? {} : { spaceRepo }), json, fix };
}
