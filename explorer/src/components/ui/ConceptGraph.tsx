/**
 * Interactive force-directed view of the concept graph, drawn on a plain
 * canvas (no d3). Ported from local-frontier's ConceptGraph.tsx (itself
 * ported from solmaz.io's /graph/ page island); only the theme tokens
 * (--x-*) and the click target (onNavigate callback) changed.
 *
 * The layout is deterministic: initial positions hash from the node id, a
 * short synchronous pre-roll runs before first paint, and the settling
 * happens live on screen while the camera softly tracks an auto-fit view.
 * Hovering dims unrelated nodes, labels are occlusion-culled, dragging
 * pans, the wheel zooms, and clicking a node opens its concept page.
 */
import { useEffect, useRef } from "react";

export type ConceptGraphNode = {
  id: string;
  name: string;
  docs: number;
  group: number;
};

export type ConceptGraphLink = {
  source: string;
  target: string;
  weight: number;
};

export type ConceptGraphProps = {
  nodes: readonly ConceptGraphNode[];
  links: readonly ConceptGraphLink[];
  onNavigate: (id: string) => void;
};

type SimNode = ConceptGraphNode & {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
};

type SimLink = { a: SimNode; b: SimNode; weight: number };

type GraphState = {
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  ctx: CanvasRenderingContext2D;
  dpr: number;
  onNavigate: (id: string) => void;
  nodes: SimNode[];
  links: SimLink[];
  neighbors: Map<SimNode, Set<SimNode>>;
  width: number;
  height: number;
  scale: number;
  tx: number;
  ty: number;
  alpha: number;
  motion: number;
  sustained: number;
  animating: boolean;
  followFit: boolean;
  hovered: SimNode | null;
  dragging: boolean;
  moved: boolean;
  lastX: number;
  lastY: number;
  simRaf: number;
  viewRaf: number;
  disposed: boolean;
};

// Fixed simulation parameters (the source page exposed these as sliders).
// minDocs is effectively 1: every node passed in is rendered.
const PARAMS = {
  repel: 12000,
  linkDistance: 60,
  center: 1,
  labelDocs: 3,
  nodeSize: 1.6,
};

// Tableau 10: readable on both the light and dark theme. Communities are
// numbered by size, so the biggest clusters get the first colors.
const PALETTE = [
  "#4e79a7",
  "#f28e2b",
  "#59a14f",
  "#e15759",
  "#b07aa1",
  "#76b7b2",
  "#edc948",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
];

function groupColor(group: number): string {
  if (group < 0) return "#8a8f98";
  return PALETTE[group % PALETTE.length] ?? "#8a8f98";
}

function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

/**
 * Deterministic pseudo-random from a string (FNV-1a), so initial node
 * positions are stable across visits.
 */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

function buildSim(
  state: GraphState,
  nodes: readonly ConceptGraphNode[],
  links: readonly ConceptGraphLink[],
): void {
  const byId = new Map<string, SimNode>(
    nodes.map((n) => [
      n.id,
      {
        ...n,
        x: (hash(n.id) - 0.5) * 1200,
        y: (hash(n.id + "#y") - 0.5) * 1200,
        vx: 0,
        vy: 0,
        // Superlinear-enough exponent that the doc count is obvious at a
        // glance (sqrt made big hubs look barely bigger than leaves).
        r: 2 + PARAMS.nodeSize * n.docs ** 0.8,
      },
    ]),
  );
  state.nodes = [...byId.values()];
  state.links = [];
  for (const link of links) {
    const a = byId.get(link.source);
    const b = byId.get(link.target);
    if (a && b) state.links.push({ a, b, weight: link.weight });
  }
  state.neighbors = new Map();
  for (const { a, b } of state.links) {
    const an = state.neighbors.get(a) ?? new Set<SimNode>();
    const bn = state.neighbors.get(b) ?? new Set<SimNode>();
    an.add(b);
    bn.add(a);
    state.neighbors.set(a, an);
    state.neighbors.set(b, bn);
  }
}

/* ------------------------------------------------------------------ *
 * Simulation
 * ------------------------------------------------------------------ */

