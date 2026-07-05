import type { PooledTweet } from "@xtap-pool/shared";

import {
  avatarColor,
  displayName,
  formatCount,
  formatTweetDate,
  isArticleTweet,
  isRetweet,
  photoMedia,
  quotedTweetUrl,
  tokenizeTweetText,
  tweetMetrics,
} from "../lib/format.js";

export type TweetCardProps = {
  tweet: PooledTweet;
  contributors: readonly string[];
  now: Date;
};

function TweetText({ text }: { text: string }): React.JSX.Element {
  const segments = tokenizeTweetText(text);
  return (
    <div className="x-tweet-card__text">
      {segments.map((segment, index) =>
        segment.kind === "link" ? (
          <a key={index} href={segment.href} target="_blank" rel="noopener noreferrer">
            {segment.text}
          </a>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </div>
  );
}

function TweetMedia({ tweet }: { tweet: PooledTweet }): React.JSX.Element | null {
  const photos = photoMedia(tweet);
  if (photos.length === 0) return null;
  return (
    <div className={`x-tweet-card__media x-tweet-card__media--count-${String(photos.length)}`}>
      {photos.map((photo) => (
        <a
          key={photo.url}
          className="x-tweet-card__media-link"
          href={photo.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <img
            className="x-tweet-card__media-image"
            src={photo.url}
            alt={photo.alt}
            loading="lazy"
          />
        </a>
      ))}
    </div>
  );
}

function Metrics({ tweet }: { tweet: PooledTweet }): React.JSX.Element {
  const metrics = tweetMetrics(tweet);
  const entries: [string, number][] = [
    ["replies", metrics.replies],
    ["reposts", metrics.retweets],
    ["likes", metrics.likes],
    ["views", metrics.views],
  ];
  return (
    <div className="x-tweet-card__metrics">
      {entries.map(([label, value]) => (
        <span key={label} className="x-tweet-card__metric" title={label}>
          <span>{formatCount(value)}</span> {label}
        </span>
      ))}
    </div>
  );
}

/** One tweet, rendered in the solmaz.io X-card style. */
export function TweetCard({ tweet, contributors, now }: TweetCardProps): React.JSX.Element {
  const name = displayName(tweet);
  const quoted = quotedTweetUrl(tweet);
  return (
    <article className="x-tweet-card">
      <div
        className="x-tweet-card__avatar"
        style={{ background: avatarColor(tweet.author.username) }}
      >
        {name.slice(0, 1).toUpperCase()}
      </div>
      <div className="x-tweet-card__main">
        <div className="x-tweet-card__identity">
          <span className="x-tweet-card__name">{name}</span>
          <span className="x-tweet-card__handle">@{tweet.author.username}</span>
          <span className="x-tweet-card__dot">&middot;</span>
          <time dateTime={tweet.created_at ?? tweet.captured_at}>
            {formatTweetDate(tweet.created_at ?? tweet.captured_at, now)}
          </time>
          <a
            className="x-tweet-card__view-link"
            href={tweet.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            View on X
          </a>
        </div>
        {isRetweet(tweet) ? <div className="x-tweet-card__handle">reposted</div> : null}
        <TweetText text={tweet.text} />
        <TweetMedia tweet={tweet} />
        {quoted === undefined ? null : (
          <a className="x-quote-card" href={quoted} target="_blank" rel="noopener noreferrer">
            View quoted post on X
          </a>
        )}
        <Metrics tweet={tweet} />
        <div className="x-tweet-card__contributors">
          {isArticleTweet(tweet) ? <span className="x-chip x-chip--article">article</span> : null}
          {contributors.map((contributor) => (
            <span key={contributor} className="x-chip" title={`captured by ${contributor}`}>
              ⛏ {contributor}
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}
