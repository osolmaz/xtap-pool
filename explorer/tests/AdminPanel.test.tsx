/* eslint-disable complexity, @typescript-eslint/no-base-to-string */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminPanel } from "../src/components/AdminPanel.js";

const pool = {
  version: 1 as const,
  admins: ["root", "alice"],
  members: ["root", "alice", "bob"],
  member_orgs: [{ name: "huggingface", sub: "org-1", display_name: "Hugging Face" }],
  bootstrap_admins: ["root"],
  updated_at: "2026-07-06T00:00:00.000Z",
  source: "bucket" as const,
};
const accounts = {
  version: 1 as const,
  source: "bucket" as const,
  accounts: [
    {
      id: "reader",
      name: "reader",
      status: "active" as const,
      scopes: ["units:read", "taxonomy:read"],
      created_at: "2026-07-06T00:00:00.000Z",
      updated_at: "2026-07-06T00:00:00.000Z",
      keys: [
        {
          id: "key-1",
          created_at: "2026-07-06T00:00:00.000Z",
          expires_at: "2027-07-06T00:00:00.000Z",
        },
      ],
    },
  ],
};

function stubApi(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? "";
    if (path === "/api/admin/pool") return Response.json({ pool, viewer: { username: "root" } });
    if (path === "/api/admin/enrichment")
      return Response.json({
        contract_hash: "hash",
        totals: { pending: 2, running: 0, retrying: 1, blocked: 0, completed: 9 },
        worker_recently_completed: true,
        recent_errors: [],
      });
    if (path === "/api/admin/free-labels")
      return Response.json({
        registry_revision: 1,
        labels: [
          { name: "vllm", status: "candidate", unit_count: 2 },
          { name: "sglang", status: "approved", unit_count: 4 },
        ],
        candidates: [
          {
            name: "vllm",
            unit_count: 2,
            distinct_authors: 2,
            distinct_days: 1,
            representative_quotes: [{ unit_id: "u", tweet_id: "t", quote: "vllm" }],
          },
        ],
      });
    if (path === "/api/admin/service-accounts" && init?.method === "POST")
      return Response.json({ account: accounts.accounts[0], token: "one-time" }, { status: 201 });
    if (path === "/api/admin/service-accounts")
      return Response.json({ service_accounts: accounts });
    if (path.startsWith("/api/admin/")) return Response.json({ pool });
    return new Response("missing", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminPanel", () => {
  it("shows worker and candidate status and performs membership, organization, and account actions", async () => {
    const fetchMock = stubApi();
    render(<AdminPanel />);
    await screen.findByText(/Worker recently completed/);
    expect(screen.getByText(/Free labels: 1 candidate/)).toBeDefined();
    expect(screen.getByText("t: vllm")).toBeDefined();
    fireEvent.change(await screen.findByLabelText("Service account name"), {
      target: { value: "new-reader" },
    });
    fireEvent.click(screen.getByText("Issue reader"));
    await screen.findByLabelText("Issued service credential");
    fireEvent.click(screen.getByText("Dismiss"));
    fireEvent.change(screen.getByLabelText("Member username"), { target: { value: "charlie" } });
    fireEvent.click(screen.getByText("Add member"));
    fireEvent.change(screen.getByLabelText("Member organization"), {
      target: { value: "new-org" },
    });
    fireEvent.click(screen.getByText("Set org"));
    fireEvent.change(screen.getByLabelText("Admin username"), { target: { value: "charlie" } });
    fireEvent.click(screen.getByText("Add admin"));
    fireEvent.click(screen.getByText("Promote"));
    const [firstRemove] = screen.getAllByText("Remove");
    if (firstRemove === undefined) throw new Error("expected remove control");
    fireEvent.click(firstRemove);
    fireEvent.click(screen.getByText("Demote"));
    expect(fetchMock).toHaveBeenCalled();
  });

  it("shows repair controls for invalid durable configuration", async () => {
    const brokenPool = {
      ...pool,
      config_error: "invalid pool config",
      source: "bootstrap" as const,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/admin/pool")
          return Response.json({ pool: brokenPool, viewer: { username: "root" } });
        if (path === "/api/admin/enrichment")
          return Response.json({
            contract_hash: "hash",
            totals: { pending: 0, running: 0, retrying: 0, blocked: 0, completed: 0 },
            worker_recently_completed: false,
            recent_errors: [],
          });
        if (path === "/api/admin/free-labels")
          return Response.json({ registry_revision: 1, labels: [], candidates: [] });
        if (path === "/api/admin/service-accounts")
          return Response.json({
            service_accounts: {
              version: 1,
              accounts: [],
              source: "bootstrap",
              config_error: "invalid service accounts",
            },
          });
        if (path.includes("repair"))
          return Response.json({
            pool,
            service_accounts: { version: 1, accounts: [], source: "bucket" },
          });
        return Response.json({ pool });
      }),
    );
    render(<AdminPanel />);
    await screen.findByText("invalid pool config");
    expect(screen.getByText(/No recent run/)).toBeDefined();
    await screen.findByText("invalid service accounts");
    fireEvent.click(screen.getByText("Replace with bootstrap membership"));
    fireEvent.click(screen.getByText("Replace with empty registry"));
  });
});
