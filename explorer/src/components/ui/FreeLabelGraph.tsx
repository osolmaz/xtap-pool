/**
 * Interactive force-directed graph for approved free labels. This is the
 * renamed projection of the former reusable ConceptGraph: only the public
 * data source changed, while canvas rendering, pan/zoom, hover, and node
 * navigation remain part of the explorer experience.
 */
import { useEffect, useRef } from "react";

export type FreeLabelGraphNode = {
  id: string;
  name: string;
  docs: number;
  group: number;
};

export type FreeLabelGraphLink = {
  source: string;
  target: string;
  weight: number;
};

export type FreeLabelGraphProps = {
  nodes: readonly FreeLabelGraphNode[];
  links: readonly FreeLabelGraphLink[];
  onNavigate: (name: string) => void;
};

type SimNode = FreeLabelGraphNode & {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
};
type SimLink = { source: SimNode; target: SimNode; weight: number };

const COLORS = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#b07aa1", "#76b7b2"];

function color(group: number): string {
  return group < 0 ? "#8a8f98" : (COLORS[group % COLORS.length] ?? "#8a8f98");
}

function hash(value: string): number {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return (result >>> 0) / 0xffffffff;
}

function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("graph element unavailable");
  return value;
}

function buildNodes(nodes: readonly FreeLabelGraphNode[]): SimNode[] {
  return nodes.map((node) => {
    const angle = hash(node.id) * Math.PI * 2;
    const distance = 100 + hash(`${node.id}:distance`) * 220;
    return {
      ...node,
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance,
      vx: 0,
      vy: 0,
      radius: 5 + Math.sqrt(Math.max(node.docs, 1)) * 2,
    };
  });
}

function buildLinks(nodes: readonly SimNode[], links: readonly FreeLabelGraphLink[]): SimLink[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return links.flatMap((link) => {
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    return source === undefined || target === undefined
      ? []
      : [{ source, target, weight: link.weight }];
  });
}

function applyLinks(links: readonly SimLink[]): void {
  for (const link of links) {
    const dx = link.target.x - link.source.x;
    const dy = link.target.y - link.source.y;
    const distance = Math.hypot(dx, dy) || 1;
    const pull = ((distance - 86) / distance) * 0.025 * Math.min(link.weight, 4);
    link.source.vx += dx * pull;
    link.source.vy += dy * pull;
    link.target.vx -= dx * pull;
    link.target.vy -= dy * pull;
  }
}

function applyRepulsion(nodes: readonly SimNode[]): void {
  for (let first = 0; first < nodes.length; first += 1) {
    for (let second = first + 1; second < nodes.length; second += 1) {
      const a = nodes[first];
      const b = nodes[second];
      if (a === undefined || b === undefined) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const squaredDistance = dx * dx + dy * dy || 1;
      if (squaredDistance > 160_000) continue;
      const force = Math.min(9000 / squaredDistance, 2);
      const distance = Math.sqrt(squaredDistance);
      a.vx -= (dx / distance) * force;
      a.vy -= (dy / distance) * force;
      b.vx += (dx / distance) * force;
      b.vy += (dy / distance) * force;
    }
  }
}

function step(nodes: readonly SimNode[], links: readonly SimLink[], temperature: number): void {
  applyLinks(links);
  applyRepulsion(nodes);
  for (const node of nodes) {
    node.vx = (node.vx - node.x * 0.001) * 0.82;
    node.vy = (node.vy - node.y * 0.001) * 0.82;
    node.x += node.vx * temperature;
    node.y += node.vy * temperature;
  }
}

type View = { scale: number; x: number; y: number };

function fit(nodes: readonly SimNode[], width: number, height: number): View {
  if (nodes.length === 0) return { scale: 1, x: width / 2, y: height / 2 };
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = Math.min(
    (width - 72) / Math.max(maxX - minX, 1),
    (height - 72) / Math.max(maxY - minY, 1),
    1.5,
  );
  return {
    scale,
    x: width / 2 - ((minX + maxX) / 2) * scale,
    y: height / 2 - ((minY + maxY) / 2) * scale,
  };
}

function hitNode(nodes: readonly SimNode[], view: View, x: number, y: number): SimNode | undefined {
  const graphX = (x - view.x) / view.scale;
  const graphY = (y - view.y) / view.scale;
  return nodes.find(
    (node) => Math.hypot(node.x - graphX, node.y - graphY) <= node.radius + 4 / view.scale,
  );
}

