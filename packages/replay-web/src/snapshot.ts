import { maskReplayInput, maskReplayText } from "@jaytrace/replay-core";

export function snapshotHtml(maskText: boolean, maskInputs: boolean, maxBytes = 768_000): string {
  try {
    if (typeof document === "undefined" || !document.body) {
      return "";
    }

    const clone = document.body.cloneNode(true);
    if (!isElement(clone)) {
      return "";
    }

    cleanNode(clone, maskText, maskInputs);

    const html = `<!doctype html><html${safeAttributes(document.documentElement)}><head><meta charset="utf-8">${baseHref()}${headStyles()}<style>${baseCss()}</style></head><body${safeAttributes(clone)}>${clone.innerHTML}</body></html>`;
    return byteLength(html) <= maxBytes ? html : "";
  } catch {
    return "";
  }
}

function cleanNode(node: Node, maskText: boolean, maskInputs: boolean): void {
  if (node.nodeType === Node.TEXT_NODE) {
    node.textContent = maskReplayText(node.textContent ?? "", maskText);
    return;
  }

  if (!isElement(node)) {
    return;
  }

  if (["SCRIPT", "NOSCRIPT", "IFRAME"].includes(node.tagName)) {
    node.remove();
    return;
  }

  if (node.hasAttribute("data-jaytrace-hidden")) {
    node.remove();
    return;
  }

  const maskSubtree = maskText || node.hasAttribute("data-jaytrace-mask");

  for (const attribute of Array.from(node.attributes)) {
    scrubAttribute(node, attribute, maskSubtree);
  }

  if (isInput(node)) {
    node.setAttribute("value", maskReplayInput(node.value, maskInputs));
  }

  for (const child of Array.from(node.childNodes)) {
    cleanNode(child, maskSubtree, maskInputs);
  }
}

function scrubAttribute(node: Element, attribute: Attr, maskText: boolean): void {
  const name = attribute.name.toLowerCase();
  if (name.startsWith("on") || name === "srcdoc") {
    node.removeAttribute(attribute.name);
    return;
  }
  if (name.startsWith("data-") && !["data-testid", "data-theme", "data-jaytrace-mask", "data-jaytrace-hidden"].includes(name)) {
    node.removeAttribute(attribute.name);
    return;
  }
  if (sensitiveAttribute(name)) {
    node.setAttribute(attribute.name, "redacted");
    return;
  }
  if (maskText && ["aria-label", "alt", "placeholder", "title"].includes(name)) {
    node.setAttribute(attribute.name, "redacted");
    return;
  }
  if (["href", "src", "action", "poster"].includes(name)) {
    const safeUrl = sanitizedUrl(attribute.value);
    if (safeUrl) {
      node.setAttribute(attribute.name, safeUrl);
    } else {
      node.removeAttribute(attribute.name);
    }
  }
}

function sensitiveAttribute(name: string): boolean {
  return name === "value" || ["authorization", "cookie", "password", "secret", "token"].some(part => name.includes(part));
}

function sanitizedUrl(value: string): string {
  if (value.startsWith("data:")) {
    return "";
  }
  try {
    const url = new URL(value, window.location.href);
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return value.split("?")[0]?.split("#")[0] ?? "";
  }
}

function baseCss(): string {
  return `
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #172033; background: #f5f7fb; }
    button, input, select, textarea { font: inherit; }
    button { cursor: default; }
  `;
}

function safeAttributes(element: Element): string {
  const attributes = Array.from(element.attributes)
    .filter(attribute => ["class", "style", "lang", "dir", "data-theme"].includes(attribute.name))
    .map(attribute => `${attribute.name}="${escapeAttribute(attribute.value)}"`);
  return attributes.length ? ` ${attributes.join(" ")}` : "";
}

function headStyles(): string {
  return Array.from(document.head?.querySelectorAll("style,link[rel='stylesheet']") ?? [])
    .slice(0, 50)
    .map(headStyleHtml)
    .join("");
}

function headStyleHtml(node: Element): string {
  if (node.tagName === "STYLE") {
    return node.outerHTML;
  }
  const href = node.getAttribute("href");
  return href && sameOrigin(href) ? node.outerHTML : "";
}

function sameOrigin(href: string): boolean {
  try {
    const base = window.location.href;
    return new URL(href, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function baseHref(): string {
  const href = typeof window === "undefined" ? "" : window.location?.href ?? "";
  return href ? `<base href="${escapeAttribute(href)}">` : "";
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function isElement(value: Node): value is Element {
  return value.nodeType === Node.ELEMENT_NODE;
}

function isInput(value: Element): value is HTMLInputElement | HTMLTextAreaElement {
  return value instanceof HTMLInputElement || value instanceof HTMLTextAreaElement;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
