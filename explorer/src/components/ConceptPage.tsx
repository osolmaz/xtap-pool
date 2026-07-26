import { useEffect, useMemo, useState } from "react";

import type { ConceptDetail, Filters } from "../lib/api.js";
import { defaultFilters, fetchConcept } from "../lib/api.js";
import { formatCount } from "../lib/format.js";
import { AppLink } from "./AppLink.js";
import { Feed } from "./Feed.js";

export type ConceptPageProps = {
  slug: string;
};

type ConceptPageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; concept: ConceptDetail };

function ConceptHeader({ concept }: { concept: ConceptDetail }): React.JSX.Element {
  return (
    <header className="flex flex-col gap-2 border-b border-(--x-border) p-4">
      <AppLink href="/graph" className="text-sm text-(--x-muted)">
        ← Concept graph
      </AppLink>
      <h2 className="text-lg font-bold">{concept.name}</h2>
      <p className="text-sm text-(--x-muted)">{formatCount(concept.post_count)} posts</p>
      {concept.aliases.length > 0 ? (
        <p className="text-sm text-(--x-muted)">
          Also referred to as: {concept.aliases.join(", ")}
        </p>
      ) : null}
      {concept.related.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {concept.related.map((related) => (
            <AppLink
              key={related.slug}
              href={`/graph/${related.slug}`}
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

/** /graph/<slug>: one concept — name, aliases, related chips, and its posts. */
export function ConceptPage({ slug }: ConceptPageProps): React.JSX.Element {
  const [state, setState] = useState<ConceptPageState>({ status: "loading" });
  const feedFilters = useMemo<Filters>(() => ({ ...defaultFilters, concept: slug }), [slug]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void fetchConcept(slug).then(
      (concept) => {
        if (!cancelled) setState({ status: "ready", concept });
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
      <ConceptHeader concept={state.concept} />
      <Feed filters={feedFilters} />
    </section>
  );
}
