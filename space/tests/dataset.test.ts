import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatasetMirror, parseJsonlTweets } from "../src/dataset.js";
import { TweetStore } from "../src/store.js";
import { FakeHub, makePooled, makeTweet } from "./helpers.js";

let dir: string;
let hub: FakeHub;
let mirror: DatasetMirror;
let store: TweetStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xtap-pool-test-"));
  hub = new FakeHub();
  mirror = new DatasetMirror(hub, dir);
  store = new TweetStore();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("parseJsonlTweets", () => {
  it("parses stamped lines as-is", () => {
    const pooled = makePooled();
    const tweets = parseJsonlTweets(`${JSON.stringify(pooled)}\n`, "data/osolmaz/x.jsonl");
    expect(tweets).toHaveLength(1);
    expect(tweets[0]?.contributed_by).toBe("osolmaz");
    expect(tweets[0]?.pooled_at).toBe(pooled.pooled_at);
  });

  it("infers attribution for legacy xTap lines from the path", () => {
    const legacy = makeTweet();
    const tweets = parseJsonlTweets(
      `${JSON.stringify(legacy)}\n`,
      "data/osolmaz/2026/05/tweets-2026-05-21.jsonl",
    );
    expect(tweets[0]?.contributed_by).toBe("osolmaz");
    expect(tweets[0]?.pooled_at).toBe(legacy.captured_at);
  });

  it("skips blank, unparsable and invalid lines", () => {
    const content = ["", "not json", JSON.stringify({ id: "1" }), JSON.stringify(makeTweet())]
      .join("\n")
      .concat("\n");
    expect(parseJsonlTweets(content, "data/u/x.jsonl")).toHaveLength(1);
  });
});

describe("DatasetMirror.rebuild", () => {
  it("downloads all files, fills the store and writes the mirror", async () => {
    hub.files.set(
      "data/osolmaz/2026/05/tweets-2026-05-21.jsonl",
      `${JSON.stringify(makePooled({ id: "1" }))}\n${JSON.stringify(makePooled({ id: "2" }))}\n`,
    );
    hub.files.set(
      "data/alice/2026/05/tweets-2026-05-21.jsonl",
      `${JSON.stringify(makePooled({ id: "3", contributed_by: "alice" }))}\n`,
    );
    const result = await mirror.rebuild(store);
    expect(result).toEqual({ files: 2, tweets: 3 });
    expect(store.count()).toBe(3);
    expect(existsSync(join(dir, "data/alice/2026/05/tweets-2026-05-21.jsonl"))).toBe(true);
  });
});

describe("DatasetMirror.appendAndCommit", () => {
  it("appends to per-day files and commits before touching the mirror", async () => {
    const tweetA = makePooled({ id: "1", captured_at: "2026-05-21T10:00:00.000Z" });
    const tweetB = makePooled({ id: "2", captured_at: "2026-05-22T10:00:00.000Z" });
    await mirror.appendAndCommit([tweetA, tweetB], "pool: osolmaz +2 tweets");
    expect(hub.commits).toHaveLength(1);
    expect(hub.commits[0]?.paths.sort()).toEqual([
      "data/osolmaz/2026/05/tweets-2026-05-21.jsonl",
      "data/osolmaz/2026/05/tweets-2026-05-22.jsonl",
    ]);
    const local = readFileSync(join(dir, "data/osolmaz/2026/05/tweets-2026-05-21.jsonl"), "utf8");
    expect(local).toBe(`${JSON.stringify(tweetA)}\n`);
  });

  it("appends to existing day files without losing prior lines", async () => {
    const first = makePooled({ id: "1" });
    const second = makePooled({ id: "2" });
    await mirror.appendAndCommit([first], "one");
    await mirror.appendAndCommit([second], "two");
    const path = "data/osolmaz/2026/05/tweets-2026-05-21.jsonl";
    expect(hub.files.get(path)).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
  });

  it("leaves the mirror untouched when the hub commit fails", async () => {
    hub.failNextCommit = true;
    const tweet = makePooled();
    await expect(mirror.appendAndCommit([tweet], "boom")).rejects.toThrow("hub unavailable");
    expect(existsSync(join(dir, "data/osolmaz/2026/05/tweets-2026-05-21.jsonl"))).toBe(false);
    await mirror.appendAndCommit([tweet], "retry");
    expect(hub.files.get("data/osolmaz/2026/05/tweets-2026-05-21.jsonl")).toBe(
      `${JSON.stringify(tweet)}\n`,
    );
  });

  it("refuses dataset paths that escape the mirror root", async () => {
    const evil = makePooled({ contributed_by: "../../etc" });
    await expect(mirror.appendAndCommit([evil], "evil")).rejects.toThrow("escapes mirror root");
  });

  it("refuses sibling escapes that share the mirror root's name prefix", async () => {
    const sibling = new DatasetMirror(hub, join(dir, "mirror"));
    const evil = makePooled({ contributed_by: "../../mirror-evil" });
    await expect(sibling.appendAndCommit([evil], "evil")).rejects.toThrow("escapes mirror root");
  });
});