function applyLinkForces(state: GraphState): void {
  for (const { a, b, weight } of state.links) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const target = PARAMS.linkDistance * (0.55 + 0.9 / Math.min(weight, 4));
    const f = ((dist - target) / dist) * 0.02 * Math.min(weight, 4);
    a.vx += dx * f;
    a.vy += dy * f;
    b.vx -= dx * f;
    b.vy -= dy * f;
  }
}

function applyRepulsion(state: GraphState): void {
  const nodes = state.nodes;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy || 1;
      if (d2 > 360000) continue;
      const dist = Math.sqrt(d2);
      // Repulsion with a gentle collision core so nodes don't overlap;
      // the kick is capped, otherwise big-radius pairs explode.
      let f = PARAMS.repel / d2;
      const minDist = a.r + b.r + 10;
      if (dist < minDist) f += Math.min(((minDist - dist) / dist) * 0.6, 1.5);
      a.vx -= (dx / dist) * f;
      a.vy -= (dy / dist) * f;
      b.vx += (dx / dist) * f;
      b.vy += (dy / dist) * f;
    }
  }
}

function integrate(state: GraphState): void {
  const centerK = PARAMS.center * 0.0008;
  // Soft outer wall: the linear center pull is too weak to hold
  // disconnected nodes once repulsion pushes them past the cutoff, so
  // beyond this radius an extra inward pull keeps them in a ring
  // instead of stranding them far offscreen.
  const bound = Math.sqrt(state.nodes.length + 1) * 55;
  let travel = 0;
  for (const n of state.nodes) {
    n.vx -= n.x * centerK;
    n.vy -= n.y * centerK;
    const d = Math.hypot(n.x, n.y);
    if (d > bound) {
      const k = ((d - bound) / d) * 0.03;
      n.vx -= n.x * k;
      n.vy -= n.y * k;
    }
    n.vx *= 0.8;
    n.vy *= 0.8;
    n.x += n.vx * state.alpha;
    n.y += n.vy * state.alpha;
    travel += (Math.abs(n.vx) + Math.abs(n.vy)) * state.alpha;
  }
  state.motion = state.nodes.length > 0 ? travel / state.nodes.length : 0;
}

function step(state: GraphState): void {
  applyLinkForces(state);
  applyRepulsion(state);
  integrate(state);
  state.alpha *= 0.985;
}

/**
 * A few synchronous steps before first paint, just enough that the
 * initial frame isn't raw random scatter. The real untangling happens
 * live on screen, so the graph settles visibly instead of freezing.
 */
function preroll(state: GraphState): void {
  state.alpha = 0.9;
  for (let i = 0; i < 40; i++) step(state);
}

/* ------------------------------------------------------------------ *
 * Camera
 * ------------------------------------------------------------------ */

type ViewTarget = { scale: number; tx: number; ty: number };

/**
 * View that fits the layout into the canvas. Uses the 5th-95th percentile
 * of node positions so a few far-flung disconnected components don't
 * shrink the main cluster; outliers stay reachable by panning.
 */
function fitTarget(state: GraphState): ViewTarget | null {
  if (state.nodes.length === 0) return null;
  const xs = state.nodes.map((n) => n.x).sort((a, b) => a - b);
  const ys = state.nodes.map((n) => n.y).sort((a, b) => a - b);
  const q = (arr: number[], p: number): number =>
    arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] ?? 0;
  const minX = q(xs, 0.05);
  const maxX = q(xs, 0.95);
  const minY = q(ys, 0.05);
  const maxY = q(ys, 0.95);
  const pad = 50;
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  const s = Math.min((state.width - pad * 2) / bw, (state.height - pad * 2) / bh, 1.6);
  return {
    scale: s,
    tx: state.width / 2 - ((minX + maxX) / 2) * s,
    ty: state.height / 2 - ((minY + maxY) / 2) * s,
  };
}

/** Jump the view to the fit instantly (first paint, resize). */
function fitView(state: GraphState): void {
  const target = fitTarget(state);
  if (!target) return;
  state.scale = target.scale;
  state.tx = target.tx;
  state.ty = target.ty;
}

