import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FiltersPanel } from "../src/components/Filters.js";
import { defaultFilters } from "../src/lib/api.js";
import type { ContributorStats } from "../src/lib/api.js";

const contributors: ContributorStats[] = [
  { username: "osolmaz", tweetCount: 1200, lastPooledAt: "2026-07-06T00:00:00.000Z" },
  { username: "alice", tweetCount: 3, lastPooledAt: "2026-07-05T00:00:00.000Z" },
];

afterEach(cleanup);

describe("FiltersPanel", () => {
  it("lists contributors with compact counts", () => {
    render(
      <FiltersPanel filters={defaultFilters} contributors={contributors} onChange={vi.fn()} />,
    );
    expect(screen.getByText("osolmaz")).toBeDefined();
    expect(screen.getByText("1.2K")).toBeDefined();
    expect(screen.getByText("alice")).toBeDefined();
  });

  it("toggles contributors on and off", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FiltersPanel filters={defaultFilters} contributors={contributors} onChange={onChange} />,
    );
    fireEvent.click(screen.getByLabelText(/osolmaz/));
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, contributors: ["osolmaz"] });

    rerender(
      <FiltersPanel
        filters={{ ...defaultFilters, contributors: ["osolmaz"] }}
        contributors={contributors}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText(/osolmaz/));
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultFilters, contributors: [] });
  });

  it("updates search, flags and date range", () => {
    const onChange = vi.fn();
    render(
      <FiltersPanel filters={defaultFilters} contributors={contributors} onChange={onChange} />,
    );
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
