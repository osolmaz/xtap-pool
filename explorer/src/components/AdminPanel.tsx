import { useEffect, useState } from "react";

import type { PoolSnapshot } from "../lib/api.js";
import {
  addPoolAdmin,
  addPoolMember,
  addPoolMemberOrg,
  fetchAdminPool,
  removePoolAdmin,
  removePoolMember,
  removePoolMemberOrg,
} from "../lib/api.js";
import type { MemberOrgGrant } from "../lib/api.js";

type AdminState =
  | { status: "loading" }
  | { status: "ready"; pool: PoolSnapshot; busy?: string; error?: string }
  | { status: "error"; error: string };

function sortUsers(users: readonly string[]): string[] {
  return [...users].sort((a, b) => a.localeCompare(b));
}

function sortMemberOrgs(orgs: readonly MemberOrgGrant[]): MemberOrgGrant[] {
  return [...orgs].sort((a, b) => a.name.localeCompare(b.name));
}

export function AdminPanel(): React.JSX.Element {
  const [state, setState] = useState<AdminState>({ status: "loading" });
  const [memberInput, setMemberInput] = useState("");
  const [adminInput, setAdminInput] = useState("");
  const [orgInput, setOrgInput] = useState("");

  useEffect(() => {
    void fetchAdminPool().then(
      ({ pool }) => {
        setState({ status: "ready", pool });
      },
      (error: unknown) => {
        setState({ status: "error", error: message(error) });
      },
    );
  }, []);

  async function mutate(label: string, action: () => Promise<PoolSnapshot>): Promise<void> {
    if (state.status !== "ready") return;
    setState({ status: "ready", pool: state.pool, busy: label });
    try {
      const pool = await action();
      setState({ status: "ready", pool });
    } catch (error) {
      setState({ status: "ready", pool: state.pool, error: message(error) });
    }
  }

  if (state.status === "loading") {
    return <p className="p-4 text-sm text-(--x-muted)">Loading…</p>;
  }
  if (state.status === "error") {
    return <p className="p-4 text-sm text-red-500">{state.error}</p>;
  }

  const { pool, busy, error } = state;
  const admins = new Set(pool.admins);
  const bootstrapAdmins = new Set(pool.bootstrap_admins);

  return (
    <div className="flex flex-col gap-6 p-4">
      <header className="border-b border-(--x-border) pb-4">
        <h2 className="text-lg font-bold">Pool Admin</h2>
        <p className="text-sm text-(--x-muted)">
          {pool.members.length.toLocaleString()} members · {pool.admins.length.toLocaleString()}{" "}
          admins · {pool.member_orgs.length.toLocaleString()} orgs
        </p>
      </header>

      {pool.config_error === undefined ? null : (
        <p className="rounded-md border border-red-400 px-3 py-2 text-sm text-red-500">
          {pool.config_error}
        </p>
      )}
      {error === undefined ? null : <p className="text-sm text-red-500">{error}</p>}

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const username = memberInput.trim();
          if (username === "") return;
          setMemberInput("");
          void mutate(`member:${username}`, () => addPoolMember(username));
        }}
      >
        <input
          aria-label="Member username"
          className="min-w-0 flex-1 rounded-md border border-(--x-border) bg-(--x-soft) px-3 py-2 text-sm outline-none focus:border-(--x-accent)"
          placeholder="HF username"
          value={memberInput}
          onChange={(event) => {
            setMemberInput(event.target.value);
          }}
        />
        <button
          type="submit"
          className="rounded-md bg-(--x-accent) px-3 py-2 text-sm font-semibold text-white"
          disabled={busy !== undefined}
        >
          Add member
        </button>
      </form>

      <section>
        <h3 className="mb-2 font-bold">Members</h3>
        <ul className="divide-y divide-(--x-border) border-y border-(--x-border)">
          {sortUsers(pool.members).map((member) => (
            <li key={member} className="flex items-center justify-between gap-3 py-2">
              <span>@{member}</span>
              <div className="flex gap-2">
                {!admins.has(member) ? (
                  <button
                    type="button"
                    className="rounded-md border border-(--x-border) px-2 py-1 text-sm"
                    disabled={busy !== undefined}
                    onClick={() => {
                      void mutate(`admin:${member}`, () => addPoolAdmin(member));
                    }}
                  >
                    Promote
                  </button>
                ) : null}
                {!admins.has(member) ? (
                  <button
                    type="button"
                    className="rounded-md border border-(--x-border) px-2 py-1 text-sm"
                    disabled={busy !== undefined}
                    onClick={() => {
                      void mutate(`member:${member}`, () => removePoolMember(member));
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const orgName = orgInput.trim();
          if (orgName === "") return;
          setOrgInput("");
          void mutate(`member-org:${orgName}`, () => addPoolMemberOrg(orgName));
        }}
      >
        <input
          aria-label="Member organization"
          className="min-w-0 flex-1 rounded-md border border-(--x-border) bg-(--x-soft) px-3 py-2 text-sm outline-none focus:border-(--x-accent)"
          placeholder="HF organization"
          value={orgInput}
          onChange={(event) => {
            setOrgInput(event.target.value);
          }}
        />
        <button
          type="submit"
          className="rounded-md bg-(--x-accent) px-3 py-2 text-sm font-semibold text-white"
          disabled={busy !== undefined}
        >
          Add org
        </button>
      </form>

      <section>
        <h3 className="mb-2 font-bold">Member Organizations</h3>
        <ul className="divide-y divide-(--x-border) border-y border-(--x-border)">
          {sortMemberOrgs(pool.member_orgs).map((org) => (
            <li key={org.sub} className="flex items-center justify-between gap-3 py-2">
              <span>
                @{org.name}
                {org.display_name === undefined ? null : (
                  <span className="ml-2 text-sm text-(--x-muted)">{org.display_name}</span>
                )}
              </span>
              <button
                type="button"
                className="rounded-md border border-(--x-border) px-2 py-1 text-sm"
                disabled={busy !== undefined}
                onClick={() => {
                  void mutate(`member-org:${org.name}`, () => removePoolMemberOrg(org.name));
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const username = adminInput.trim();
          if (username === "") return;
          setAdminInput("");
          void mutate(`admin:${username}`, () => addPoolAdmin(username));
        }}
      >
        <input
          aria-label="Admin username"
          className="min-w-0 flex-1 rounded-md border border-(--x-border) bg-(--x-soft) px-3 py-2 text-sm outline-none focus:border-(--x-accent)"
          placeholder="HF username"
          value={adminInput}
          onChange={(event) => {
            setAdminInput(event.target.value);
          }}
        />
        <button
          type="submit"
          className="rounded-md bg-(--x-accent) px-3 py-2 text-sm font-semibold text-white"
          disabled={busy !== undefined}
        >
          Add admin
        </button>
      </form>

      <section>
        <h3 className="mb-2 font-bold">Admins</h3>
        <ul className="divide-y divide-(--x-border) border-y border-(--x-border)">
          {sortUsers(pool.admins).map((admin) => (
            <li key={admin} className="flex items-center justify-between gap-3 py-2">
              <span>@{admin}</span>
              {bootstrapAdmins.has(admin) ? (
                <span className="text-sm text-(--x-muted)">Bootstrap</span>
              ) : (
                <button
                  type="button"
                  className="rounded-md border border-(--x-border) px-2 py-1 text-sm"
                  disabled={busy !== undefined}
                  onClick={() => {
                    void mutate(`admin:${admin}`, () => removePoolAdmin(admin));
                  }}
                >
                  Demote
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}
