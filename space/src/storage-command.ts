import { resolve } from "node:path";

import { BucketLog, createRawBucketClient } from "./bucket-log.js";
import { importPinnedDataset, verifyPinnedDataset } from "./storage-migration.js";

type Command = "import" | "verify";
type Arguments = {
  dataset: string;
  revision: string;
  rawBucket: string;
  report: string;
  workDir: string;
};

export async function runStorageCommand(command: Command, argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv);
  const token = process.env["HF_TOKEN"];
  if (token === undefined || token.length === 0) throw new Error("HF_TOKEN is required");
  const log = new BucketLog(
    args.rawBucket,
    createRawBucketClient(args.rawBucket, token),
    resolve(args.workDir, "raw-cache"),
  );
  const options = {
    dataset: args.dataset,
    revision: args.revision,
    log,
    reportPath: resolve(args.report),
  };
  const report =
    command === "import" ? await importPinnedDataset(options) : await verifyPinnedDataset(options);
  console.log(
    JSON.stringify({
      ok: true,
      source_revision: report.source.revision,
      snapshot_revision: report.target.snapshot_revision,
      source_objects: report.source.objects,
      target_objects: report.target.objects,
      rows: report.reconciliation.rows,
      report: resolve(args.report),
    }),
  );
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("expected --dataset, --revision, --raw-bucket, --report, and --work-dir");
    }
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.length === 0) throw new Error(`${key} is required`);
    return value;
  };
  return {
    dataset: required("--dataset"),
    revision: required("--revision"),
    rawBucket: required("--raw-bucket"),
    report: required("--report"),
    workDir: required("--work-dir"),
  };
}
