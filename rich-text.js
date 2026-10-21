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

// Native HTML table — matches Telegram Rich Text Demo exactly.
// Uses <table><tr><th>...</th></tr><tr><td>...</td></tr></table> so Telegram renders
// real bordered grid with bold header rows. Zero cost, no external APIs.
export function table(rows) {
  if (!rows || rows.length === 0) return '';
  const header = rows[0].map(c => `<th>${esc(c)}</th>`).join('');
  const body = rows.slice(1).map(r => {
    const cells = r.map(c => `<td>${esc(c)}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table>${header}${body}</table>\n`;
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
