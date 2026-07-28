import { validateRepoId } from "./config.js";

export type SetupCommand =
  | { kind: "setup" }
  | { kind: "update"; spaceRepo?: string }
  | {
      kind: "doctor";
      spaceRepo?: string;
      json: boolean;
      fix: boolean;
      canary: boolean;
      enableSchedule: boolean;
    };

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

// eslint-disable-next-line complexity -- One small parser rejects conflicting repair/canary activation flags at the CLI boundary.
function parseDoctor(args: readonly string[]): SetupCommand {
  let spaceRepo: string | undefined;
  let json = false;
  let fix = false;
  let canary = false;
  let enableSchedule = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--fix") fix = true;
    else if (arg === "--canary") canary = true;
    else if (arg === "--enable-schedule") enableSchedule = true;
    else if (spaceRepo === undefined) spaceRepo = arg;
    else {
      throw new Error(
        "Usage: npm run doctor -- [owner/xtap-pool] [--json] [--fix] [--canary] [--enable-schedule]",
      );
    }
  }
  if (enableSchedule && !canary) {
    throw new Error("--enable-schedule requires --canary in the same repair run.");
  }
  if (spaceRepo !== undefined) {
    const error = validateRepoId(spaceRepo);
    if (error !== undefined) throw new Error(error);
  }
  return {
    kind: "doctor",
    ...(spaceRepo === undefined ? {} : { spaceRepo }),
    json,
    fix,
    canary,
    enableSchedule,
  };
}