/** Canvas force graph of approved free-label co-occurrence; click a node to open it. */
export function FreeLabelGraph({
  nodes: sourceNodes,
  links: sourceLinks,
  onNavigate,
}: FreeLabelGraphProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const container = canvas?.parentElement;
    if (canvas === null || context === null || container === null) return undefined;
    const graphContext = requireValue(context);
    const graphContainer = requireValue(container);
    const nodes = buildNodes(sourceNodes);
    const links = buildLinks(nodes, sourceLinks);
    let width = 0;
    let height = 0;
    let view: View = { scale: 1, x: 0, y: 0 };
    let hovered: SimNode | undefined;
    let dragging = false;
    let moved = false;
    let last = { x: 0, y: 0 };
    let frame = 0;
    let temperature = 0.95;
    const dpr = window.devicePixelRatio || 1;

    const draw = (): void => {
      graphContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      graphContext.clearRect(0, 0, width, height);
      graphContext.translate(view.x, view.y);
      graphContext.scale(view.scale, view.scale);
      for (const link of links) {
        graphContext.beginPath();
        graphContext.moveTo(link.source.x, link.source.y);
        graphContext.lineTo(link.target.x, link.target.y);
        graphContext.strokeStyle = "#8a8f9880";
        graphContext.lineWidth = Math.min(link.weight, 3) / view.scale;
        graphContext.stroke();
      }
      for (const node of nodes) {
        graphContext.beginPath();
        graphContext.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        graphContext.fillStyle = color(node.group);
        graphContext.fill();
        if (node === hovered) {
          graphContext.strokeStyle = "#1f2937";
          graphContext.lineWidth = 2 / view.scale;
          graphContext.stroke();
        }
      }
      graphContext.fillStyle = "#374151";
      graphContext.font = `${String(Math.max(10 / view.scale, 8))}px system-ui, sans-serif`;
      graphContext.textAlign = "center";
      for (const node of nodes) {
        if (node.docs >= 3 || node === hovered || view.scale > 1.8) {
          graphContext.fillText(node.name, node.x, node.y - node.radius - 5 / view.scale);
        }
      }
    };
    const resize = (): void => {
      width = Math.max(graphContainer.clientWidth, 320);
      height = Math.min(Math.max(width * 0.72, 380), 620);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.height = `${String(height)}px`;
      view = fit(nodes, width, height);
      draw();
    };
    const position = (event: PointerEvent | WheelEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const animate = (): void => {
      if (temperature > 0.015) {
        step(nodes, links, temperature);
        temperature *= 0.985;
        draw();
        frame = requestAnimationFrame(animate);
      }
    };
    const down = (event: PointerEvent): void => {
      dragging = true;
      moved = false;
      last = position(event);
      canvas.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent): void => {
      const next = position(event);
      if (dragging) {
        moved ||= Math.abs(next.x - last.x) + Math.abs(next.y - last.y) > 2;
        view = { ...view, x: view.x + next.x - last.x, y: view.y + next.y - last.y };
        last = next;
        draw();
        return;
      }
      hovered = hitNode(nodes, view, next.x, next.y);
      canvas.style.cursor = hovered === undefined ? "grab" : "pointer";
      draw();
    };
    const up = (event: PointerEvent): void => {
      dragging = false;
      if (!moved) {
        const node = hitNode(nodes, view, position(event).x, position(event).y);
        if (node !== undefined) onNavigate(node.id);
      }
    };
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const point = position(event);
      const scale = Math.min(Math.max(view.scale * Math.exp(-event.deltaY * 0.0015), 0.2), 5);
      view = {
        scale,
        x: point.x - ((point.x - view.x) / view.scale) * scale,
        y: point.y - ((point.y - view.y) / view.scale) * scale,
      };
      draw();
    };
    canvas.style.cursor = "grab";
    resize();
    for (let iteration = 0; iteration < 30; iteration += 1) step(nodes, links, 0.85);
    view = fit(nodes, width, height);
    draw();
    frame = requestAnimationFrame(animate);
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("resize", resize);
    return (): void => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("wheel", wheel);
      window.removeEventListener("resize", resize);
    };
  }, [sourceNodes, sourceLinks, onNavigate]);

  return (
    <div className="x-graph-frame w-full">
      <canvas
        ref={canvasRef}
        aria-label="Force-directed graph of approved free labels"
        className="block w-full touch-none"
      />
    </div>
  );
}
