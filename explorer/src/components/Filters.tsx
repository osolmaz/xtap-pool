import type { ContributorStats, Filters, LabelStat } from "../lib/api.js";
import { formatCount } from "../lib/format.js";

/** Minimal concept shape the picker needs (any vocabulary entry fits). */
export type ConceptOption = {
  slug: string;
  name: string;
};

export type FiltersPanelProps = {
  filters: Filters;
  contributors: readonly ContributorStats[];
  labels: readonly LabelStat[];
  concepts: readonly ConceptOption[];
  onChange: (filters: Filters) => void;
};

function labelChipClass(active: boolean): string {
  return ["x-chip", active ? "x-chip--active" : ""].filter(Boolean).join(" ");
}

type LabelChipsProps = {
  filters: Filters;
  labels: readonly LabelStat[];
  onChange: (filters: Filters) => void;
};

/** Preset-label toggle chips; selected labels go out as labels=<csv>. */
function LabelChips({ filters, labels, onChange }: LabelChipsProps): React.JSX.Element {
  const toggleLabel = (name: string): void => {
    const active = filters.labels.includes(name);
    onChange({
      ...filters,
      labels: active ? filters.labels.filter((label) => label !== name) : [...filters.labels, name],
    });
  };

  return (
    <fieldset>
      <legend className="mb-1 font-bold">Labels</legend>
      <div className="flex flex-wrap gap-1.5">
        {labels.map((label) => (
          <button
            key={label.name}
            type="button"
            aria-pressed={filters.labels.includes(label.name)}
            title={label.description}
            className={labelChipClass(filters.labels.includes(label.name))}
            onClick={() => {
              toggleLabel(label.name);
            }}
          >
            {label.name} <span>{formatCount(label.count)}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

type ConceptSelectProps = {
  filters: Filters;
  concepts: readonly ConceptOption[];
  onChange: (filters: Filters) => void;
};

/** Concept picker; the selection goes out as concept=<slug>. */
function ConceptSelect({ filters, concepts, onChange }: ConceptSelectProps): React.JSX.Element {
  const sorted = [...concepts].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 font-bold">Concept</legend>
      <select
        aria-label="Concept"
        value={filters.concept}
        className="rounded-md border border-(--x-border) bg-(--x-soft) px-2 py-1"
        onChange={(event) => {
          onChange({ ...filters, concept: event.target.value });
        }}
      >
        <option value="">Any concept</option>
        {sorted.map((concept) => (
          <option key={concept.slug} value={concept.slug}>
            {concept.name}
          </option>
        ))}
      </select>
    </fieldset>
  );
}

/** Left-rail filter controls: search, labels, concept, contributors, flags, dates. */
export function FiltersPanel({
  filters,
  contributors,
  labels,
  concepts,
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

      {labels.length > 0 ? (
        <LabelChips filters={filters} labels={labels} onChange={onChange} />
      ) : null}

      {concepts.length > 0 ? (
        <ConceptSelect filters={filters} concepts={concepts} onChange={onChange} />
      ) : null}

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