/** Ease the view toward the fit instead of snapping. */
function smoothFit(state: GraphState, duration = 700): void {
  const target = fitTarget(state);
  if (!target) return;
  cancelAnimationFrame(state.viewRaf);
  const from = { scale: state.scale, tx: state.tx, ty: state.ty };
  const start = performance.now();
  const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
  const tick = (now: number): void => {
    if (state.disposed) return;
    const k = easeOutCubic(Math.min((now - start) / duration, 1));
    state.scale = from.scale + (target.scale - from.scale) * k;
    state.tx = from.tx + (target.tx - from.tx) * k;
    state.ty = from.ty + (target.ty - from.ty) * k;
    draw(state);
    if (k < 1) state.viewRaf = requestAnimationFrame(tick);
  };
  state.viewRaf = requestAnimationFrame(tick);
}

function resize(state: GraphState): void {
  state.width = state.container.clientWidth;
  state.height = Math.min(Math.max(state.width * 0.75, 380), 620);
  state.canvas.width = state.width * state.dpr;
  state.canvas.height = state.height * state.dpr;
  state.canvas.style.width = `${String(state.width)}px`;
  state.canvas.style.height = `${String(state.height)}px`;
}

/* ------------------------------------------------------------------ *
 * Rendering (labels are occlusion-culled so text never overlaps)
 * ------------------------------------------------------------------ */

function drawLinks(state: GraphState, linkColor: string): void {
  const { ctx, hovered, scale } = state;
  for (const { a, b, weight } of state.links) {
    if (hovered !== null && (a === hovered || b === hovered)) {
      ctx.strokeStyle = groupColor(hovered.group);
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = Math.min(weight, 2) / scale;
    } else {
      ctx.strokeStyle = linkColor;
      const base = Math.min(0.12 + weight * 0.1, 0.6);
      // Fade unrelated links while a node is hovered.
      ctx.globalAlpha = hovered ? base * 0.2 : base;
      ctx.lineWidth = Math.min(weight, 3) / scale;
    }
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawNode(
  state: GraphState,
  n: SimNode,
  hoverNeighbors: Set<SimNode> | null,
  textColor: string,
): void {
  const { ctx, hovered, scale } = state;
  const color = groupColor(n.group);
  const radius = Math.max(n.r, 3 / scale);
  ctx.beginPath();
  // Keep nodes readable when zoomed out: at least ~3px on screen.
  ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
  const dimmed = hovered && n !== hovered && !hoverNeighbors?.has(n);
  ctx.fillStyle = dimmed ? `color-mix(in oklab, ${color}, transparent 80%)` : color;
  ctx.fill();
  if (n === hovered) {
    // Hover highlight: a contrasting ring around the node.
    ctx.beginPath();
    ctx.arc(n.x, n.y, radius + 3 / scale, 0, Math.PI * 2);
    ctx.strokeStyle = textColor;
    ctx.lineWidth = 2 / scale;
    ctx.stroke();
  } else if (hoverNeighbors?.has(n)) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, radius + 2 / scale, 0, Math.PI * 2);
    ctx.strokeStyle = `color-mix(in oklab, ${textColor}, transparent 40%)`;
    ctx.lineWidth = 1.2 / scale;
    ctx.stroke();
  }
}

/** Labels: hovered first, then by doc count; boxes never overlap. */
function labelCandidates(state: GraphState, hoverNeighbors: Set<SimNode> | null): SimNode[] {
  const { hovered, scale } = state;
  return [...state.nodes]
    .filter(
      (n) =>
        n === hovered ||
        hoverNeighbors?.has(n) === true ||
        n.docs >= PARAMS.labelDocs ||
        scale > 1.8,
    )
    .sort((a, b) => {
      if (a === hovered) return -1;
      if (b === hovered) return 1;
      const an = hoverNeighbors?.has(a) ? 1 : 0;
      const bn = hoverNeighbors?.has(b) ? 1 : 0;
      return bn - an || b.docs - a.docs;
    });
}

