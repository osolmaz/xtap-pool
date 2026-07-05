import type { ContributorStats, Filters } from "../lib/api.js";
import { formatCount } from "../lib/format.js";

export type FiltersPanelProps = {
  filters: Filters;
  contributors: readonly ContributorStats[];
  onChange: (filters: Filters) => void;
};

/** Left-rail filter controls: search, contributors, flags, date range. */
export function FiltersPanel({
  filters,
  contributors,
  onChange,
}: FiltersPanelProps): React.JSX.Element {
  const toggleContributor = (username: string): void => {
    const active = filters.contributors.includes(username);
    onChange({
      ...filters,
      contributors: active
        ? filters.contributors.filter((user) => user !== username)
        : [...filters.contributors, username],
    });
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <input
        type="search"
        value={filters.q}
        placeholder="Search tweets"
        aria-label="Search tweets"
        className="rounded-full border border-(--x-border) bg-(--x-soft) px-4 py-2 outline-none focus:border-(--x-accent)"
        onChange={(event) => {
          onChange({ ...filters, q: event.target.value });
        }}
      />

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 font-bold">Captured by</legend>
        {contributors.map((contributor) => (
          <label key={contributor.username} className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={filters.contributors.includes(contributor.username)}
              onChange={() => {
                toggleContributor(contributor.username);
              }}
            />
            <span>{contributor.username}</span>
            <span className="text-(--x-muted)">{formatCount(contributor.tweetCount)}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 font-bold">Only</legend>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={filters.hasMedia}
            onChange={() => {
              onChange({ ...filters, hasMedia: !filters.hasMedia });
            }}
          />
          <span>With media</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={filters.isArticle}
            onChange={() => {
              onChange({ ...filters, isArticle: !filters.isArticle });
            }}
          />
          <span>Articles</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={filters.dedup}
            onChange={() => {
              onChange({ ...filters, dedup: !filters.dedup });
            }}
          />
          <span>Collapse duplicates</span>
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-bold">Posted between</legend>
        <input
          type="date"
          value={filters.since}
          aria-label="From date"
          className="rounded-md border border-(--x-border) bg-(--x-soft) px-2 py-1"
          onChange={(event) => {
            onChange({ ...filters, since: event.target.value });
          }}
        />
        <input
          type="date"
          value={filters.until}
          aria-label="To date"
          className="rounded-md border border-(--x-border) bg-(--x-soft) px-2 py-1"
          onChange={(event) => {
            onChange({ ...filters, until: event.target.value });
          }}
        />
      </fieldset>
    </div>
  );
}
