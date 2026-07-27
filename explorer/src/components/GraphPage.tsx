import { useCallback, useEffect, useState } from "react";

import type { FreeLabelGraphData, FreeLabelSummary } from "../lib/api.js";
import { fetchFreeLabelGraph, fetchFreeLabels } from "../lib/api.js";
import { formatCount } from "../lib/format.js";
import { navigate } from "../lib/router.js";
import { AppLink } from "./AppLink.js";
import { FreeLabelGraph } from "./ui/FreeLabelGraph.js";

const GRAPH_TOP = 300;

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; graph: FreeLabelGraphData; labels: readonly FreeLabelSummary[] };

/** Approved free-label co-occurrence view. */
export function GraphPage(): React.JSX.Element {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchFreeLabelGraph(GRAPH_TOP), fetchFreeLabels()]).then(
      ([graph, labels]) => {
        if (!cancelled) setState({ status: "ready", graph, labels });
      },
      (error: unknown) => {
        if (!cancelled)
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "failed to load",
          });
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, []);
  const openFreeLabel = useCallback((name: string): void => {
    navigate(`/graph/${encodeURIComponent(name)}`);
  }, []);
  if (state.status === "loading") return <p className="p-4 text-sm text-(--x-muted)">Loading…</p>;
  if (state.status === "error") return <p className="p-4 text-sm text-red-500">{state.message}</p>;
  if (state.labels.length === 0)
    return <p className="p-4 text-sm text-(--x-muted)">No approved free labels yet.</p>;
  return (
    <section className="flex flex-col gap-4 p-4">
      <header className="border-b border-(--x-border) pb-4">
        <h2 className="text-lg font-bold">Free-label graph</h2>
        <p className="mt-1 text-sm text-(--x-muted)">
          Approved labels linked by unit co-occurrence.
        </p>
      </header>
      <p className="text-sm text-(--x-muted)">
        {state.graph.links.length.toLocaleString()} co-occurrence edges
      </p>
      <FreeLabelGraph
        nodes={state.graph.nodes}
        links={state.graph.links}
        onNavigate={openFreeLabel}
      />
      <h3 className="font-bold">All approved free labels</h3>
      <ul className="columns-2 gap-6 text-sm md:columns-3">
        {[...state.labels]
          .sort((a, b) => b.post_count - a.post_count || a.name.localeCompare(b.name))
          .map((label) => (
            <li key={label.name} className="flex items-baseline gap-2">
              <AppLink href={`/graph/${label.name}`} className="truncate text-(--x-accent)">
                {label.name}
              </AppLink>
              <span className="text-(--x-muted)">{formatCount(label.post_count)}</span>
            </li>
          ))}
      </ul>
    </section>
  );
}
