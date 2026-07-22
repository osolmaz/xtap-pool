import type { PooledTweet, Tweet } from "@xtap-pool/shared";

import type { SpaceConfig } from "../src/config.js";
import type { HubClient } from "../src/dataset.js";

export const testConfig: SpaceConfig = {
  port: 7860,
  dataDir: ".data-test",
  datasetRepo: "osolmaz/xtap-pool-data",
  hfToken: "hf_test_token",
  poolSigningSecret: "pool-secret-0123456789abcdef0123456789abcdef",
  sessionSecret: "session-secret-0123456789abcdef0123456789ab",
  allowedUsers: ["osolmaz", "alice"],
  poolAdmins: ["osolmaz"],
  oauthClientId: "client-id",
  oauthClientSecret: "client-secret",
  openidProviderUrl: "https://huggingface.co",
  publicUrl: "https://dutifuldev-xtap-pool.hf.space",
  staticRoot: "../explorer/dist",
};

export function makeTweet(overrides: Record<string, unknown> = {}): Tweet {
  return {
    id: "100",
    url: "https://x.com/someone/status/100",
    text: "hello world",
    captured_at: "2026-05-21T03:04:35.954Z",
    created_at: "2026-05-20T10:00:00.000Z",
    author: { username: "someone", display_name: "Some One" },
    media: [],
    ...overrides,
  };
}

export function makePooled(overrides: Record<string, unknown> = {}): PooledTweet {
  return {
    ...makeTweet(),
    contributed_by: "osolmaz",
    pooled_at: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}

/** In-memory fake of the HF Hub used by mirror/ingest tests. */
export class FakeHub implements HubClient {
  files = new Map<string, string>();
  commits: { paths: string[]; title: string }[] = [];
  failNextCommit = false;

  listDataFiles(): Promise<string[]> {
    return Promise.resolve(
      [...this.files.keys()].filter((path) => path.startsWith("data/") && path.endsWith(".jsonl")),
    );
  }

  downloadFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) return Promise.reject(new Error(`missing: ${path}`));
    return Promise.resolve(content);
  }

  commitFiles(files: readonly { path: string; content: string }[], title: string): Promise<void> {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      return Promise.reject(new Error("hub unavailable"));
    }
    for (const file of files) this.files.set(file.path, file.content);
    this.commits.push({ paths: files.map((file) => file.path), title });
    return Promise.resolve();
  }
}
