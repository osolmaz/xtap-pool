import type { PooledTweet } from "@xtap-pool/shared";

export type TextSegment =
  { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

const TOKEN_PATTERN = /(https?:\/\/[^\s]+)|(@[A-Za-z0-9_]{1,15})|(#[\p{L}0-9_]+)/gu;

/** Split tweet text into plain and linkified segments (URLs, @mentions, #hashtags). */
export function tokenizeTweetText(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const index = match.index;
    if (index > last) segments.push({ kind: "text", text: text.slice(last, index) });
    const token = match[0];
    segments.push({ kind: "link", text: token, href: hrefForToken(token) });
    last = index + token.length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

function hrefForToken(token: string): string {
  if (token.startsWith("@")) return `https://x.com/${token.slice(1)}`;
  if (token.startsWith("#")) return `https://x.com/hashtag/${token.slice(1)}`;
  return token;
}

/** X-style compact counts: 999, 1.2K, 3.4M. */
export function formatCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${trimZero((count / 1000).toFixed(1))}K`;
  return `${trimZero((count / 1_000_000).toFixed(1))}M`;
}

function trimZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function relativeLabel(ageMs: number): string | undefined {
  if (ageMs < 0) return undefined;
  if (ageMs < 60_000) return "now";
  if (ageMs < 3_600_000) return `${String(Math.floor(ageMs / 60_000))}m`;
  if (ageMs < 86_400_000) return `${String(Math.floor(ageMs / 3_600_000))}h`;
  return undefined;
}

/** X-style timestamps: "now", "5m", "3h", then "May 21" / "May 21, 2024". */
export function formatTweetDate(iso: string, now: Date): string {
  const date = new Date(iso);
  const relative = relativeLabel(now.getTime() - date.getTime());
  if (relative !== undefined) return relative;
  const month = MONTHS[date.getUTCMonth()] ?? "";
  const label = `${month} ${String(date.getUTCDate())}`;
  return date.getUTCFullYear() === now.getUTCFullYear()
    ? label
    : `${label}, ${String(date.getUTCFullYear())}`;
}

export type PhotoMedia = { url: string; alt: string };

function toPhoto(entry: unknown): PhotoMedia | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const item = entry as Record<string, unknown>;
  if (item["type"] !== "photo" || typeof item["url"] !== "string") return undefined;
  return {
    url: item["url"],
    alt: typeof item["alt_text"] === "string" ? item["alt_text"] : "Tweet image",
  };
}

/** Up to four photo entries from a tweet's media list. */
export function photoMedia(tweet: PooledTweet): PhotoMedia[] {
  const media = tweet["media"];
  if (!Array.isArray(media)) return [];
  return media
    .map(toPhoto)
    .filter((photo): photo is PhotoMedia => photo !== undefined)
    .slice(0, 4);
}

export type TweetMetrics = { replies: number; retweets: number; likes: number; views: number };

/** Numeric engagement metrics with zero defaults. */
export function tweetMetrics(tweet: PooledTweet): TweetMetrics {
  const metrics = tweet["metrics"];
  const source =
    typeof metrics === "object" && metrics !== null ? (metrics as Record<string, unknown>) : {};
  const num = (key: string): number => (typeof source[key] === "number" ? source[key] : 0);
  return {
    replies: num("replies"),
    retweets: num("retweets"),
    likes: num("likes"),
    views: num("views"),
  };
}

/** Deterministic avatar background color per username. */
export function avatarColor(username: string): string {
  let hash = 0;
  for (const char of username) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return `hsl(${String(hash)} 55% 45%)`;
}

export function displayName(tweet: PooledTweet): string {
  const name = tweet.author.display_name;
  return name === undefined || name === "" ? tweet.author.username : name;
}

export function isArticleTweet(tweet: PooledTweet): boolean {
  return tweet["is_article"] === true;
}

export function isRetweet(tweet: PooledTweet): boolean {
  return tweet["is_retweet"] === true;
}

export function quotedTweetUrl(tweet: PooledTweet): string | undefined {
  const id = tweet["quoted_tweet_id"];
  return typeof id === "string" && id.length > 0 ? `https://x.com/i/status/${id}` : undefined;
}
