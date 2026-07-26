import { useCallback, useEffect, useState } from "react";

import type { ConceptGraphData, ConceptSummary } from "../lib/api.js";
import { fetchConceptGraph, fetchConcepts } from "../lib/api.js";
import { formatCount } from "../lib/format.js";
import { navigate } from "../lib/router.js";
import { AppLink } from "./AppLink.js";
import { ConceptGraph } from "./ui/ConceptGraph.js";

/** Node budget for the co-occurrence subgraph request. */
const GRAPH_TOP = 300;

type GraphPageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; graph: ConceptGraphData; concepts: readonly ConceptSummary[] };

function ConceptIndex({ concepts }: { concepts: readonly ConceptSummary[] }): React.JSX.Element {
  const sorted = [...concepts].sort((a, b) => b.post_count - a.post_count);
  return (
    <ul className="columns-2 gap-6 text-sm md:columns-3">
      {sorted.map((concept) => (
        <li key={concept.slug} className="flex items-baseline gap-2">
          <AppLink href={`/graph/${concept.slug}`} className="truncate text-(--x-accent)">
            {concept.name}
          </AppLink>
          <span className="text-(--x-muted)">{formatCount(concept.post_count)}</span>
        </li>
      ))}
    </ul>
  );
}

/** /graph: force-directed concept map plus a text index with post counts. */
export function GraphPage(): React.JSX.Element {
  const [state, setState] = useState<GraphPageState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchConceptGraph(GRAPH_TOP), fetchConcepts()]).then(
      ([graph, concepts]) => {
        if (!cancelled) setState({ status: "ready", graph, concepts });
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "failed to load";
        if (!cancelled) setState({ status: "error", message });
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, []);

  const openConcept = useCallback((id: string) => {
    navigate(`/graph/${id}`);
  }, []);

  if (state.status === "loading") {
    return <p className="p-4 text-sm text-(--x-muted)">Loading…</p>;
  }
  if (state.status === "error") {
    return <p className="p-4 text-sm text-red-500">{state.message}</p>;
  }
  if (state.concepts.length === 0) {
    return (
      <p className="p-4 text-sm text-(--x-muted)">
        No concepts yet. They appear once pooled posts have been enriched.
      </p>
    );
  }
  return (
    <section className="flex flex-col gap-4 p-4">
      <header className="border-b border-(--x-border) pb-4">
        <h2 className="text-lg font-bold">Concept graph</h2>
        <p className="mt-1 text-sm text-(--x-muted)">
          Concepts extracted from pooled posts, linked when they appear in the same conversation.
          Click a node to open its page.
        </p>
      </header>
      <ConceptGraph nodes={state.graph.nodes} links={state.graph.links} onNavigate={openConcept} />
      <h3 className="font-bold">All concepts</h3>
      <ConceptIndex concepts={state.concepts} />
    </section>
  );
}
