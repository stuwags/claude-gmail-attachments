/**
 * The four DOM helpers the chrome actually needs.
 *
 * `setText` / `setAttr` write only when the value changed, which is what keeps
 * `Hud.update` cheap enough to call on every state change without churning
 * layout or resetting a transition mid-flight.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setAttr(node: Element, name: string, value: string | null): void {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value);
  }
}

/**
 * Hide for the eye, the pointer, the tab order and the screen reader at once,
 * while leaving the element in the layout so its enter/leave transition still
 * runs. `inert` is what takes it out of the tab order; `aria-hidden` takes it
 * out of the accessibility tree.
 */
export function setHidden(node: HTMLElement, hidden: boolean): void {
  setAttr(node, 'data-hidden', hidden ? '' : null);
  setAttr(node, 'aria-hidden', hidden ? 'true' : null);
  setAttr(node, 'inert', hidden ? '' : null);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A 20x20 stroked glyph on a 24-unit grid, inheriting `currentColor`. */
export function icon(shapes: readonly (readonly [string, Record<string, string>])[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.appendChild(shape);
  }
  return svg;
}
