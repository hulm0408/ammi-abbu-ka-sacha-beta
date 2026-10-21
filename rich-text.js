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

// Monospace bordered table (rows = array of column string arrays)
// Draws full grid borders using Unicode box-drawing characters, matching
// Telegram's Rich Text Demo table style: bordered rows/columns, bold header.
// Zero cost, no external APIs — pure <pre> + box-drawing characters.
export function table(rows) {
  if (!rows || rows.length === 0) return '';
  const colCount = Math.max(...rows.map(r => r.length));
  const widths = Array(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(widths[c], String(row[c] ?? '').length);
    }
  }

  const pad = (s) => ` ${String(s ?? '')} `;
  const hline = (left, mid, right) => {
    const segs = widths.map(w => '─'.repeat(w + 2));
    return [left, ...segs.map((seg, i) => i < colCount - 1 ? seg + mid : seg + right)].join('');
  };

  const top = hline('┌', '┬', '┐');
  const mid = hline('├', '┼', '┤');
  const bot = hline('└', '┴', '┘');

  const rowLine = (cells, isHeader = false) => {
    const parts = cells.map((cell, c) => pad(isHeader ? `<b>${cell}</b>` : cell).padEnd(widths[c] + 2));
    return `│${parts.join('│')}│`;
  };

  const lines = [top];
  lines.push(rowLine(rows[0], true)); // header row (bold)
  lines.push(mid);
  for (let i = 1; i < rows.length; i++) {
    lines.push(rowLine(rows[i]));
    if (i < rows.length - 1) lines.push(mid);
  }
  lines.push(bot);

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

// Clean OTP Sent card — matches ORDER PLACER style: bold label + value, no ━━━
export function otpSentCard(phone, extraLines = []) {
  const lines = [
    `<b>📲 OTP Sent</b>`,
    `📱 <b>Number:</b> <code>${esc(phone)}</code>`,
    ...extraLines
  ];
  return section('🔐 Swiggy Login OTP', lines.join('\n'));
}

// Clean OTP error / verification failed card — matches ORDER PLACER style
export function otpErrorCard(phone, swiggyResponse, hint = 'Sahi 6-digit OTP dubara type karein ya neeche Re-enter OTP dabayein:') {
  return section('❌ OTP Verification Failed', [
    `📱 <b>Number:</b> <code>${esc(phone)}</code>`,
    '',
    `⚠️ <b>Swiggy Response:</b>`,
    `<blockquote>${esc(swiggyResponse)}</blockquote>`,
    '',
    `👉 <i>${esc(hint)}</i>`,
  ].join('\n'));
}

// Clean Boss Panel fallback card
export function bossPanelCard(bodyLines = []) {
  return section('👑 Boss Panel', [
    `👋 Boss, use the menu buttons below:`,
    ...bodyLines,
  ].filter(Boolean).join('\n'));
}
