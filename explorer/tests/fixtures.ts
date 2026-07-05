import type { PooledTweet } from "@xtap-pool/shared";

export function pooledTweet(overrides: Record<string, unknown> = {}): PooledTweet {
  return {
    id: "100",
    url: "https://x.com/someone/status/100",
    text: "hello world",
    captured_at: "2026-05-21T03:04:35.954Z",
    created_at: "2026-05-20T10:00:00.000Z",
    author: { username: "someone", display_name: "Some One" },
    media: [],
    contributed_by: "osolmaz",
    pooled_at: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}
