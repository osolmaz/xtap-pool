import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FiltersPanel } from "../src/components/Filters.js";
import { defaultFilters } from "../src/lib/api.js";
import type { ContributorStats, LabelStat } from "../src/lib/api.js";
import type { ConceptOption } from "../src/components/Filters.js";

const contributors: ContributorStats[] = [
  { username: "osolmaz", tweetCount: 1200, lastPooledAt: "2026-07-06T00:00:00.000Z" },
  { username: "alice", tweetCount: 3, lastPooledAt: "2026-07-05T00:00:00.000Z" },
];

const labels: LabelStat[] = [
  { name: "ai", description: "AI posts", count: 8600 },
  { name: "agents", count: 4 },
];

const concepts: ConceptOption[] = [
  { slug: "vllm", name: "vLLM" },
  { slug: "agentic-coding", name: "Agentic coding" },
];

type PanelProps = Partial<Parameters<typeof FiltersPanel>[0]>;

function renderPanel(props: PanelProps = {}): ReturnType<typeof render> {
  return render(
    <FiltersPanel
      filters={defaultFilters}
      contributors={contributors}
      labels={labels}
      concepts={concepts}
      onChange={vi.fn()}
      {...props}
    />,
  );
}

afterEach(cleanup);

describe("FiltersPanel", () => {
  it("lists contributors with compact counts", () => {
    renderPanel();
    expect(screen.getByText("osolmaz")).toBeDefined();
    expect(screen.getByText("1.2K")).toBeDefined();
    expect(screen.getByText("alice")).toBeDefined();
  });

  it("toggles contributors on and off", () => {
    const onChange = vi.fn();
    const { rerender } = renderPanel({ onChange });
    fireEvent.click(screen.getByLabelText(/osolmaz/));
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, contributors: ["osolmaz"] });

    rerender(
      <FiltersPanel
        filters={{ ...defaultFilters, contributors: ["osolmaz"] }}
        contributors={contributors}
        labels={labels}
        concepts={concepts}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText(/osolmaz/));
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, contributors: [] });
  });

  it("toggles preset-label chips on and off", () => {
    const onChange = vi.fn();
    const { rerender } = renderPanel({ onChange });
    const chip = screen.getByRole("button", { name: /^ai/ });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, labels: ["ai"] });

    rerender(
      <FiltersPanel
        filters={{ ...defaultFilters, labels: ["ai"] }}
        contributors={contributors}
        labels={labels}
        concepts={concepts}
        onChange={onChange}
      />,
    );
    const active = screen.getByRole("button", { name: /^ai/ });
    expect(active.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(active);
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, labels: [] });
  });

  it("selects a concept from the sorted picker", () => {
    const onChange = vi.fn();
    renderPanel({ onChange });
    const select = screen.getByLabelText("Concept");
    const options = [...select.querySelectorAll("option")].map((option) => option.textContent);
    expect(options).toEqual(["Any concept", "Agentic coding", "vLLM"]);
    fireEvent.change(select, { target: { value: "vllm" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, concept: "vllm" });
  });

  it("hides label and concept controls when enrichment data is absent", () => {
    renderPanel({ labels: [], concepts: [] });
    expect(screen.queryByText("Labels")).toBeNull();
    expect(screen.queryByLabelText("Concept")).toBeNull();
  });

  it("updates search, flags and date range", () => {
    const onChange = vi.fn();
    renderPanel({ onChange });
    fireEvent.change(screen.getByLabelText("Search tweets"), { target: { value: "vllm" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, q: "vllm" });

    fireEvent.click(screen.getByLabelText("With media"));
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, hasMedia: true });

    fireEvent.click(screen.getByLabelText("Articles"));
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, isArticle: true });

    fireEvent.click(screen.getByLabelText("Collapse duplicates"));
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, dedup: false });

    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-05-01" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, since: "2026-05-01" });

    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-05-31" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, until: "2026-05-31" });
  });
});
