import { maskReplayInput, maskReplayText, sanitizeReplayLine, type ReplayMutation } from "@jaytrace/replay-core";

export function elementLabel(target: EventTarget | null, maskText: boolean): string {
  if (!target || !isElement(target)) {
    return "unknown";
  }

  const tag = target.tagName.toLowerCase();
  const id = target.id ? `#${clean(target.id)}` : "";
  const testId = target.getAttribute("data-testid");
  const test = testId ? `[data-testid="${clean(testId)}"]` : "";
  const role = target.getAttribute("role");
  const roleText = role ? `[role="${clean(role)}"]` : "";
  const text = maskReplayText(target.textContent ?? "", maskText);
  const suffix = text ? ` text=${text}` : "";

  return `${tag}${id}${test}${roleText}${suffix}`.slice(0, 160);
}

export function inputLine(target: EventTarget | null, maskInputs: boolean): string | null {
  if (!target || !isInputLike(target)) {
    return null;
  }

  const label = elementLabel(target, true);
  return `input ${label} value=${maskReplayInput(target.value, maskInputs)}`;
}

export function mutationLine(record: MutationRecord, maskText: boolean): string {
  if (isHiddenNode(record.target)) {
    return `dom hidden ${record.type}`;
  }
  const target = elementLabel(record.target, maskText);
  if (record.type === "attributes") {
    return `dom ${target} attr=${record.attributeName ?? "unknown"}`;
  }

  return `dom ${target} children added=${record.addedNodes.length} removed=${record.removedNodes.length}`;
}

export function mutationDiff(record: MutationRecord, maskText: boolean): Omit<ReplayMutation, "at"> {
  if (isHiddenNode(record.target)) {
    return {
      target: "hidden",
      type: record.type,
      addedHtml: [],
      removedCount: 0
    } as Omit<ReplayMutation, "at">;
  }
  const target = elementLabel(record.target, maskText);
  const targetPath = isElement(record.target) ? elementPath(record.target) : undefined;
  if (record.type === "attributes") {
    const element = isElement(record.target) ? record.target : null;
    const attributeName = record.attributeName ?? "unknown";
    const value = element?.getAttribute(attributeName);
    return {
      target,
      targetPath,
      type: "attributes",
      attributeName,
      value: mutationAttributeValue(attributeName, value, isMaskedNode(record.target))
    };
  }

  return {
    target,
    targetPath,
    type: "childList",
    addedHtml: Array.from(record.addedNodes).slice(0, 3).map(nodeHtml(maskText)).filter(Boolean),
    removedCount: record.removedNodes.length
  };
}

function elementPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement) {
    const id = current.id ? `#${cssEscape(current.id)}` : "";
    const testId = current.getAttribute("data-testid");
    const test = testId ? `[data-testid="${cssEscape(testId)}"]` : "";
    const tag = current.tagName.toLowerCase();
    parts.unshift(id ? `${tag}${id}` : test ? `${tag}${test}` : `${tag}:nth-of-type(${elementIndex(current)})`);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function elementIndex(element: Element): number {
  let index = 1;
  let sibling = element.previousElementSibling;
  while (sibling) {
    if (sibling.tagName === element.tagName) {
      index += 1;
    }
    sibling = sibling.previousElementSibling;
  }
  return index;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function isElement(value: EventTarget): value is Element {
  return "tagName" in value;
}

function isInputLike(value: EventTarget): value is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return (
    value instanceof HTMLInputElement ||
    value instanceof HTMLTextAreaElement ||
    value instanceof HTMLSelectElement
  );
}

function clean(value: string): string {
  return value.replace(/["\\\s]+/g, " ").trim().slice(0, 80);
}

function mutationAttributeValue(name: string, value: string | null | undefined, masked: boolean): string | null | undefined {
  if (value === null || value === undefined) {
    return value;
  }
  if (masked || sensitiveAttribute(name)) {
    return maskReplayText(value, true);
  }
  return sanitizeReplayLine(value);
}

function sensitiveAttribute(name: string): boolean {
  return ["authorization", "cookie", "password", "secret", "token", "value"].some(part => name.toLowerCase().includes(part));
}

function nodeHtml(maskText: boolean): (node: Node) => string {
  return (node: Node) => {
    if (isHiddenNode(node)) {
      return "";
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return maskReplayText(node.textContent ?? "", maskText || isMaskedNode(node));
    }
    if (node instanceof Element) {
      const clone = node.cloneNode(true);
      if (clone instanceof Element) {
        scrubHidden(clone);
        if (maskText || isMaskedNode(node)) {
          clone.textContent = maskReplayText(clone.textContent ?? "", true);
        } else {
          scrubMasked(clone);
        }
        return clone.outerHTML.slice(0, 500);
      }
    }
    return node.nodeName;
  };
}

function isHiddenNode(node: Node): boolean {
  return Boolean(closestElement(node, "[data-jaytrace-hidden]"));
}

function isMaskedNode(node: Node): boolean {
  return Boolean(closestElement(node, "[data-jaytrace-mask]"));
}

function closestElement(node: Node, selector: string): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest?.(selector) ?? null;
}

function scrubHidden(element: Element): void {
  element.querySelectorAll?.("[data-jaytrace-hidden]").forEach(node => node.remove());
}

function scrubMasked(element: Element): void {
  element.querySelectorAll?.("[data-jaytrace-mask]").forEach(node => {
    node.textContent = maskReplayText(node.textContent ?? "", true);
  });
}
