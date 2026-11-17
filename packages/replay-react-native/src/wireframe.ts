import type { WireframeFrame, WireframeNode } from "@jaytrace/replay-core";
import type { ReactNativeViewTreeNode, ReactNativeViewTreePropPrimitive } from "./types.js";

// ponytail: caps mirror the Flutter wireframe serializer (Phase 2) — keeps
// worst-case traversal/upload cost bounded the same way across platforms.
const MAX_DEPTH = 40;
const MAX_NODES = 1000;

const CONTAINER_TYPES = new Set(["View", "RCTView", "ScrollView"]);
const TEXT_TYPES = new Set(["Text", "RCTText"]);
const IMAGE_TYPES = new Set(["Image", "RCTImage", "RCTImageView"]);

type NodeProps = ReactNativeViewTreeNode["props"];
type FlatProps = Record<string, ReactNativeViewTreePropPrimitive> | undefined;

function styleOf(props: NodeProps): FlatProps {
  const style = props?.style;
  return style && typeof style === "object" ? style : undefined;
}

function stringProp(props: NodeProps | FlatProps, key: string): string | undefined {
  const value = props?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberProp(props: NodeProps | FlatProps, key: string): number | undefined {
  const value = props?.[key];
  return typeof value === "number" ? value : undefined;
}

function nodeFor(node: ReactNativeViewTreeNode, maskText: boolean): WireframeNode | undefined {
  const bounds = node.bounds;
  if (!bounds) {
    return undefined;
  }
  const base = { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
  const props = node.props;
  const style = styleOf(props);

  if (TEXT_TYPES.has(node.type)) {
    const text = stringProp(props, "children") ?? stringProp(props, "text") ?? "";
    const fontSize = numberProp(style, "fontSize");
    const color = stringProp(style, "color");
    return {
      type: "text",
      ...base,
      chars: text.length,
      ...(fontSize !== undefined ? { fontSize } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(maskText ? {} : { text })
    };
  }

  if (IMAGE_TYPES.has(node.type)) {
    return { type: "image", ...base };
  }

  if (CONTAINER_TYPES.has(node.type)) {
    const bg = stringProp(props, "backgroundColor") ?? stringProp(style, "backgroundColor");
    if (bg === undefined) {
      return undefined;
    }
    const radius = numberProp(props, "borderRadius") ?? numberProp(style, "borderRadius");
    return {
      type: "rect",
      ...base,
      bg,
      ...(radius !== undefined ? { radius } : {})
    };
  }

  return undefined;
}

function walk(node: ReactNativeViewTreeNode, maskText: boolean, depth: number, nodes: WireframeNode[]): void {
  if (depth > MAX_DEPTH || nodes.length >= MAX_NODES) {
    return;
  }
  const emitted = nodeFor(node, maskText);
  if (emitted) {
    nodes.push(emitted);
  }
  // depth counts nesting of *emitted* primitives, not raw view-tree recursion
  // (matches Flutter's serializer): a chain of bounds-less wrapper Views
  // doesn't burn the depth budget before reaching real content.
  const childDepth = emitted ? depth + 1 : depth;
  for (const child of node.children ?? []) {
    if (nodes.length >= MAX_NODES) {
      break;
    }
    walk(child, maskText, childDepth, nodes);
  }
}

/**
 * Walks a React Native view tree (DFS, paint order) and serializes it to
 * wireframe primitives. A node without `bounds` emits nothing itself but its
 * children are still visited (bounds come from `measureInWindow`, which not
 * every captured node will have resolved).
 */
export function viewTreeToWireframeNodes(node: ReactNativeViewTreeNode, opts: { maskText: boolean }): WireframeNode[] {
  const nodes: WireframeNode[] = [];
  walk(node, opts.maskText, 0, nodes);
  return nodes;
}

export function buildWireframeFrame(
  root: ReactNativeViewTreeNode,
  opts: {
    maskText: boolean;
    atMs: number;
    viewport: { width: number; height: number };
    pointer?: { x: number; y: number; kind: "tap" | "move" };
  }
): WireframeFrame {
  return {
    atMs: opts.atMs,
    viewport: opts.viewport,
    ...(opts.pointer ? { pointer: opts.pointer } : {}),
    nodes: viewTreeToWireframeNodes(root, { maskText: opts.maskText })
  };
}
