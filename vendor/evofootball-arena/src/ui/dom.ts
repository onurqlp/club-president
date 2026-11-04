/** Tiny DOM helpers — panels are plain DOM, no framework. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', cls, label);
  b.addEventListener('click', onClick);
  return b;
}

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const wrap = el('label', 'chk');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.append(input, document.createTextNode(' ' + label));
  return wrap;
}

export const colorHex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

/** Escape &, <, > for interpolation into innerHTML or inline SVG markup. */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A labeled 0..1 horizontal bar; returns the wrapper and a setter. */
export function bar(value: number, color: string): HTMLDivElement {
  const outer = el('div', 'bar');
  const inner = el('div', 'bar-fill');
  inner.style.width = `${Math.round(value * 100)}%`;
  inner.style.background = color;
  outer.appendChild(inner);
  return outer;
}
