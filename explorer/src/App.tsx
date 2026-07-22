import { useEffect, useState } from "react";

import { AdminPanel } from "./components/AdminPanel.js";
import { FiltersPanel } from "./components/Filters.js";
import { Feed } from "./components/Feed.js";
import type { ContributorStats, Filters } from "./lib/api.js";
import { defaultFilters, fetchContributors, fetchMe } from "./lib/api.js";

type AuthState =
  | { status: "checking" }
  | { status: "signed-out" }
  | { status: "signed-in"; username: string; isAdmin: boolean };

type View = "feed" | "install" | "admin";

const INSTALL_COMMAND =
  'rm -rf ~/.local/share/xtap-pool-extension && mkdir -p ~/.local/share/xtap-pool-extension && curl -L https://github.com/osolmaz/xtap-pool/archive/refs/heads/main.tar.gz | tar -xz --strip-components=2 -C ~/.local/share/xtap-pool-extension xtap-pool-main/extension && open -a "Google Chrome" "chrome://extensions"';

function InstallExtension(): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copyCommand = (): void => {
    void navigator.clipboard.writeText(INSTALL_COMMAND).then(
      () => {
        setCopied(true);
        window.setTimeout(() => {
          setCopied(false);
        }, 1500);
      },
      () => undefined,
    );
  };

  return (
    <section className="flex flex-col gap-4 p-4">
      <header className="border-b border-(--x-border) pb-4">
        <h2 className="text-lg font-bold">Install extension</h2>
        <p className="mt-1 text-sm text-(--x-muted)">
          Add the browser extension, connect it to this pool, then browse X normally.
        </p>
      </header>
      <p className="text-sm text-(--x-muted)">
        Run this on macOS, enable Developer mode in Chrome, then Load unpacked and choose{" "}
        <code>~/.local/share/xtap-pool-extension</code>.
      </p>
      <pre className="overflow-x-auto rounded-md border border-(--x-border) bg-(--x-soft) p-3 text-xs leading-5">
        <code>{INSTALL_COMMAND}</code>
      </pre>
      <div className="flex flex-wrap gap-2 text-sm">
        <button
          className="rounded-md border border-(--x-border) px-3 py-1.5 font-semibold"
          type="button"
          onClick={copyCommand}
        >
          {copied ? "Copied" : "Copy command"}
        </button>
        <a
          className="rounded-md bg-(--x-accent) px-3 py-1.5 font-semibold text-white"
          href="/connect"
        >
          Connect
        </a>
      </div>
    </section>
  );
}

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
  const [view, setView] = useState<View>("feed");
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [contributors, setContributors] = useState<readonly ContributorStats[]>([]);
  const tabClass = (active: boolean, tone: "default" | "accent" = "default"): string =>
    [
      "rounded-md border px-3 py-1.5 text-sm font-semibold",
      tone === "accent" ? "border-(--x-accent) text-(--x-accent)" : "border-(--x-border)",
      active ? (tone === "accent" ? "bg-(--x-accent) text-white" : "bg-(--x-soft-active)") : "",
    ]
      .filter(Boolean)
      .join(" ");

  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const me = await fetchMe();
        setAuth(
          me === undefined
            ? { status: "signed-out" }
            : { status: "signed-in", username: me.username, isAdmin: me.isAdmin },
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
        <nav className="mb-4 flex gap-2">
          <button
            type="button"
            aria-pressed={view === "feed"}
            className={tabClass(view === "feed")}
            onClick={() => {
              setView("feed");
            }}
          >
            Feed
          </button>
          <button
            type="button"
            aria-pressed={view === "install"}
            className={tabClass(view === "install", "accent")}
            onClick={() => {
              setView("install");
            }}
          >
            Install
          </button>
          {auth.isAdmin ? (
            <button
              type="button"
              aria-pressed={view === "admin"}
              className={tabClass(view === "admin")}
              onClick={() => {
                setView("admin");
              }}
            >
              Admin
            </button>
          ) : null}
        </nav>
        {view === "feed" ? (
          <FiltersPanel filters={filters} contributors={contributors} onChange={setFilters} />
        ) : null}
      </aside>
      <main className="border-x border-(--x-border)">
        {view === "install" ? (
          <InstallExtension />
        ) : view === "admin" && auth.isAdmin ? (
          <AdminPanel />
        ) : (
          <Feed filters={filters} />
        )}
      </main>
    </div>
  );
}