function drawLabels(
  state: GraphState,
  hoverNeighbors: Set<SimNode> | null,
  textColor: string,
): void {
  const { ctx, scale } = state;
  const fontPx = Math.max(11 / scale, 8);
  ctx.font = `${String(fontPx)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = textColor;
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  for (const n of labelCandidates(state, hoverNeighbors)) {
    const w = ctx.measureText(n.name).width;
    const y = n.y - Math.max(n.r, 3 / scale) - 5 / scale;
    const box = {
      x0: n.x - w / 2 - 2,
      x1: n.x + w / 2 + 2,
      y0: y - fontPx,
      y1: y + 2,
    };
    const overlaps = placed.some(
      (p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0,
    );
    if (n !== state.hovered && overlaps) continue;
    placed.push(box);
    ctx.fillText(n.name, n.x, y);
  }
}

function draw(state: GraphState): void {
  const { ctx, dpr } = state;
  const linkColor = cssColor("--x-border", "#8884");
  const textColor = cssColor("--x-text", "#333");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, state.width, state.height);
  ctx.translate(state.tx, state.ty);
  ctx.scale(state.scale, state.scale);

  const hoverNeighbors = state.hovered
    ? (state.neighbors.get(state.hovered) ?? new Set<SimNode>())
    : null;
  drawLinks(state, linkColor);
  for (const n of state.nodes) drawNode(state, n, hoverNeighbors, textColor);
  drawLabels(state, hoverNeighbors, textColor);
}

/* ------------------------------------------------------------------ *
 * Animation: settles live on screen, then eases the camera to a fit.
 * ------------------------------------------------------------------ */

/**
 * While the layout settles, the camera softly tracks the fit so the
 * expanding graph stays on canvas. Any manual pan/zoom turns it off.
 */
function trackFit(state: GraphState): void {
  if (!state.followFit) return;
  const target = fitTarget(state);
  if (!target) return;
  state.scale += (target.scale - state.scale) * 0.06;
  state.tx += (target.tx - state.tx) * 0.06;
  state.ty += (target.ty - state.ty) * 0.06;
}

function animate(state: GraphState): void {
  if (state.disposed) return;
  if (state.alpha < 0.02) {
    state.animating = false;
    // Refit once the layout settles so nothing is left outside the
    // canvas. Eased, not snapped.
    if (state.followFit) smoothFit(state);
    return;
  }
  step(state);
  // Don't stop on the clock while nodes are still visibly traveling:
  // hold a low simmer until the layout actually comes to rest (with a
  // hard cap so a pathological config can't run forever).
  if (state.alpha < 0.05 && state.motion > 0.3 && state.sustained < 1200) {
    state.alpha = 0.05;
    state.sustained++;
  }
  trackFit(state);
  draw(state);
  state.simRaf = requestAnimationFrame(() => {
    animate(state);
  });
}

function reheat(state: GraphState, energy: number): void {
  state.alpha = energy;
  state.sustained = 0;
  if (!state.animating) {
    state.animating = true;
    state.simRaf = requestAnimationFrame(() => {
      animate(state);
    });
  }
}

/* ------------------------------------------------------------------ *
 * Pointer interaction
 * ------------------------------------------------------------------ */

function nodeAt(state: GraphState, cx: number, cy: number): SimNode | null {
  const x = (cx - state.tx) / state.scale;
  const y = (cy - state.ty) / state.scale;
  for (const n of state.nodes) {
    if (Math.hypot(n.x - x, n.y - y) <= Math.max(n.r, 6 / state.scale)) return n;
  }
  return null;
}

// offsetX/offsetY are unreliable on synthetic events; derive canvas
// coordinates from clientX/clientY instead.
function canvasPos(
  state: GraphState,
  e: { clientX: number; clientY: number },
): { x: number; y: number } {
  const rect = state.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onPointerDown(state: GraphState, e: PointerEvent): void {
  cancelAnimationFrame(state.viewRaf);
  state.followFit = false;
  const p = canvasPos(state, e);
  state.dragging = true;
  state.moved = false;
  state.lastX = p.x;
  state.lastY = p.y;
  state.canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(state: GraphState, e: PointerEvent): void {
  const p = canvasPos(state, e);
  if (state.dragging) {
    state.tx += p.x - state.lastX;
    state.ty += p.y - state.lastY;
    if (Math.abs(p.x - state.lastX) + Math.abs(p.y - state.lastY) > 2) {
      state.moved = true;
    }
    state.lastX = p.x;
    state.lastY = p.y;
    draw(state);
    return;
  }
  const hit = nodeAt(state, p.x, p.y);
  if (hit !== state.hovered) {
    state.hovered = hit;
    state.canvas.style.cursor = hit ? "pointer" : "grab";
    draw(state);
  }
}

function onPointerLeave(state: GraphState): void {
  if (state.hovered) {
    state.hovered = null;
    state.canvas.style.cursor = "grab";
    draw(state);
  }
}

function onPointerUp(state: GraphState, e: PointerEvent): void {
  const p = canvasPos(state, e);
  state.dragging = false;
  if (!state.moved) {
    const hit = nodeAt(state, p.x, p.y);
    if (hit) state.onNavigate(hit.id);
  }
}

function onWheel(state: GraphState, e: WheelEvent): void {
  e.preventDefault();
  cancelAnimationFrame(state.viewRaf);
  state.followFit = false;
  const p = canvasPos(state, e);
  const factor = Math.exp(-e.deltaY * 0.0015);
  const next = Math.min(Math.max(state.scale * factor, 0.2), 5);
  // Zoom around the cursor.
  state.tx = p.x - ((p.x - state.tx) / state.scale) * next;
  state.ty = p.y - ((p.y - state.ty) / state.scale) * next;
  state.scale = next;
  draw(state);
}

function attachListeners(state: GraphState): () => void {
  const down = (e: PointerEvent): void => {
    onPointerDown(state, e);
  };
  const move = (e: PointerEvent): void => {
    onPointerMove(state, e);
  };
  const leave = (): void => {
    onPointerLeave(state);
  };
  const up = (e: PointerEvent): void => {
    onPointerUp(state, e);
  };
  const wheel = (e: WheelEvent): void => {
    onWheel(state, e);
  };
  const onResize = (): void => {
    resize(state);
    fitView(state);
    draw(state);
  };
  state.canvas.addEventListener("pointerdown", down);
  state.canvas.addEventListener("pointermove", move);
  state.canvas.addEventListener("pointerleave", leave);
  state.canvas.addEventListener("pointerup", up);
  state.canvas.addEventListener("wheel", wheel, { passive: false });
  window.addEventListener("resize", onResize);
  return () => {
    state.canvas.removeEventListener("pointerdown", down);
    state.canvas.removeEventListener("pointermove", move);
    state.canvas.removeEventListener("pointerleave", leave);
    state.canvas.removeEventListener("pointerup", up);
    state.canvas.removeEventListener("wheel", wheel);
    window.removeEventListener("resize", onResize);
  };
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

function initGraph(
  canvas: HTMLCanvasElement,
  nodes: readonly ConceptGraphNode[],
  links: readonly ConceptGraphLink[],
  onNavigate: (id: string) => void,
): (() => void) | undefined {
  const container = canvas.parentElement;
  const ctx = canvas.getContext("2d");
  if (!container || !ctx) return undefined;
  const state: GraphState = {
    canvas,
    container,
    ctx,
    dpr: window.devicePixelRatio > 0 ? window.devicePixelRatio : 1,
    onNavigate,
    nodes: [],
    links: [],
    neighbors: new Map(),
    width: 0,
    height: 0,
    scale: 1,
    tx: 0,
    ty: 0,
    alpha: 0,
    motion: 0,
    sustained: 0,
    animating: false,
    followFit: true,
    hovered: null,
    dragging: false,
    moved: false,
    lastX: 0,
    lastY: 0,
    simRaf: 0,
    viewRaf: 0,
    disposed: false,
  };
  canvas.style.cursor = "grab";
  resize(state);
  buildSim(state, nodes, links);
  preroll(state);
  // First paint jumps straight to the fit; afterwards the per-frame
  // tracking glides there while the layout settles live on screen.
  fitView(state);
  draw(state);
  reheat(state, 0.9);
  const detach = attachListeners(state);
  return () => {
    state.disposed = true;
    cancelAnimationFrame(state.simRaf);
    cancelAnimationFrame(state.viewRaf);
    detach();
  };
}

/** Canvas force graph of the concept vocabulary; clicks report the node id. */
export function ConceptGraph({ nodes, links, onNavigate }: ConceptGraphProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    return initGraph(canvas, nodes, links, onNavigate);
  }, [nodes, links, onNavigate]);

  return (
    <div className="x-graph-frame w-full">
      <canvas
        ref={canvasRef}
        aria-label="Force-directed graph of concepts"
        className="block w-full touch-none"
      />
    </div>
  );
}
