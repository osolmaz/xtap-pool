import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { isPlainLeftClick, navigate, parseRoute, useRoute } from "../src/lib/router.js";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("parseRoute", () => {
  it("maps pathnames onto explorer routes", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
    expect(parseRoute("/graph")).toEqual({ kind: "graph" });
    expect(parseRoute("/graph/")).toEqual({ kind: "graph" });
    expect(parseRoute("/graph/finite-element-method")).toEqual({
      kind: "free-label",
      slug: "finite-element-method",
    });
    expect(parseRoute("/graph/a%20b")).toEqual({ kind: "free-label", slug: "a b" });
    expect(parseRoute("/anything-else")).toEqual({ kind: "home" });
  });
});

describe("useRoute / navigate", () => {
  it("tracks pushed paths and updates the URL", () => {
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ kind: "home" });

    act(() => {
      navigate("/graph/vllm");
    });
    expect(result.current).toEqual({ kind: "free-label", slug: "vllm" });
    expect(window.location.pathname).toBe("/graph/vllm");

    act(() => {
      navigate("/graph");
    });
    expect(result.current).toEqual({ kind: "graph" });
  });
});

describe("isPlainLeftClick", () => {
  const base = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };

  it("accepts unmodified primary-button clicks only", () => {
    expect(isPlainLeftClick(base)).toBe(true);
    expect(isPlainLeftClick({ ...base, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...base, defaultPrevented: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, metaKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, ctrlKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, shiftKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, altKey: true })).toBe(false);
  });
});
