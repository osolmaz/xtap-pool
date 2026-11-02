import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultOutboxDir,
  runPushOutbox,
  summarizePush,
  verifiedUsername,
} from "../src/push-outbox.js";

let outboxDir: string;

beforeEach(() => {
  outboxDir = mkdtempSync(join(tmpdir(), "xtap-pool-push-"));
});

afterEach(() => {
  rmSync(outboxDir, { recursive: true, force: true });
});

function whoami(name: string | undefined, status = 200): { fetchFn: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const fetchFn: typeof fetch = (_input, init) => {
    const headers = new Headers(init?.headers);
    seen.push(headers.get("authorization") ?? "");
    return Promise.resolve(Response.json(name === undefined ? {} : { name }, { status }));
  };
  return { fetchFn, seen };
}

describe("verifiedUsername", () => {
  it("returns the token owner", async () => {
    const { fetchFn, seen } = whoami("osolmaz");
    await expect(verifiedUsername("hf_secret", fetchFn)).resolves.toBe("osolmaz");
    expect(seen).toEqual(["Bearer hf_secret"]);
  });

  it("fails on a rejected token or a response without a username", async () => {
    await expect(verifiedUsername("hf_x", whoami("osolmaz", 401).fetchFn)).rejects.toThrow(
      "Hugging Face rejected the token (401)",
    );
    await expect(verifiedUsername("hf_x", whoami(undefined).fetchFn)).rejects.toThrow(
      "no username",
    );
  });
});

describe("runPushOutbox", () => {
  it("uses HF_TOKEN before the local token file", async () => {
    const { fetchFn, seen } = whoami("osolmaz");
    const result = await runPushOutbox(
      { RAW_BUCKET: "osolmaz/xtap-pool-data", XTAP_POOL_OUTBOX_DIR: outboxDir, HF_TOKEN: "hf_env" },
      {
        fetchFn,
        readToken: () => {
          throw new Error("token file must not be read");
        },
      },
    );
    expect(seen).toEqual(["Bearer hf_env"]);
    expect(result).toEqual({ files: [], ignored: [] });
  });

  it("reads the local Hugging Face token file in place", async () => {
    const { fetchFn, seen } = whoami("osolmaz");
    const paths: string[] = [];
    await runPushOutbox(
      { RAW_BUCKET: "osolmaz/xtap-pool-data", XTAP_POOL_OUTBOX_DIR: outboxDir, HF_HOME: "/hf" },
      {
        fetchFn,
        readToken: (path) => {
          paths.push(path);
          return "hf_file\n";
        },
      },
    );
    expect(paths).toEqual(["/hf/token"]);
    expect(seen).toEqual(["Bearer hf_file"]);
  });

  it("fails without a token or a raw Bucket", async () => {
    await expect(
      runPushOutbox(
        { RAW_BUCKET: "osolmaz/xtap-pool-data", XTAP_POOL_OUTBOX_DIR: outboxDir },
        { fetchFn: whoami("osolmaz").fetchFn, readToken: () => "  " },
      ),
    ).rejects.toThrow("no Hugging Face token");
    await expect(runPushOutbox({ HF_TOKEN: "hf_x" })).rejects.toThrow();
  });
});

describe("push summary", () => {
  it("counts files, uploads, rejections and ignored entries", () => {
    expect(defaultOutboxDir()).toBe(join(homedir(), ".xtap", "pool-outbox"));
    expect(
      summarizePush({
        files: [
          { name: "a", uploaded: 3, rejected: 1, segment: "k" },
          { name: "b", uploaded: 2, rejected: 0, segment: "k2" },
        ],
        ignored: ["x.tmp"],
      }),
    ).toBe("2 files, 5 observations uploaded, 1 rejected, 1 other files ignored");
    expect(summarizePush({ files: [], ignored: [] })).toBe(
      "0 files, 0 observations uploaded, 0 rejected",
    );
  });
});
