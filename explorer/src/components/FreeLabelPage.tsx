import { useEffect, useMemo, useState } from "react";

import type { FreeLabelDetail, Filters } from "../lib/api.js";
import { defaultFilters, fetchFreeLabel } from "../lib/api.js";
import { formatCount } from "../lib/format.js";
import { AppLink } from "./AppLink.js";
import { Feed } from "./Feed.js";

export type FreeLabelPageProps = {
  slug: string;
};

type FreeLabelPageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; label: FreeLabelDetail };

function FreeLabelHeader({ label }: { label: FreeLabelDetail }): React.JSX.Element {
  return (
    <header className="flex flex-col gap-2 border-b border-(--x-border) p-4">
      <AppLink href="/graph" className="text-sm text-(--x-muted)">
        ← Label graph
      </AppLink>
      <h2 className="text-lg font-bold">{label.name}</h2>
      <p className="text-sm text-(--x-muted)">{formatCount(label.post_count)} posts</p>
      {label.related.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {label.related.map((related) => (
            <AppLink
              key={related.name}
              href={`/graph/${related.name}`}
              className="x-chip"
              title={`${String(related.shared)} shared posts`}
            >
              {related.name}
            </AppLink>
          ))}
        </div>
      ) : null}
    </header>
  );
}

/** /graph/<slug>: one approved free label and its posts. */
export function FreeLabelPage({ slug }: FreeLabelPageProps): React.JSX.Element {
  const [state, setState] = useState<FreeLabelPageState>({ status: "loading" });
  const feedFilters = useMemo<Filters>(() => ({ ...defaultFilters, freeLabel: slug }), [slug]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void fetchFreeLabel(slug).then(
      (label) => {
        if (!cancelled) setState({ status: "ready", label });
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "failed to load";
        if (!cancelled) setState({ status: "error", message });
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [slug]);

  if (state.status === "loading") {
    return <p className="p-4 text-sm text-(--x-muted)">Loading…</p>;
  }
  if (state.status === "error") {
    return <p className="p-4 text-sm text-red-500">{state.message}</p>;
  }
  return (
    <section>
      <FreeLabelHeader label={state.label} />
      <Feed filters={feedFilters} />
    </section>
  );
}
