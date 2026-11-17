const MAX_SELECTOR_LENGTH = 120;

export function describeTarget(target: EventTarget | null): string {
  if (!target || !isElement(target)) {
    return "unknown";
  }

  const tag = target.tagName.toLowerCase();
  const id = target.id ? `#${safeToken(target.id)}` : "";
  const testId = target.getAttribute("data-testid");
  const testIdPart = testId ? `[data-testid="${safeToken(testId)}"]` : "";
  const role = target.getAttribute("role");
  const rolePart = role ? `[role="${safeToken(role)}"]` : "";
  const name = target.getAttribute("aria-label") ?? target.getAttribute("name");
  const namePart = name ? `[name="${safeToken(name)}"]` : "";
  const text = textSummary(target.textContent);
  const textPart = text ? ` text="${text}"` : "";
  const selector = `${tag}${id}${testIdPart}${rolePart}${namePart}${textPart}`;

  return selector.length > MAX_SELECTOR_LENGTH ? `${selector.slice(0, MAX_SELECTOR_LENGTH)}...` : selector;
}

export function sameArea(a: PointerSample, b: PointerSample, radiusPx: number): boolean {
  if (a.selector !== b.selector) {
    return false;
  }

  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy) <= radiusPx;
}

export interface PointerSample {
  selector: string;
  x: number;
  y: number;
  at: number;
}

function isElement(value: EventTarget): value is Element {
  return "tagName" in value;
}

function safeToken(value: string): string {
  return value.replace(/\s+/g, " ").replace(/["\\]/g, "").trim().slice(0, 60);
}

function textSummary(value: string | null): string {
  if (!value) {
    return "";
  }

  return safeToken(value).slice(0, 40);
}
