import { validateRepoId } from "./config.js";

export type SetupCommand =
  | { kind: "setup" }
  | { kind: "update"; spaceRepo?: string; cutoverReport?: string }
  | {
      kind: "doctor";
      spaceRepo?: string;
      json: boolean;
      fix: boolean;
      canary: boolean;
      resumeCanaryJobId?: string;
      approvedCostCeilingUsd?: number;
      enableSchedule: boolean;
    };

export function parseSetupCommand(argv: readonly string[]): SetupCommand {
  if (argv.length === 0) return { kind: "setup" };
  const [command, ...args] = argv;
  if (command === "update") return parseUpdate(args);
  if (command === "doctor") return parseDoctor(args);
  throw new Error(`Unknown command: ${command ?? ""}. Use setup, update, or doctor.`);
}

// eslint-disable-next-line complexity -- Update parsing validates the optional proof-bearing cutover flag at the CLI boundary.
function parseUpdate(args: readonly string[]): SetupCommand {
  const reportFlag = args.find((arg) => arg.startsWith("--verified-bucket-cutover="));
  const cutoverReport = reportFlag?.slice("--verified-bucket-cutover=".length);
  if (reportFlag !== undefined && cutoverReport?.length === 0) {
    throw new Error("--verified-bucket-cutover requires an import report path.");
  }
  const positional = args.filter((arg) => arg !== reportFlag);
  const [maybeSpaceRepo, ...extra] = positional;
  if (extra.length > 0 || args.some((arg) => arg.startsWith("--") && arg !== reportFlag)) {
    throw new Error(
      "Usage: npm run update -- [owner/xtap-pool] [--verified-bucket-cutover=<import-report>]",
    );
  }
  if (maybeSpaceRepo === undefined) {
    return { kind: "update", ...(cutoverReport === undefined ? {} : { cutoverReport }) };
  }
  const error = validateRepoId(maybeSpaceRepo);
  if (error !== undefined) throw new Error(error);
  return {
    kind: "update",
    spaceRepo: maybeSpaceRepo,
    ...(cutoverReport === undefined ? {} : { cutoverReport }),
  };
}

// eslint-disable-next-line complexity -- One small parser rejects conflicting repair/canary activation flags at the CLI boundary.
function parseDoctor(args: readonly string[]): SetupCommand {
  let spaceRepo: string | undefined;
  let json = false;
  let fix = false;
  let canary = false;
  let resumeCanaryJobId: string | undefined;
  let approvedCostCeilingUsd: number | undefined;
  let enableSchedule = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--fix") fix = true;
    else if (arg === "--canary") canary = true;
    else if (arg.startsWith("--resume-canary-job=")) {
      const value = arg.slice("--resume-canary-job=".length);
      if (!/^[a-zA-Z0-9._-]+$/u.test(value)) throw new Error("Invalid canary Job ID.");
      resumeCanaryJobId = value;
    } else if (arg.startsWith("--approved-cost-ceiling-usd=")) {
      const value = Number(arg.slice("--approved-cost-ceiling-usd=".length));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--approved-cost-ceiling-usd requires a positive number.");
      }
      approvedCostCeilingUsd = value;
    } else if (arg === "--enable-schedule") enableSchedule = true;
    else if (spaceRepo === undefined) spaceRepo = arg;
    else {
      throw new Error(
        "Usage: npm run doctor -- [owner/xtap-pool] [--json] [--fix] [--canary] [--resume-canary-job=<id>] [--approved-cost-ceiling-usd=<usd>] [--enable-schedule]",
      );
    }
  }
  if (
    (enableSchedule || resumeCanaryJobId !== undefined || approvedCostCeilingUsd !== undefined) &&
    !canary
  ) {
    throw new Error(
      "--enable-schedule, --resume-canary-job, and --approved-cost-ceiling-usd require --canary.",
    );
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
    ...(resumeCanaryJobId === undefined ? {} : { resumeCanaryJobId }),
    ...(approvedCostCeilingUsd === undefined ? {} : { approvedCostCeilingUsd }),
    enableSchedule,
  };
}
