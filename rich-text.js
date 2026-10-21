// ============================================================================
// rich-text.js — Free Telegram rich-message helpers (HTML parse_mode)
// ============================================================================
// Provides bordered <blockquote> sections, bold <b> headings, monospace
// <pre> tables, and consistent field labels so every bot message looks clean,
// structured and professional — matching Telegram's Rich Text Demo style.
// Zero cost, no external APIs, works with existing telegraf HTML rendering.

export const DIVIDER = '──────────────────────────────';
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

// Simple text table with dash separators — clean Telegram styling.
// Uses normal text with icons, <pre> monospace, bold headers, and dash lines.
// No box-drawing characters. Zero cost, no external APIs.
export function table(rows) {
  if (!rows || rows.length === 0) return '';
  const colCount = Math.max(...rows.map(r => r.length));
  const widths = Array(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(widths[c], String(row[c] ?? '').length);
    }
  }

  const pad = (s, w) => ` ${String(s ?? '')} `.padEnd(w + 2);
  const totalWidth = widths.reduce((a, b) => a + b, 0) + colCount * 3 + 1;
  const sep = '─'.repeat(totalWidth);

  const lines = [];
  lines.push(sep);
  lines.push(rows[0].map((c, i) => pad(`<b>${esc(c)}</b>`, widths[i])).join('│'));
  lines.push(sep);
  for (let i = 1; i < rows.length; i++) {
    lines.push(rows[i].map((c, i) => pad(esc(c), widths[i])).join('│'));
    if (i < rows.length - 1) lines.push(sep);
  }
  lines.push(sep);

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
