// ============================================================================
// rich-text.js — Free Telegram rich-message helpers (HTML parse_mode)
// ============================================================================
// Provides bordered <blockquote> sections, bold <b> headings, monospace
// <pre> tables, and consistent field labels so every bot message looks clean,
// structured and professional — matching Telegram's Rich Text Demo style.
// Zero cost, no external APIs, works with existing telegraf HTML rendering.

export const DIVIDER = '━━━━━━━━━━━━━━━';
export const SECTION_GAP = '\n';

export function esc(str = '') {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Bold heading
export function heading(text) {
  return `<b>${esc(text)}</b>`;
}

// Subtle subtext line
export function sub(text) {
  return `<i>${esc(text)}</i>`;
}

// Field line: <b>Label:</b> value
export function field(label, value) {
  return `<b>${esc(label)}:</b> ${esc(value)}`;
}

// Bullet item
export function bullet(text) {
  return `• ${esc(text)}`;
}

// Bordered section block (Telegram <blockquote> renders as a card with a left border).
// `body` is trusted internal HTML already built with esc()/field()/table()/heading()/sub().
export function section(title, body) {
  const t = title ? `${heading(title)}\n` : '';
  return `<blockquote>${t}${body}</blockquote>\n`;
}

// Bordered card: title + multiple body lines joined by newline
export function card(title, ...lines) {
  return section(title, lines.filter(Boolean).join('\n'));
}

// Monospace aligned table (rows = array of column string arrays)
// Renders as a clean <pre> table with rows and columns.
export function table(rows) {
  if (!rows || rows.length === 0) return '';
  const colCount = Math.max(...rows.map(r => r.length));
  const widths = Array(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(widths[c], String(row[c] ?? '').length);
    }
  }
  const lines = rows.map((row) => {
    const cells = row.map((cell, c) => String(cell ?? '').padEnd(widths[c]));
    return cells.join('  ');
  });
  return `<pre>${lines.join('\n')}</pre>\n`;
}

// Standalone section divider
export function divider() {
  return `${DIVIDER}\n`;
}

// A full clean message wrapper: heading + sections + footer note
export function message(title, sections = [], footer = '') {
  const parts = [];
  if (title) parts.push(heading(title), divider());
  for (const s of sections) parts.push(s);
  if (footer) parts.push(divider(), sub(footer));
  return parts.join('\n');
}
