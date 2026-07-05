import { useEffect, useState } from "react";

import { FiltersPanel } from "./components/Filters.js";
import { Feed } from "./components/Feed.js";
import type { ContributorStats, Filters } from "./lib/api.js";
import { defaultFilters, fetchContributors, fetchMe } from "./lib/api.js";

type AuthState =
  { status: "checking" } | { status: "signed-out" } | { status: "signed-in"; username: string };

function SignIn(): React.JSX.Element {
  return (
    <main className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
      <h1 className="text-2xl font-bold">xtap-pool</h1>
      <p className="text-(--x-muted)">
        A private tweet pool for friends. Sign in with your Hugging Face account to explore.
      </p>
      <a
        className="rounded-full bg-(--x-accent) px-5 py-2 font-semibold text-white"
        href="/oauth/login?next=/"
      >
        Sign in with Hugging Face
      </a>
    </main>
  );
}

/** Root explorer app: auth gate, filter rail and tweet feed. */
export function App(): React.JSX.Element {
  const [auth, setAuth] = useState<AuthState>({ status: "checking" });
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [contributors, setContributors] = useState<readonly ContributorStats[]>([]);
  const [now] = useState(() => new Date());

  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const me = await fetchMe();
        setAuth(
          me === undefined
            ? { status: "signed-out" }
            : { status: "signed-in", username: me.username },
        );
      } catch {
        setAuth({ status: "signed-out" });
      }
    })();
  }, []);

  useEffect(() => {
    if (auth.status !== "signed-in") return;
    void fetchContributors().then(setContributors, () => undefined);
  }, [auth.status]);

  if (auth.status === "checking") {
    return <p className="p-8 text-sm text-(--x-muted)">Loading…</p>;
  }
  if (auth.status === "signed-out") {
    return <SignIn />;
  }

  return (
    <div className="mx-auto grid max-w-4xl grid-cols-1 gap-6 px-4 py-6 md:grid-cols-[14rem_minmax(0,1fr)]">
      <aside>
        <header className="mb-4">
          <h1 className="text-xl font-bold">xtap-pool</h1>
          <p className="text-sm text-(--x-muted)">signed in as @{auth.username}</p>
        </header>
        <FiltersPanel filters={filters} contributors={contributors} onChange={setFilters} />
      </aside>
      <main className="border-x border-(--x-border)">
        <Feed filters={filters} now={now} />
      </main>
    </div>
  );
}
