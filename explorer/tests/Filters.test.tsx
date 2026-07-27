import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FiltersPanel } from "../src/components/Filters.js";
import { defaultFilters } from "../src/lib/api.js";
import type { ContributorStats, LabelStat } from "../src/lib/api.js";

const contributors: ContributorStats[] = [
  { username: "osolmaz", tweetCount: 1200, lastPooledAt: "2026-07-06T00:00:00.000Z" },
  { username: "alice", tweetCount: 3, lastPooledAt: "2026-07-05T00:00:00.000Z" },
];
const labels: LabelStat[] = [{ name: "ai", description: "AI posts", count: 8600 }];
const freeLabels = [{ name: "vllm" }, { name: "agentic-coding" }];

function renderPanel(onChange = vi.fn(), filters = defaultFilters): void {
  render(
    <FiltersPanel
      filters={filters}
      contributors={contributors}
      labels={labels}
      freeLabels={freeLabels}
      onChange={onChange}
    />,
  );
}

afterEach(cleanup);

describe("FiltersPanel", () => {
  it("lists contributors and toggles their selection", () => {
    const onChange = vi.fn();
    renderPanel(onChange);
    expect(screen.getByText("1.2K")).toBeDefined();
    fireEvent.click(screen.getByLabelText(/osolmaz/));
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, contributors: ["osolmaz"] });
  });

  it("toggles preset labels and sorts the approved free-label picker", () => {
    const onChange = vi.fn();
    renderPanel(onChange);
    fireEvent.click(screen.getByRole("button", { name: /^ai/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, labels: ["ai"] });
    const select = screen.getByLabelText("Free label");
    expect([...select.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "Any free label",
      "agentic-coding",
      "vllm",
    ]);
    fireEvent.change(select, { target: { value: "vllm" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, freeLabel: "vllm" });
  });

  it("updates search, flags, and dates", () => {
    const onChange = vi.fn();
    renderPanel(onChange);
    fireEvent.change(screen.getByLabelText("Search tweets"), { target: { value: "vllm" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, q: "vllm" });
    fireEvent.click(screen.getByLabelText("With media"));
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, hasMedia: true });
    fireEvent.click(screen.getByLabelText("Collapse duplicates"));
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, dedup: false });
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-05-01" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, since: "2026-05-01" });
  });

  it("hides enrichment controls without public labels", () => {
    render(
      <FiltersPanel
        filters={defaultFilters}
        contributors={[]}
        labels={[]}
        freeLabels={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText("Labels")).toBeNull();
    expect(screen.queryByLabelText("Free label")).toBeNull();
  });
});
