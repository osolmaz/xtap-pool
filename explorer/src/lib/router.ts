import { useEffect, useState } from "react";

/** Parsed explorer location: the feed shell, the graph index, or one concept. */
export type Route = { kind: "home" } | { kind: "graph" } | { kind: "concept"; slug: string };

/** Map a pathname onto an explorer route; unknown paths fall back to the feed. */
export function parseRoute(pathname: string): Route {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments[0] !== "graph") return { kind: "home" };
  const slug = segments[1];
  if (slug === undefined) return { kind: "graph" };
  return { kind: "concept", slug: decodeURIComponent(slug) };
}

/** SPA navigation: push the path and let useRoute listeners re-render. */
export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Clicks the SPA should handle itself (primary button, no modifier keys). */
export function isPlainLeftClick(event: {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** Current route, updated on navigate() pushes and browser back/forward. */
export function useRoute(): Route {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPopState = (): void => {
      setPathname(window.location.pathname);
    };
    window.addEventListener("popstate", onPopState);
    return (): void => {
      window.removeEventListener("popstate", onPopState);
    };
  }, []);
  return parseRoute(pathname);
}
