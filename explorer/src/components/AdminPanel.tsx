import { useEffect, useRef, useState } from "react";

import type { ServiceAccountsSnapshot } from "@xtap-pool/shared";

import type { PoolSnapshot } from "../lib/api.js";
import {
  addPoolAdmin,
  addPoolMember,
  addPoolMemberOrg,
  fetchAdminPool,
  fetchAdminEnrichment,
  fetchAdminFreeLabels,
  fetchAdminServiceAccounts,
  issueServiceAccount,
  removePoolAdmin,
  removePoolMember,
  removePoolMemberOrg,
  repairPoolConfig,
  repairServiceAccounts,
  revokeServiceAccount,
  revokeServiceAccountKey,
  rotateServiceAccount,
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

// eslint-disable-next-line complexity -- This stateful admin surface coordinates several independent controls.
export function AdminPanel(): React.JSX.Element {
  const [state, setState] = useState<AdminState>({ status: "loading" });
  const [memberInput, setMemberInput] = useState("");
  const [adminInput, setAdminInput] = useState("");
  const [orgInput, setOrgInput] = useState("");
  const [enrichment, setEnrichment] = useState<Awaited<ReturnType<typeof fetchAdminEnrichment>>>();
  const [freeLabels, setFreeLabels] = useState<Awaited<ReturnType<typeof fetchAdminFreeLabels>>>();

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

  useEffect(() => {
    void fetchAdminEnrichment().then(setEnrichment, () => undefined);
    void fetchAdminFreeLabels().then(setFreeLabels, () => undefined);
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
          admins · {pool.member_orgs.length.toLocaleString()} org grant
        </p>
      </header>

      {pool.config_error === undefined ? null : (
        <div className="rounded-md border border-red-400 px-3 py-2 text-sm text-red-500">
          <p>{pool.config_error}</p>
          <button
            type="button"
            className="mt-2 rounded-md border border-red-400 px-2 py-1 font-semibold"
            disabled={busy !== undefined}
            onClick={() => {
              void mutate("repair-config", repairPoolConfig);
            }}
          >
            Replace with bootstrap membership
          </button>
        </div>
      )}
      {error === undefined ? null : <p className="text-sm text-red-500">{error}</p>}

      <section>
        <h3 className="mb-2 font-bold">Enrichment</h3>
        {enrichment === undefined ? (
          <p className="text-sm text-(--x-muted)">Loading worker status…</p>
        ) : (
          <p className="text-sm text-(--x-muted)">
            {enrichment.worker_active ? "Worker active" : "Worker idle"} · pending{" "}
            {enrichment.totals.pending} · retrying {enrichment.totals.retrying} · blocked{" "}
            {enrichment.totals.blocked} · complete {enrichment.totals.completed}
          </p>
        )}
        {freeLabels === undefined ? null : (
          <div className="mt-1 text-sm text-(--x-muted)">
            <p>
              Free labels:{" "}
              {freeLabels.labels.filter((label) => label.status === "candidate").length} candidate ·{" "}
              {freeLabels.labels.filter((label) => label.status === "approved").length} approved ·{" "}
              {freeLabels.labels.filter((label) => label.status === "rejected").length} rejected
            </p>
            {freeLabels.candidates.length === 0 ? null : (
              <ul className="mt-2 divide-y divide-(--x-border) border-y border-(--x-border)">
                {freeLabels.candidates.map((label) => (
                  <li key={label.name} className="py-2">
                    <p className="font-medium text-(--x-text)">
                      {label.name} · {label.unit_count} units · {label.distinct_authors} authors ·{" "}
                      {label.distinct_days} days
                    </p>
                    {label.representative_quotes.slice(0, 2).map((evidence) => (
                      <p key={`${evidence.unit_id}:${evidence.tweet_id}:${evidence.quote}`}>
                        {evidence.tweet_id}: {evidence.quote}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

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
          Set org
        </button>
      </form>

      <section>
        <h3 className="mb-2 font-bold">Member Organization</h3>
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

      <ServiceAccountsPanel />
    </div>
  );
}

type ServiceState =
  | { status: "loading" }
  | {
      status: "ready";
      snapshot: ServiceAccountsSnapshot;
      busy?: string;
      error?: string;
      issued?: { name: string; token: string };
    }
  | { status: "error"; error: string };

function optionalIssued(issued: { name: string; token: string } | undefined): {
  issued?: { name: string; token: string };
} {
  return issued === undefined ? {} : { issued };
}

function ServiceAccountsPanel(): React.JSX.Element {
  const [state, setState] = useState<ServiceState>({ status: "loading" });
  const [name, setName] = useState("");
  const issuedRef = useRef<{ name: string; token: string } | undefined>(undefined);

  useEffect(() => {
    void fetchAdminServiceAccounts().then(
      (snapshot) => {
        setState({ status: "ready", snapshot });
      },
      (error: unknown) => {
        setState({ status: "error", error: message(error) });
      },
    );
  }, []);

  async function mutateServices(
    label: string,
    operation: () => Promise<{ name?: string; token?: string } | undefined>,
  ): Promise<void> {
    if (state.status !== "ready") return;
    setState({
      status: "ready",
      snapshot: state.snapshot,
      busy: label,
      ...optionalIssued(issuedRef.current),
    });
    try {
      const result = await operation();
      if (result?.token !== undefined && result.name !== undefined) {
        issuedRef.current = { name: result.name, token: result.token };
        setState({
          status: "ready",
          snapshot: state.snapshot,
          busy: label,
          issued: issuedRef.current,
        });
      }
      const snapshot = await fetchAdminServiceAccounts();
      setState({
        status: "ready",
        snapshot,
        ...optionalIssued(issuedRef.current),
      });
    } catch (error) {
      setState({
        status: "ready",
        snapshot: state.snapshot,
        error: message(error),
        ...optionalIssued(issuedRef.current),
      });
    }
  }

  if (state.status === "loading") return <p className="text-sm text-(--x-muted)">Loading…</p>;
  if (state.status === "error") return <p className="text-sm text-red-500">{state.error}</p>;

  return (
    <section className="grid gap-3 border-t border-(--x-border) pt-5">
      <div>
        <h3 className="font-bold">Service Accounts</h3>
        <p className="text-sm text-(--x-muted)">
          Read-only machine access. Credentials appear once and cannot ingest or administer.
        </p>
      </div>

      {state.snapshot.config_error === undefined ? null : (
        <div className="rounded-md border border-red-400 px-3 py-2 text-sm text-red-500">
          <p>{state.snapshot.config_error}</p>
          <button
            type="button"
            className="mt-2 rounded-md border border-red-400 px-2 py-1 font-semibold"
            disabled={state.busy !== undefined}
            onClick={() => {
              void mutateServices("repair", async () => {
                await repairServiceAccounts();
                return undefined;
              });
            }}
          >
            Replace with empty registry
          </button>
        </div>
      )}

      {state.issued === undefined ? null : (
        <div className="rounded-md border border-amber-400 px-3 py-2 text-sm">
          <p className="font-semibold">Copy the {state.issued.name} credential now.</p>
          <p className="text-(--x-muted)">It will not be shown again.</p>
          <textarea
            aria-label="Issued service credential"
            className="mt-2 h-20 w-full rounded-md border border-(--x-border) bg-(--x-soft) p-2 font-mono text-xs"
            readOnly
            value={state.issued.token}
          />
          <button
            type="button"
            className="rounded-md border border-(--x-border) px-2 py-1 text-sm"
            onClick={() => {
              issuedRef.current = undefined;
              setState({ status: "ready", snapshot: state.snapshot });
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {state.error === undefined ? null : <p className="text-sm text-red-500">{state.error}</p>}

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const accountName = name.trim();
          if (accountName === "") return;
          setName("");
          void mutateServices(`issue:${accountName}`, async () => {
            const credential = await issueServiceAccount(accountName, [
              "units:read",
              "taxonomy:read",
            ]);
            return { name: credential.account.name, token: credential.token };
          });
        }}
      >
        <input
          aria-label="Service account name"
          className="min-w-0 flex-1 rounded-md border border-(--x-border) bg-(--x-soft) px-3 py-2 text-sm"
          placeholder="local-frontier"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <button
          type="submit"
          className="rounded-md bg-(--x-accent) px-3 py-2 text-sm font-semibold text-white"
          disabled={state.busy !== undefined || state.snapshot.config_error !== undefined}
        >
          Issue reader
        </button>
      </form>

      <ul className="divide-y divide-(--x-border) border-y border-(--x-border)">
        {state.snapshot.accounts.map((account) => (
          <li key={account.id} className="grid gap-2 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <strong>{account.name}</strong>{" "}
                <span className="text-sm text-(--x-muted)">
                  {account.status} · {account.scopes.join(", ")}
                </span>
              </span>
              {account.status === "active" ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-(--x-border) px-2 py-1 text-sm"
                    disabled={state.busy !== undefined}
                    onClick={() => {
                      void mutateServices(`rotate:${account.id}`, async () => {
                        const credential = await rotateServiceAccount(account.id);
                        return { name: credential.account.name, token: credential.token };
                      });
                    }}
                  >
                    Rotate
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-red-400 px-2 py-1 text-sm text-red-500"
                    disabled={state.busy !== undefined}
                    onClick={() => {
                      void mutateServices(`revoke:${account.id}`, async () => {
                        await revokeServiceAccount(account.id);
                        return undefined;
                      });
                    }}
                  >
                    Revoke
                  </button>
                </div>
              ) : null}
            </div>
            {account.keys.length === 0 ? null : (
              <ul className="grid gap-1 pl-3 text-xs text-(--x-muted)">
                {account.keys.map((key) => (
                  <li key={key.id} className="flex items-center justify-between gap-2">
                    <span>
                      key {key.id} · issued {key.created_at.slice(0, 10)}
                    </span>
                    <button
                      type="button"
                      className="rounded-md border border-(--x-border) px-2 py-1"
                      disabled={state.busy !== undefined}
                      onClick={() => {
                        void mutateServices(`revoke-key:${key.id}`, async () => {
                          await revokeServiceAccountKey(account.id, key.id);
                          return undefined;
                        });
                      }}
                    >
                      Revoke key
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}
