// ============================================================================
// lib.js — Telegram (Android) chat UI renderer, pure canvas. No browser.
// Only a rendering helper used to produce bot UI mockups.
// ============================================================================
const fs = require('fs');
const path = require('path');
const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');
const { Resvg } = require('@resvg/resvg-js');
const QRCode = require('qrcode');

const DPR = 2;
const W = 540;
const H = 1170;
const TW = process.env.TWEMOJI_DIR || path.join(__dirname, 'node_modules/twemoji-svg/dist');
const CF = path.join(__dirname, 'node_modules/@canvas-fonts');

// ----------------------------- fonts --------------------------------------
GlobalFonts.register(fs.readFileSync(path.join(CF, 'arial/Arial.ttf')), 'TG');
GlobalFonts.register(fs.readFileSync(path.join(CF, 'arial-black/Arial Black.ttf')), 'TG-B');
const DV = '/usr/share/fonts/truetype/dejavu';
const reg = (file, name) => { try { GlobalFonts.register(fs.readFileSync(file), name); return true; } catch { return false; } };
reg(path.join(DV, 'DejaVuSans.ttf'), 'TGD');
reg(path.join(DV, 'DejaVuSans-Bold.ttf'), 'TGDB');
reg(path.join(DV, 'DejaVuSansMono.ttf'), 'TGM');
reg(path.join(DV, 'DejaVuSansMono-Bold.ttf'), 'TGMB');

function fontFor(size, o = {}) {
  if (o.mono) return `${o.bold ? 'TGMB' : 'TGM'} ${size}px x`;
  return `${o.bold ? 'TG-B' : 'TG'} ${size}px x`;
}

// ----------------------------- emoji ---------------------------------------
const EMOJI_ONE = /\p{Extended_Pictographic}/u;
const EMOJI_SEQ = /(\p{Extended_Pictographic}(?:\u200d\p{Extended_Pictographic})*[\uFE0F\u20E3]*)/gu;
const emojiCache = new Map();
function emojiFilesOf(str) {
  const cps = Array.from(str).map((c) => c.codePointAt(0).toString(16)).filter((c) => c !== 'fe0f');
  if (cps.length > 1 && cps[cps.length - 1] === '20e3') return cps.join('-');
  if (cps.includes('20e3')) return cps.filter((c) => c !== '20e3').join('-') + '-20e3';
  return cps.join('-');
}
function getEmojiBuf(ch) {
  if (emojiCache.has(ch)) return emojiCache.get(ch);
  const p = path.join(TW, `${emojiFilesOf(ch)}.svg`);
  const buf = fs.existsSync(p) ? new Resvg(fs.readFileSync(p, 'utf8'), { fitTo: { mode: 'width', value: 72 * DPR } }).render().asPng() : null;
  emojiCache.set(ch, buf);
  return buf;
}
const emojiImgs = new Map();
async function preloadEmoji(ch) {
  if (emojiImgs.has(ch)) return emojiImgs.get(ch);
  const buf = getEmojiBuf(ch);
  if (!buf) { emojiImgs.set(ch, null); return null; }
  const img = await loadImage(buf);
  emojiImgs.set(ch, img);
  return img;
}
const getEmojiImg = (ch) => emojiImgs.get(ch) || null;

// ----------------------------- runs ---------------------------------------
// item forms:
//   string                                   -> plain text line
//   [{t,b,i,m,color,link,size}, ...]         -> styled runs
//   {t:'q'|'pre'|'qr'|'img'|'hr'|'rows'|'map', ...}
function normRuns(input, base) {
  const arr = typeof input === 'string' ? [input] : Array.isArray(input) ? input : [input];
  const out = [];
  for (const r of arr) {
    const style = typeof r === 'string' ? { t: r } : { ...r };
    const text = String(style.t ?? '');
    const parts = text.split(EMOJI_SEQ).filter((x) => x !== '' && x !== undefined);
    for (const p of parts) {
      const isEmo = p.length <= 8 && EMOJI_ONE.test(p) && /^[\p{Extended_Pictographic}\uFE0F\u20E3\u200d]+$/u.test(p);
      out.push({ ...base, ...style, t: p, emoji: isEmo ? Array.from(p) : undefined });
    }
  }
  return out;
}

// ----------------------------- layout -------------------------------------
function measureRuns(ctx, runs, scale = DPR) {
  let w = 0;
  for (const r of runs) {
    if (r.emoji) { w += r.emoji.length * ((r.size || 14.6) * 1.2 + 1.4) * scale; continue; }
    ctx.font = fontFor((r.size || 14.6) * scale, r);
    w += ctx.measureText(r.t).width;
  }
  return w;
}
function layoutRuns(ctx, runs, opts = {}) {
  const { width = 400, scale = DPR, gap = 2.6 } = opts;
  const lines = [];
  let cur = [];
  let curW = 0;
  let pending = false;
  const close = () => {
    let max = 14.6;
    for (const r of cur) max = Math.max(max, r.size || 14.6);
    lines.push({ runs: cur, w: curW, h: (cur.length ? max : 14.6) * 1.3 + gap, size: max, extra: 0 });
    cur = [];
    curW = 0;
  };
  const add = (r) => { cur.push(r); curW += measureRuns(ctx, [r], scale); };
  for (const r of runs) {
    let text = String(r.t);
    while (true) {
      const nl = text.indexOf('\n');
      if (nl < 0) break;
      const before = text.slice(0, nl);
      if (before) {
        if (cur.length) close();
        else if (pending && lines.length) lines[lines.length - 1].extra = 4;
        pending = false;
        add({ ...r, t: before });
        close();
        pending = true;
      } else {
        if (cur.length) close();
        else if (pending && lines.length) lines[lines.length - 1].extra = 4;
        pending = true;
      }
      text = text.slice(nl + 1);
    }
    if (!text) continue;
    if (pending) { if (cur.length) close(); pending = false; }
    if (r.emoji) {
      for (const ch of text) {
        const piece = { ...r, t: ch, emoji: [ch] };
        const w = measureRuns(ctx, [piece], scale);
        if (curW + w > width && cur.length) close();
        add(piece);
      }
      continue;
    }
    let buf = '';
    for (const tok of text.split(/(?<=\s)/)) {
      const tokW = measureRuns(ctx, [{ ...r, t: tok }], scale);
      const bufW = buf ? measureRuns(ctx, [{ ...r, t: buf }], scale) : 0;
      if (curW + bufW + tokW > width && (cur.length || buf)) {
        if (buf) add({ ...r, t: buf });
        buf = '';
        close();
      }
      if (!buf && tok.trim() === '' && curW === 0) continue;
      buf += tok;
    }
    if (buf) add({ ...r, t: buf });
  }
  if (cur.length) close();
  if (!lines.length) lines.push({ runs: [], w: 0, h: 18, size: 14.6 });
  return lines;
}

function drawLines(ctx, lines, x, y, opts = {}) {
  const { scale = DPR, color = '#e9ebee', link = '#7fb2e0' } = opts;
  for (const ln of lines) {
    let cx = x * DPR;
    const dy = (y + ln.size * 0.85) * DPR;
    for (const r of ln.runs) {
      const size = ((r.size || 14.6) * scale);
      if (r.emoji) {
        const img = getEmojiImg(r.t);
        const s = size * 1.2;
        if (img) ctx.drawImage(img, cx, dy - s * 0.88, s, s);
        cx += s + 1.4 * scale;
        continue;
      }
      ctx.font = fontFor(size, r);
      ctx.fillStyle = r.color || (r.m ? (opts.code || '#dfe3e8') : color);
      if (r.link) ctx.fillStyle = r.color || link;
      ctx.fillText(r.t, cx, dy);
      if (r.link) {
        const lw = ctx.measureText(r.t).width;
        ctx.fillRect(cx, (y + ln.size * 1.06) * DPR, lw, 1 * DPR);
      }
      cx += ctx.measureText(r.t).width;
    }
    y += ln.h;
  }
  return y;
}

// ----------------------------- theme --------------------------------------
function theme(mode) {
  return mode === 'light'
    ? {
      light: true, header: '#ffffff', headLine: '#e4e8ec', text: '#0f1721', dim: '#7d8b9b',
      chat: '#dbe4ee', pin: '#eef2f7', in: '#ffffff', inText: '#0f1721', inTime: '#8595a7', inLink: '#1c6fae',
      out: '#e1fbc8', outText: '#0f1721', outTime: '#57a05a', outLink: '#1c6fae',
      card: '#ffffff', btn: '#ffffff', btnText: '#2b87d4', ok: '#2e9d43', bad: '#d94a44',
      bar: '#c9d5e2', quote: '#eff4f9', code: '#eef1f4', div: '#dde4ea', input: '#ffffff', hint: '#8b97a5',
      accent: '#2b87d4', scrim: 'rgba(30,40,52,0.45)', sheet: '#ffffff',
    }
    : {
      light: false, header: '#17212b', headLine: '#0a1018', text: '#e9ebee', dim: '#7d8b9b',
      chat: '#0f1419', pin: '#17212b', in: '#1f2b3a', inText: '#e9ebee', inTime: '#6d8099', inLink: '#7fb2e0',
      out: '#2b527e', outText: '#e9ebee', outTime: '#9fc3ea', outLink: '#aee0ff',
      card: '#16222f', btn: '#1c2b3e', btnText: '#7fb2e0', ok: '#8fd694', bad: '#f28b82',
      bar: '#5b9dd3', quote: '#24344a', code: '#101922', div: '#243244', input: '#17212b', hint: '#6e7f91',
      accent: '#5eabe8', scrim: 'rgba(4,8,14,0.66)', sheet: '#1b2735',
    };
}

// ----------------------------- wallpaper ----------------------------------
let wallpaperBuf = null;
function buildWallpaper() {
  const S = 420;
  const c = createCanvas(S * DPR, S * DPR);
  const g = c.getContext('2d');
  g.scale(DPR, DPR);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const kinds = ['heart', 'star', 'plane', 'ring', 'plus', 'diamond', 'moon', 'blob', 'sq', 'bolt'];
  for (let i = 0; i < 30; i++) {
    const k = kinds[i % kinds.length];
    const x = rnd() * S, y = rnd() * S, s = 10 + rnd() * 9, a = (rnd() - 0.5) * 1.8, o = 0.045 + rnd() * 0.07;
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.strokeStyle = `rgba(196,220,244,${o})`;
    g.fillStyle = `rgba(196,220,244,${o * 0.85})`;
    g.lineWidth = 2;
    g.beginPath();
    if (k === 'heart') {
      g.moveTo(0, s * 0.42);
      g.bezierCurveTo(-s, -s * 0.42, -s * 0.42, -s, 0, -s * 0.32);
      g.bezierCurveTo(s * 0.42, -s, s, -s * 0.42, 0, s * 0.42);
      g.fill();
    } else if (k === 'star') {
      for (let p = 0; p < 10; p++) { const r = p % 2 ? s * 0.44 : s; const an = (Math.PI / 5) * p - Math.PI / 2; g.lineTo(Math.cos(an) * r, Math.sin(an) * r); }
      g.closePath(); g.stroke();
    } else if (k === 'plane') {
      g.moveTo(-s, -s * 0.3); g.lineTo(s, 0); g.lineTo(-s, s * 0.3); g.lineTo(-s * 0.3, 0); g.closePath(); g.fill();
    } else if (k === 'ring') { g.arc(0, 0, s * 0.66, 0, Math.PI * 2); g.stroke(); }
    else if (k === 'plus') { g.rect(-s * 0.12, -s * 0.66, s * 0.24, s * 1.32); g.rect(-s * 0.66, -s * 0.12, s * 1.32, s * 0.24); g.fill(); }
    else if (k === 'diamond') { g.moveTo(0, -s * 0.78); g.lineTo(s * 0.66, 0); g.lineTo(0, s * 0.78); g.lineTo(-s * 0.66, 0); g.closePath(); g.stroke(); }
    else if (k === 'moon') { g.arc(0, 0, s * 0.7, 0.7, Math.PI * 1.55); g.arc(s * 0.4, 0, s * 0.56, Math.PI * 1.5, Math.PI * 0.55, true); g.closePath(); g.stroke(); }
    else if (k === 'blob') { g.ellipse(0, 0, s * 0.8, s * 0.42, 0.6, 0, Math.PI * 2); g.stroke(); }
    else if (k === 'sq') { g.rect(-s * 0.5, -s * 0.5, s, s); g.stroke(); }
    else { g.moveTo(0.2 * s, -s); g.lineTo(-s * 0.5, 0.15 * s); g.lineTo(-0.05 * s, 0.15 * s); g.lineTo(-0.2 * s, s); g.lineTo(s * 0.5, -0.15 * s); g.lineTo(0.05 * s, -0.15 * s); g.closePath(); g.fill(); }
    g.restore();
  }
  wallpaperBuf = c.toBuffer('image/png');
  return wallpaperBuf;
}

// ----------------------------- primitives ---------------------------------
function rr(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
const fillRR = (ctx, x, y, w, h, r, c) => { rr(ctx, x, y, w, h, r); ctx.fillStyle = c; ctx.fill(); };
const dot = (ctx, x, y, r, c) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill(); };
const px = (v) => v * DPR;

// ----------------------------- chrome --------------------------------------
function statusBar(ctx, th, o = {}) {
  const y = 14;
  ctx.font = fontFor(13 * DPR, { bold: true });
  ctx.fillStyle = th.text;
  ctx.fillText(o.time || '2:40', px(22), px(y + 12));
  const rx = px(518);
  ctx.fillStyle = th.text;
  for (let i = 0; i < 4; i++) { const hgt = (4 + i * 2.4) * DPR; ctx.fillRect(px(440 + i * 4.6), px(y + 12) - hgt + 10 * DPR, 3 * DPR, hgt); }
  ctx.strokeStyle = th.text; ctx.lineWidth = 1.5 * DPR;
  for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.arc(px(470), px(y + 11.5), i * 3.4 * DPR, Math.PI * 1.16, Math.PI * 1.84); ctx.stroke(); }
  const bw = 21 * DPR, bh = 11 * DPR;
  ctx.strokeStyle = th.text; ctx.lineWidth = 1.3 * DPR;
  rr(ctx, rx - bw, px(y + 1.5), bw, bh, 3 * DPR); ctx.stroke();
  ctx.fillRect(rx - bw + 4.5, px(y + 3.5), (bw - 9) * 0.6, bh - 4 * DPR);
  ctx.fillStyle = th.text; ctx.fillRect(rx + 1.5 * DPR, px(y + 4), 2 * DPR, 4 * DPR);
  return 30;
}
function header(ctx, th, o = {}) {
  const y0 = 30;
  ctx.fillStyle = th.header;
  ctx.fillRect(0, 0, px(W), px(y0 + 58));
  ctx.fillStyle = th.headLine;
  ctx.fillRect(0, px(y0 + 58), px(W), 1 * DPR);
  statusBar(ctx, th, o);
  ctx.strokeStyle = th.text; ctx.lineWidth = 2 * DPR; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(px(30), px(y0 + 29)); ctx.lineTo(px(20.5), px(y0 + 20)); ctx.lineTo(px(30), px(y0 + 11));
  ctx.moveTo(px(21.5), px(y0 + 20)); ctx.lineTo(px(40), px(y0 + 20));
  ctx.stroke();
  const ax = px(50), ay = px(y0 + 7), ad = px(44);
  if (o.avatarEmoji) {
    ctx.save();
    ctx.beginPath(); ctx.arc(ax + ad / 2, ay + ad / 2, ad / 2, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = o.avatarBg || '#ff9f0a';
    ctx.fillRect(ax, ay, ad, ad);
    const img = getEmojiImg(o.avatarEmoji);
    if (img) ctx.drawImage(img, ax + ad * 0.17, ay + ad * 0.2, ad * 0.66, ad * 0.66);
    ctx.restore();
  } else {
    dot(ctx, ax + ad / 2, ay + ad / 2, ad / 2, o.avatarBg || '#4fb06d');
    ctx.font = fontFor(18 * DPR, { bold: true });
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
    ctx.fillText(o.avatarText || 'S', ax + ad / 2, ay + ad * 0.64);
    ctx.textAlign = 'left';
  }
  ctx.font = fontFor(16 * DPR, { bold: true });
  ctx.fillStyle = th.text;
  ctx.fillText(o.title || 'ORDER PLACER', px(104), px(y0 + 24));
  const titleW = ctx.measureText(o.title || '').width / DPR;
  ctx.font = fontFor(12.3 * DPR, {});
  ctx.fillStyle = th.dim;
  ctx.fillText(o.subtitle || 'bot', px(104), px(y0 + 43));
  if (o.verified) {
    const badge = getEmojiImg('✔');
    if (badge) ctx.drawImage(badge, px(104 + titleW + 6), px(y0 + 13), px(12), px(12));
  }
  for (let i = 0; i < 3; i++) dot(ctx, px(516), px(y0 + 12 + i * 9), 2 * DPR, th.text);
  if (o.search) {
    ctx.strokeStyle = th.text; ctx.lineWidth = 1.9 * DPR;
    ctx.beginPath(); ctx.arc(px(480), px(y0 + 17), 7.4 * DPR, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px(485.4), px(y0 + 22.6)); ctx.lineTo(px(491), px(y0 + 28)); ctx.stroke();
  }
  return y0 + 58;
}
function pinBar(ctx, th, text, y) {
  const h = 46;
  ctx.fillStyle = th.pin;
  ctx.fillRect(0, px(y), px(W), px(h));
  fillRR(ctx, px(16), px(y + 9), px(28), px(28), px(6), th.light ? '#e6ecf2' : 'rgba(255,255,255,0.06)');
  const img = getEmojiImg('📌');
  if (img) ctx.drawImage(img, px(18), px(y + 11), px(24), px(24));
  ctx.font = fontFor(13.4 * DPR, { bold: true });
  ctx.fillStyle = th.light ? '#2b87d4' : '#7fb2e0';
  ctx.fillText('Pinned Message', px(54), px(y + 22));
  const lines = layoutRuns(ctx, normRuns(text, { size: 12.4 }), { width: 400 });
  ctx.font = fontFor(12.4 * DPR, {});
  ctx.fillStyle = th.dim;
  ctx.fillText(String(text).length > 52 ? String(text).slice(0, 52) + '…' : String(text), px(54), px(y + 38));
  ctx.strokeStyle = th.dim; ctx.lineWidth = 1.7 * DPR;
  ctx.beginPath(); ctx.moveTo(px(504), px(y + 17)); ctx.lineTo(px(514), px(y + 27)); ctx.moveTo(px(514), px(y + 17)); ctx.lineTo(px(504), px(y + 27)); ctx.stroke();
  ctx.fillStyle = th.headLine; ctx.fillRect(0, px(y + h), px(W), 1 * DPR);
  return y + h;
}
function inputBar(ctx, th, o = {}) {
  const barH = 62, y0 = H - barH;
  ctx.fillStyle = th.header;
  ctx.fillRect(0, px(y0), px(W), px(barH));
  ctx.fillStyle = th.headLine; ctx.fillRect(0, px(y0), px(W), 1 * DPR);
  fillRR(ctx, px(14), px(y0 + 11), px(W - 76), px(40), px(20), th.input);
  ctx.strokeStyle = th.light ? '#e2e7ec' : 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1 * DPR;
  rr(ctx, px(14), px(y0 + 11), px(W - 76), px(40), px(20)); ctx.stroke();
  ctx.font = fontFor(14 * DPR, {});
  if (o.typing) {
    ctx.fillStyle = th.text;
    ctx.fillText(o.typing, px(30), px(y0 + 36));
    ctx.fillStyle = th.accent;
    ctx.fillRect(px(32 + ctx.measureText(o.typing).width / DPR), px(y0 + 22), 1.6 * DPR, px(17));
  } else {
    ctx.fillStyle = th.hint;
    ctx.fillText(o.placeholder || 'Message', px(30), px(y0 + 36));
  }
  ctx.strokeStyle = th.dim; ctx.lineWidth = 1.6 * DPR;
  const ex = px(W - 118);
  ctx.beginPath(); ctx.arc(ex, px(y0 + 31), px(8.4), 0, Math.PI * 2); ctx.stroke();
  dot(ctx, ex - px(3), px(y0 + 28.6), 1.2 * DPR, th.dim);
  dot(ctx, ex + px(3), px(y0 + 28.6), 1.2 * DPR, th.dim);
  ctx.beginPath(); ctx.arc(ex, px(y0 + 31), px(4.2), 0.3, Math.PI - 0.3); ctx.stroke();
  ctx.save();
  ctx.translate(px(W - 88), px(y0 + 31)); ctx.rotate(0.45);
  ctx.beginPath();
  ctx.moveTo(-3 * DPR, 4 * DPR); ctx.lineTo(-3 * DPR, -5 * DPR);
  ctx.arc(0, -5 * DPR, 3 * DPR, Math.PI, 0);
  ctx.lineTo(3 * DPR, 5 * DPR); ctx.arc(0, 5 * DPR, 3 * DPR, 0, Math.PI); ctx.lineTo(-1.6 * DPR, -3 * DPR);
  ctx.stroke();
  ctx.restore();
  dot(ctx, px(W - 38), px(y0 + 31), px(20), th.accent);
  const mic = getEmojiImg('🎙');
  if (mic) ctx.drawImage(mic, px(W - 49), px(y0 + 20.5), px(22), px(22));
  return y0;
}

// ----------------------------- content -------------------------------------
function contentLines(ctx, block, width, base) {
  // returns { items:[{kind,lines,...}], h }
  const out = [];
  let h = 0;
  for (const item of block) {
    if (item.t === 'q') {
      const runs = normRuns(item.text, { size: item.size || 13.4, color: item.color });
      const lines = layoutRuns(ctx, runs.map((r) => ({ ...r, size: r.size })), { width: width - 24 });
      const titleLines = item.title ? layoutRuns(ctx, normRuns(item.title, { size: 13.7, b: true }), { width: width - 24 }) : [];
      const hh = titleLines.reduce((a, l) => a + l.h, 0) + lines.reduce((a, l) => a + l.h + (l.extra || 0), 0) + 13;
      out.push({ kind: 'q', lines, titleLines, h: hh, r: width });
      h += hh + 6;
    } else if (item.t === 'pre') {
      const runs = normRuns(item.text, { size: item.size || 10.6, m: true, color: item.color });
      const lines = layoutRuns(ctx, runs, { width: width - 20 });
      const hh = lines.reduce((a, l) => a + l.h + (l.extra || 0), 0) + 12;
      out.push({ kind: 'pre', lines, h: hh, r: width });
      h += hh + 6;
    } else if (item.t === 'qr') {
      const s = item.size || 200;
      out.push({ kind: 'qr', item, h: s + 10, r: Math.min(width, s) });
      h += s + 10;
    } else if (item.t === 'img') {
      const s = { w: item.w || width, h: item.h || Math.round(width * 0.6) };
      out.push({ kind: 'img', item, s, h: s.h + 4, r: s.w });
      h += s.h + 4;
    } else if (item.t === 'hr') {
      out.push({ kind: 'hr', h: 13, r: 0 });
      h += 13;
    } else if (item.t === 'rows') {
      const rowH = (item.size || 13.4) * 1.7;
      const hh = rowH * item.rows.length + 8;
      out.push({ kind: 'rows', item, rowH, h: hh, r: width, size: item.size || 13.4 });
      h += hh + 2;
    } else if (item.t === 'map') {
      const hh = item.h || 118;
      out.push({ kind: 'map', item, h: hh + 4, r: width });
      h += hh + 4;
    } else {
      const runs = normRuns(item, { size: base.size || 14.4 });
      const lines = layoutRuns(ctx, runs, { width });
      const hh = lines.reduce((a, l) => a + l.h + (l.extra || 0), 0);
      out.push({ kind: 'txt', lines, h: hh, r: Math.min(width, Math.max(0, ...lines.map((l) => l.w / DPR))) });
      h += hh + 2.5;
    }
  }
  return { items: out, h };
}
function drawBlock(ctx, th, block, x, y, width, o = {}) {
  const { color = th.inText, link = th.inLink, size = 14.4 } = o;
  const { items } = contentLines(ctx, block, width, { size, color });
  let cy = y;
  for (const it of items) {
    if (it.kind === 'q') {
      const bw = width;
      fillRR(ctx, px(x), px(cy), px(bw), px(it.h), px(7), th.quote);
      rr(ctx, px(x), px(cy), px(3), px(it.h), px(1.5));
      ctx.fillStyle = th.bar; ctx.fill();
      let qy = cy + 6;
      if (it.titleLines && it.titleLines.length) { drawLines(ctx, it.titleLines, x + 13, qy, { color: th.light ? '#16222e' : '#f0f4f8', link }); qy += it.titleLines.reduce((a, l) => a + l.h, 0); }
      drawLines(ctx, it.lines, x + 13, qy, { color, link });
      cy += it.h + 6;
      continue;
    }
    if (it.kind === 'pre') {
      const bw = width;
      fillRR(ctx, px(x), px(cy), px(bw), px(it.h), px(6), th.code);
      drawLines(ctx, it.lines, x + 10, cy + 5, { color: th.light ? '#3d4a59' : '#cbd6e2', code: th.light ? '#3d4a59' : '#cbd6e2' });
      cy += it.h + 5;
      continue;
    }
    if (it.kind === 'qr') {
      const s = it.item.size || 200;
      const img = getPre(it.item.id || 'qr');
      const qx = it.item.left ? x : x + (width - s) / 2;
      fillRR(ctx, px(qx), px(cy), px(s), px(s), px(10), '#ffffff');
      if (img) ctx.drawImage(img, px(qx + 7), px(cy + 7), px(s - 14), px(s - 14));
      cy += s + 10;
      continue;
    }
    if (it.kind === 'img') {
      const img = getPre(it.item.id);
      ctx.save();
      rr(ctx, px(x), px(cy), px(it.s.w), px(it.s.h), px(9));
      ctx.clip();
      if (img) ctx.drawImage(img, px(x), px(cy), px(it.s.w), px(it.s.h));
      else { ctx.fillStyle = th.light ? '#dfe6ec' : '#111c28'; ctx.fillRect(px(x), px(cy), px(it.s.w), px(it.s.h)); }
      ctx.restore();
      if (it.item.caption) {
        ctx.font = fontFor(11.5 * DPR, {});
        ctx.fillStyle = th.dim;
        ctx.fillText(it.item.caption, px(x + 8), px(cy + it.s.h + 16));
      }
      cy += it.s.h + 6;
      continue;
    }
    if (it.kind === 'hr') {
      ctx.fillStyle = th.div; ctx.fillRect(px(x), px(cy + 4), px(width), 1 * DPR);
      cy += 13; continue;
    }
    if (it.kind === 'rows') {
      const { item, rowH } = it;
      if (item.bg) fillRR(ctx, px(x), px(cy - 3), px(width), px(it.h), px(7), item.bg);
      item.rows.forEach((r, i) => {
        const [l, v] = r;
        const ry = cy + i * rowH;
        ctx.font = fontFor((item.size || 13.4) * DPR, {});
        ctx.fillStyle = th.dim;
        ctx.fillText(String(l), px(x + 9), px(ry + rowH * 0.68));
        const vr = normRuns(v, { size: item.size || 13.4 });
        const vlines = layoutRuns(ctx, vr, { width: width * 0.55 });
        const vw = vlines[0].w / DPR;
        drawLines(ctx, vlines, x + width - 9 - vw, ry + rowH * 0.2, { color: item.vColor || color, link });
      });
      cy += it.h + 3;
      continue;
    }
    if (it.kind === 'map') {
      drawMiniMap(ctx, th, x, cy, width, it.item.h || 118, it.item);
      cy += (it.item.h || 118) + 4;
      continue;
    }
    drawLines(ctx, it.lines, x, cy, { color, link });
    cy += it.h + 2.5;
  }
  return cy - y;
}
function blockWidth(ctx, block, width, size = 14.4) {
  const { items } = contentLines(ctx, block, width, { size });
  let best = 0;
  for (const it of items) best = Math.max(best, it.r || 0);
  return Math.max(140, Math.min(width, best));
}
function drawMiniMap(ctx, th, x, y, w, h, o = {}) {
  ctx.save();
  rr(ctx, px(x), px(y), px(w), px(h), px(9));
  ctx.clip();
  ctx.fillStyle = th.light ? '#e9efe6' : '#141f2c';
  ctx.fillRect(px(x), px(y), px(w), px(h));
  ctx.strokeStyle = th.light ? 'rgba(150,168,150,0.55)' : 'rgba(120,160,200,0.22)';
  ctx.lineWidth = 5 * DPR;
  ctx.beginPath(); ctx.moveTo(px(x - 10), px(y + h * 0.38)); ctx.lineTo(px(x + w * 0.6), px(y + h * 0.46)); ctx.lineTo(px(x + w + 10), px(y + h * 0.22)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(px(x + w * 0.3), px(y - 10)); ctx.lineTo(px(x + w * 0.42), px(y + h + 10)); ctx.stroke();
  ctx.strokeStyle = '#5eabe8'; ctx.lineWidth = 3.2 * DPR;
  ctx.setLineDash([7 * DPR, 5 * DPR]);
  ctx.beginPath();
  ctx.moveTo(px(x + w * 0.18), px(y + h * 0.8));
  ctx.bezierCurveTo(px(x + w * 0.5), px(y + h * 0.92), px(x + w * 0.52), px(y + h * 0.24), px(x + w * 0.8), px(y + h * 0.34));
  ctx.stroke();
  ctx.setLineDash([]);
  dot(ctx, px(x + w * 0.8), px(y + h * 0.34), 7 * DPR, '#ff5252');
  dot(ctx, px(x + w * 0.18), px(y + h * 0.8), 6 * DPR, '#5eabe8');
  if (o.label) {
    ctx.font = fontFor(11 * DPR, { bold: true });
    ctx.fillStyle = th.light ? '#20303d' : '#dfe8f2';
    ctx.fillText(o.label, px(x + 10), px(y + h - 10));
  }
  ctx.restore();
}

// ----------------------------- keyboard -------------------------------------
function kbRows(ctx, rows, w) {
  return rows.map((row) => {
    const buttons = (row.b || row).map((b) => (typeof b === 'string' ? { t: b } : b));
    const n = buttons.length;
    const bw = (w - 5 * (n - 1)) / n;
    let maxLines = 1;
    const runs = buttons.map((btn) => {
      const r = normRuns(btn.t, { size: 13.2, b: true });
      const lines = layoutRuns(ctx, r, { width: bw - 20 });
      maxLines = Math.max(maxLines, lines.length);
      return { btn, lines, w: lines.reduce((m, l) => Math.max(m, l.w / DPR), 0) };
    });
    const h = Math.max(37, 10 + maxLines * 17.6);
    return { runs, bw, h, maxLines };
  });
}
function kbHeight(ctx, rows, w) {
  return kbRows(ctx, rows, w).reduce((a, r) => a + r.h + 5, 4);
}
function drawKeyboard(ctx, th, rows, x, y, w, o = {}) {
  const laid = kbRows(ctx, rows, w);
  let cy = y;
  for (const row of laid) {
    row.runs.forEach((item, i) => {
      const bx = x + i * (row.bw + 5);
      const style = item.btn.style || 'primary';
      let bg = th.btn, col = th.btnText;
      if (style === 'success') { bg = th.light ? '#e4f6e7' : '#153721'; col = th.ok; }
      else if (style === 'danger') { bg = th.light ? '#fdeaea' : '#3a1c1e'; col = th.bad; }
      else if (style === 'gold') { bg = th.light ? '#fff5df' : '#3a2f14'; col = th.light ? '#b07d18' : '#f0c060'; }
      fillRR(ctx, px(bx), px(cy), px(row.bw), px(row.h), px(6), bg);
      const tx = bx + (row.bw - item.lines[0].w / DPR) / 2;
      drawLines(ctx, item.lines, tx, cy + (row.h - row.runs.length * 0 - item.lines.length * 17.6) / 2 + 1, { color: col, link: col });
      if (item.btn.url) {
        ctx.strokeStyle = col; ctx.lineWidth = 1.5 * DPR;
        ctx.beginPath();
        const ax = bx + row.bw - 14, ay = cy + row.h / 2;
        ctx.moveTo(px(ax - 3), px(ay - 3)); ctx.lineTo(px(ax + 3), px(ay - 3)); ctx.lineTo(px(ax + 3), px(ay + 3));
        ctx.moveTo(px(ax + 3), px(ay - 3)); ctx.lineTo(px(ax - 3), px(ay + 3));
        ctx.stroke();
      }
    });
    cy += row.h + 5;
  }
  return cy - y;
}

// ----------------------------- messages -------------------------------------
function imgW2v(m) { return m.image ? (m.image.w || 300) : 0; }
function layoutMessage(ctx, th, m) {
  const hasKb = Boolean(m.keyboard && m.keyboard.length);
  const padX = 11, padTop = m.image || (m.body[0] || {}).t === 'img' ? 0 : 10;
  const hasCard = (m.body || []).some((it) => it && typeof it === 'object' && ['q', 'pre', 'rows', 'map'].includes(it.t));
  const widthCap = hasKb ? 456 : hasCard ? 430 : 404;
  const inner = widthCap - padX * 2;
  const body = m.body || [];
  const { items, h } = contentLines(ctx, body, inner, { size: m.size || 14.4 });
  const bodyW = items.reduce((mx, it) => Math.max(mx, (it.kind === 'q' || it.kind === 'pre' || it.kind === 'rows' || it.kind === 'map' || it.kind === 'qr' || it.kind === 'img') ? inner : (it.r || 0)), 0);
  const imgW2 = imgW2v(m);
  let bw = Math.max(hasKb ? 330 : 130, Math.min(widthCap, Math.max(bodyW, imgW2v(m)) + padX * 2));
  const kbH = hasKb ? kbHeight(ctx, m.keyboard, bw - 18) : 0;
  const imgH = (m.image && (m.image.h || Math.round(imgW2 * 0.6))) || 0;
  const foot = hasKb ? 13 : 17;
  const total = padTop + h + imgH + foot + kbH;
  return { h: total, bw, inner, bodyH: h, kbH, padX, padTop, items, foot, kbFoot: hasKb ? 16 : 0 };
}
function drawMessage(ctx, th, m, L, y, o = {}) {
  const out = Boolean(m.out);
  let cursor = y;
  if (m.date) {
    const lines = layoutRuns(ctx, normRuns(m.date, { size: 12 }), { width: 300 });
    const w = lines[0].w / DPR + 22;
    fillRR(ctx, px((W - w) / 2), px(cursor), px(w), px(23), px(11), th.light ? 'rgba(255,255,255,0.9)' : 'rgba(20,28,38,0.78)');
    drawLines(ctx, lines, (W - w) / 2 + 11, cursor + 3.5, { color: th.light ? '#5d6b78' : '#9db0c2' });
    cursor += 30;
  }
  const x = out ? W - 12 - L.bw : 12;
  const bg = out ? th.out : th.in;
  const head = m.image ? (m.image.h || Math.round(imgW2v(m) * 0.6)) : 0;
  const bodyH = L.bodyH + head;
  const kbFoot = L.kbH ? 16 : 0;
  const foot = L.kbH ? 16 : 17;
  const totalH = L.padTop + bodyH + foot + L.kbH;
  if (L.kbH) {
    fillRR(ctx, px(x), px(cursor), px(L.bw), px(totalH), px(14), bg);
    ctx.fillStyle = bg;
    ctx.fillRect(px(x), px(cursor + totalH - 14), px(L.bw), px(14));
  } else {
    fillRR(ctx, px(x), px(cursor), px(L.bw), px(totalH), px(15), bg);
    ctx.beginPath();
    if (out) {
      ctx.moveTo(px(x + L.bw - 15), px(cursor + totalH - 16));
      ctx.quadraticCurveTo(px(x + L.bw + 3), px(cursor + totalH - 9), px(x + L.bw - 3), px(cursor + totalH + 3));
      ctx.lineTo(px(x + L.bw - 15), px(cursor + totalH));
    } else {
      ctx.moveTo(px(x + 15), px(cursor + totalH - 16));
      ctx.quadraticCurveTo(px(x - 3), px(cursor + totalH - 9), px(x + 3), px(cursor + totalH + 3));
      ctx.lineTo(px(x + 15), px(cursor + totalH));
    }
    ctx.fillStyle = bg; ctx.fill();
  }
  let cy = cursor + L.padTop;
  const bodyTop = cy;
  if (m.image) {
    ctx.save();
    rr(ctx, px(x), px(cy), px(L.bw), px(head), 0);
    ctx.clip();
    const img = getPre(m.image.id);
    if (img) ctx.drawImage(img, px(x), px(cy), px(L.bw), px(head));
    else { ctx.fillStyle = '#101a26'; ctx.fillRect(px(x), px(cy), px(L.bw), px(head)); }
    ctx.restore();
    cy += head;
  }
  drawBlock(ctx, th, m.body || [], x + L.padX, cy, L.inner, { color: out ? th.outText : th.inText, link: out ? th.outLink : th.inLink, size: m.size || 14.4 });
  const fy = cursor + L.padTop + bodyH + 1;
  ctx.font = fontFor(11.2 * DPR, {});
  const timeStr = m.time || '2:40 PM';
  const tw = ctx.measureText(timeStr).width / DPR;
  ctx.fillStyle = out ? th.outTime : th.inTime;
  ctx.textAlign = 'right';
  ctx.fillText(timeStr, px(x + L.bw - L.padX), px(fy + (L.kbH ? 13 : 13)));
  ctx.textAlign = 'left';
  if (out && m.read) {
    ctx.strokeStyle = th.light ? '#4f9e57' : '#7fd0ff';
    ctx.lineWidth = 1.7 * DPR; ctx.lineCap = 'round';
    const bx = x + L.bw - L.padX - tw - 4;
    const by = fy + 4;
    const n = m.read === 2 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const ox = bx - (n - 1 - k) * 5.4;
      ctx.beginPath();
      ctx.moveTo(px(ox - 4), px(by + 3)); ctx.lineTo(px(ox - 1.2), px(by + 6)); ctx.lineTo(px(ox + 3.6), px(by - 0.6));
      ctx.stroke();
    }
  }
  if (L.kbH) drawKeyboard(ctx, th, m.keyboard, x + 9, fy + (L.kbFoot || 16), L.bw - 18);
  if (m.avatar && !out) {
    const img = getEmojiImg(m.avatar);
    const cxp = 12 + L.bw + 22, cyp = cursor + totalH - 14;
    dot(ctx, px(cxp), px(cyp), px(15), m.avatarBg || '#4fb06d');
    if (img) ctx.drawImage(img, px(cxp - 11), px(cyp - 11), px(22), px(22));
  }
  return cursor + totalH + 8;
}

// ----------------------------- popups / banners -----------------------------
function scrim(ctx, th) { ctx.fillStyle = th.scrim; ctx.fillRect(0, 0, px(W), px(H)); }
function popup(ctx, th, o) {
  const w = Math.min(o.width || 372, W - 32);
  const innerW = w - 44;
  const { items, h } = contentLines(ctx, o.body || [], innerW, { size: 14 });
  const btnH = o.buttons ? o.buttons.length * 44 + 10 : 10;
  const titleH = o.title ? 34 : 0;
  const hh = 22 + titleH + h + btnH;
  const x = (W - w) / 2;
  const y = o.y != null ? o.y : Math.round((H - hh) / 2) - 40;
  scrim(ctx, th);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 18 * DPR; ctx.shadowOffsetY = 5 * DPR;
  fillRR(ctx, px(x), px(y), px(w), px(hh), px(14), th.sheet);
  ctx.restore();
  let cy = y + 20;
  if (o.title) {
    ctx.font = fontFor(16.4 * DPR, { bold: true });
    ctx.fillStyle = th.text;
    ctx.fillText(o.title, px(x + 22), px(cy + 17));
    cy += titleH;
  }
  cy += drawBlock(ctx, th, o.body || [], x + 22, cy, innerW, { color: th.text, link: th.light ? '#2b87d4' : '#7fb2e0', size: 14 }) + 8;
  if (o.buttons) {
    for (const row of o.buttons) {
      const n = row.length;
      const bw = (w - 20 - 4 * (n - 1)) / n;
      row.forEach((btn, i) => {
        const bx = x + 10 + i * (bw + 4);
        const col = btn.style === 'danger' ? (th.light ? '#d94a44' : '#f28b82') : (th.light ? '#2b87d4' : '#7fb2e0');
        if (btn.hover) fillRR(ctx, px(bx), px(cy - 3), px(bw), px(40), px(8), th.light ? 'rgba(43,135,212,0.1)' : 'rgba(127,178,224,0.12)');
        const lines = layoutRuns(ctx, normRuns(btn.t, { size: 14.4, b: true }), { width: bw - 12 });
        const tx = bx + (bw - lines[0].w / DPR) / 2;
        drawLines(ctx, lines, tx, cy + 9, { color: col, link: col });
        ctx.font = fontFor(14.6 * DPR, { bold: true });
        ctx.fillStyle = col;
      });
      cy += 44;
    }
  }
  return { h: hh, y, w };
}
function toast(ctx, th, o) {
  const lines = layoutRuns(ctx, normRuns(o.text, { size: 13.6 }), { width: 300 });
  const w = Math.max(...lines.map((l) => l.w / DPR)) + 32;
  const h = lines.length * 19 + 15;
  const y = o.y != null ? o.y : H - 210;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 10 * DPR;
  fillRR(ctx, px((W - w) / 2), px(y), px(w), px(h), px(8), 'rgba(28,38,50,0.95)');
  ctx.restore();
  drawLines(ctx, lines, (W - w) / 2 + 16, y + 7, { color: '#ffffff' });
}
function smsBanner(ctx, th, o) {
  const w = W - 18, h = o.h || 78, x = 9, y = o.y != null ? o.y : 40;
  scrim(ctx, th);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 20 * DPR; ctx.shadowOffsetY = 7 * DPR;
  fillRR(ctx, px(x), px(y), px(w), px(h), px(19), th.light ? 'rgba(255,255,255,0.97)' : 'rgba(32,41,55,0.96)');
  ctx.restore();
  fillRR(ctx, px(x + 13), px(y + 13), px(30), px(30), px(8), o.iconBg || '#ff9f0a');
  const em = getEmojiImg(o.icon || '🛵');
  if (em) ctx.drawImage(em, px(x + 16), px(y + 15), px(24), px(24));
  ctx.font = fontFor(12.6 * DPR, { bold: true });
  ctx.fillStyle = th.text;
  ctx.fillText(o.title || 'Messages', px(x + 52), px(y + 26));
  ctx.font = fontFor(11.6 * DPR, {});
  ctx.fillStyle = th.dim;
  ctx.textAlign = 'right';
  ctx.fillText(o.time || 'now', px(x + w - 13), px(y + 26));
  ctx.textAlign = 'left';
  const lines = layoutRuns(ctx, normRuns(o.body, { size: 12.9 }), { width: w - 62 }).slice(0, 2);
  drawLines(ctx, lines, x + 52, y + 33, { color: th.text });
  return y + h;
}
function smsThreadHeader(ctx, th, o = {}) {
  ctx.fillStyle = th.light ? '#ffffff' : '#17212b';
  ctx.fillRect(0, 0, px(W), px(88));
  statusBar(ctx, th, o);
  ctx.strokeStyle = th.text; ctx.lineWidth = 2 * DPR;
  ctx.beginPath(); ctx.moveTo(px(30), px(58)); ctx.lineTo(px(21), px(49)); ctx.lineTo(px(30), px(40));
  ctx.moveTo(px(21.5), px(49)); ctx.lineTo(px(40), px(49)); ctx.stroke();
  dot(ctx, px(64), px(49), px(16), o.avatarBg || '#2f9e6f');
  const em = o.avatarEmoji ? getEmojiImg(o.avatarEmoji) : null;
  if (em) ctx.drawImage(em, px(53), px(38), px(22), px(22));
  else { ctx.font = fontFor(13 * DPR, { bold: true }); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(o.avatarText || '98', px(64), px(54)); ctx.textAlign = 'left'; }
  ctx.font = fontFor(15 * DPR, { bold: true });
  ctx.fillStyle = th.text;
  ctx.fillText(o.title || '98765 43210', px(88), px(45));
  ctx.font = fontFor(11.6 * DPR, {});
  ctx.fillStyle = th.dim;
  ctx.fillText(o.sub || 'SMS · Messages', px(88), px(61));
  ctx.fillStyle = th.headLine || 'rgba(0,0,0,0.1)';
  ctx.fillRect(0, px(88), px(W), DPR);
  return 88;
}
function smsBubble(ctx, th, o) {
  const { x = 16, w = W - 32 } = o;
  const lines = layoutRuns(ctx, normRuns(o.body, { size: 14.6 }), { width: w - 28 });
  const hh = lines.reduce((a, l) => a + l.h, 0) + 18;
  fillRR(ctx, px(x), px(o.y), px(w), px(hh), px(14), o.in === false ? (th.light ? '#cfe9ff' : '#2b527e') : (th.light ? '#ffffff' : '#1f2b3a'));
  drawLines(ctx, lines, x + 14, o.y + 9, { color: th.text });
  ctx.font = fontFor(10.8 * DPR, {});
  ctx.fillStyle = th.dim;
  ctx.textAlign = 'right';
  ctx.fillText(o.time || '2:41 PM', px(x + w - 12), px(o.y + hh + 14));
  ctx.textAlign = 'left';
  return o.y + hh + 26;
}
function otpChips(ctx, th, o = {}) {
  const y = H - 62 - 214;
  ctx.fillStyle = th.light ? '#eef1f4' : '#101a24';
  ctx.fillRect(0, px(y), px(W), px(56));
  ctx.font = fontFor(11 * DPR, { bold: true });
  ctx.fillStyle = th.dim;
  ctx.fillText(o.label || 'SUGGESTIONS', px(18), px(y + 17));
  let x = 18;
  for (const c of o.chips) {
    const lines = layoutRuns(ctx, normRuns(c, { size: 13.2 }), { width: 420 });
    const w = lines[0].w / DPR + 24;
    fillRR(ctx, px(x), px(y + 23), px(w), px(27), px(13), th.light ? '#dfe7ef' : '#22354a');
    drawLines(ctx, lines, x + 12, y + 27.5, { color: th.light ? '#1b2a3a' : '#dceaf8' });
    x += w + 8;
  }
  ctx.fillStyle = th.light ? '#c8d0d8' : '#0a121b';
  ctx.fillRect(0, px(y + 56), px(W), px(158));
  const rows = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  let ry = y + 64;
  rows.forEach((r, ri) => {
    const keys = Array.from(r);
    const kw = (W - 14 - (keys.length - 1) * 4.5) / keys.length;
    keys.forEach((k, i) => {
      const xk = 7 + i * (kw + 4.5);
      fillRR(ctx, px(xk), px(ry), px(kw), px(30), px(5), th.light ? '#ffffff' : '#1c2b3e');
      ctx.font = fontFor(13 * DPR, {});
      ctx.fillStyle = th.text;
      ctx.textAlign = 'center';
      ctx.fillText(k, px(xk + kw / 2), px(ry + 20));
      ctx.textAlign = 'left';
    });
    ry += 34;
  });
  fillRR(ctx, px(7), px(ry), px(70), px(30), px(5), th.light ? '#dfe7ef' : '#18242f');
  fillRR(ctx, px(82), px(ry), px(W - 164), px(30), px(5), th.light ? '#ffffff' : '#1c2b3e');
  fillRR(ctx, px(W - 77), px(ry), px(70), px(30), px(5), th.accent);
  ctx.font = fontFor(12.5 * DPR, { bold: true });
  ctx.fillStyle = th.light ? '#33475b' : '#a9c4dd';
  ctx.fillText('?123', px(18), px(ry + 20));
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText('Enter', px(W - 42), px(ry + 20));
  ctx.textAlign = 'left';
}

// ----------------------------- misc widgets ---------------------------------
function progressSteps(ctx, th, x, y, w, steps, active) {
  const n = steps.length;
  const seg = (w - 12 * (n - 1)) / n;
  steps.forEach((s, i) => {
    const sx = x + i * (seg + 12);
    const done = i < active, cur = i === active;
    fillRR(ctx, px(sx), px(y), px(seg), px(5), px(2.5), done || cur ? '#ff9f0a' : th.div);
    ctx.font = fontFor(11.4 * DPR, { bold: cur });
    ctx.fillStyle = done || cur ? th.text : th.dim;
    ctx.fillText(s, sx, y + 20);
  });
}
function timeline(ctx, th, x, y, items, o = {}) {
  const rowH = o.rowH || 44;
  items.forEach((it, i) => {
    const ry = y + i * rowH;
    const active = it.done || it.active;
    dot(ctx, px(x + 6), px(ry + 8), px(5.5), active ? (th.light ? '#2e9d43' : '#8fd694') : th.dim);
    if (i < items.length - 1) {
      ctx.strokeStyle = it.done ? (th.light ? '#2e9d43' : '#4f7f56') : th.div;
      ctx.lineWidth = 2 * DPR;
      ctx.beginPath(); ctx.moveTo(px(x + 6), px(ry + 16)); ctx.lineTo(px(x + 6), px(ry + rowH - 2)); ctx.stroke();
    }
    ctx.font = fontFor(13.6 * DPR, { bold: Boolean(it.active) });
    ctx.fillStyle = it.active ? th.text : th.dim;
    ctx.fillText(it.t, px(x + 22), px(ry + 12));
    if (it.time) {
      ctx.font = fontFor(11.6 * DPR, {});
      ctx.fillStyle = th.dim;
      ctx.textAlign = 'right';
      ctx.fillText(it.time, px(x + (o.w || 300)), px(ry + 11));
      ctx.textAlign = 'left';
    }
  });
  return y + items.length * rowH;
}

// ----------------------------- assets preloader -----------------------------
const preloaded = new Map();
async function preload(buf, id) { const img = await loadImage(buf); preloaded.set(id, img); return img; }
const getPre = (id) => preloaded.get(id);

function eachRun(spec, fn) {
  const walk = (v) => {
    if (typeof v === 'string') { fn(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') { Object.values(v).forEach(walk); }
  };
  fn('📌'); fn('🎙');
  if (spec.header && spec.header.avatarEmoji) fn(spec.header.avatarEmoji);
  if (spec.pin) fn(spec.pin);
  (spec.messages || []).forEach((m) => { fn(m.avatar || ''); walk(m.body); walk(m.keyboard); });
  if (spec.popup) { fn(spec.popup.title || ''); walk(spec.popup.body); (spec.popup.buttons || []).forEach(walk); }
  if (spec.banner) { fn(spec.banner.icon || '🛵'); walk(spec.banner.body); }
  if (spec.overlayEmoji) fn(spec.overlayEmoji);
  if (spec.sms) { fn(spec.sms.icon || '🛵'); walk(spec.sms.body); }
}
async function preloadAssets(spec) {
  const emoji = new Set();
  eachRun(spec, (s) => { for (const ch of String(s)) if (EMOJI_ONE.test(ch)) emoji.add(ch); });
  await Promise.all([...emoji].map((ch) => preloadEmoji(ch)));
  const jobs = [];
  (spec.images || []).forEach((im) => {
    if (!im || !im.id) return;
    const { w = 400, h = 260, draw } = im;
    const c = createCanvas(w * DPR, h * DPR);
    const g = c.getContext('2d');
    g.scale(DPR, DPR);
    if (draw) draw(g, { w, h });
    else { g.fillStyle = im.bg || '#16202c'; g.fillRect(0, 0, w, h); }
    jobs.push(preload(c.toBuffer('image/png'), im.id));
  });
  (spec.messages || []).forEach((m) => {
    (m.body || []).forEach((item) => {
      if (item && item.t === 'qr' && item.qrText) {
        const s = item.size || 200;
        const svg = QRCode.toString(item.qrText, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        jobs.push(
          svg.then((sv) => {
            const png = new Resvg(sv, { fitTo: { mode: 'width', value: s * DPR } }).render().asPng();
            return preload(png, item.id || 'qr');
          })
        );
      }
    });
  });
  await Promise.all(jobs);
}
async function preloadWallpaper() {
  buildWallpaper();
  await preload(wallpaperBuf, 'wallpaper');
}

// ----------------------------- page -----------------------------------------
async function renderChat(spec) {
  const th = theme(spec.mode);
  const c = createCanvas(W * DPR, H * DPR);
  const ctx = c.getContext('2d');
  ctx.fillStyle = th.chat;
  ctx.fillRect(0, 0, px(W), px(H));
  const wall = getPre('wallpaper');
  if (wall) {
    const pat = ctx.createPattern(wall, 'repeat');
    ctx.save();
    ctx.globalAlpha = th.light ? 0.55 : 1;
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, px(W), px(H));
    ctx.restore();
    if (th.light) { ctx.fillStyle = 'rgba(226,235,244,0.55)'; ctx.fillRect(0, 0, px(W), px(H)); }
  }
  let y = header(ctx, th, spec.header || {});
  if (spec.pin) y = pinBar(ctx, th, spec.pin, y);
  const top = y + 8;
  const bottom = H - (spec.hideInput ? 24 : 62) - 8 - (spec.keyboard ? 214 : 0);
  if (spec.smsThread) {
    ctx.fillStyle = th.light ? '#eef2f6' : '#0d141c';
    ctx.fillRect(0, px(88), px(W), px(H - 88));
    const yy = smsThreadHeader(ctx, th, spec.smsThread);
    let sy = yy + 14;
    ctx.font = fontFor(11.5 * DPR, {});
    ctx.fillStyle = th.dim;
    ctx.textAlign = 'center';
    ctx.fillText(spec.smsThread.date || 'Today', px(W / 2), px(sy + 12));
    ctx.textAlign = 'left';
    sy += 24;
    let yy2 = sy;
    const bs = spec.smsThread.bubbles || [];
    const hs = bs.map((b) => {
      const lines = layoutRuns(ctx, normRuns(b.body, { size: 14.4 }), { width: W - 62 });
      return lines.reduce((a, l) => a + l.h, 0) + 20;
    });
    const tot = hs.reduce((a, b) => a + b + 26, 0);
    if (tot < bottom - yy2) yy2 = bottom - tot - 30;
    for (let i = 0; i < bs.length; i++) yy2 = smsBubble(ctx, th, { ...bs[i], y: yy2, in: true });
    inputBar(ctx, th, { placeholder: 'Text message' });
    if (spec.toast) toast(ctx, th, spec.toast);
    return c.toBuffer('image/png');
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, px(top - 8), px(W), px(bottom - top + 12));
  ctx.clip();
  const laid = (spec.messages || []).map((m) => layoutMessage(ctx, th, m));
  const total = laid.reduce((a, b) => a + b.h + 8, 0);
  let cy = spec.fromTop ? top : bottom - total - 8;
  if (total + 8 > bottom - top) cy = top;
  for (let i = 0; i < laid.length; i++) cy = drawMessage(ctx, th, spec.messages[i], laid[i], cy);
  ctx.restore();
  if (!spec.hideInput) inputBar(ctx, th, spec.input || {});
  if (spec.keyboard) otpChips(ctx, th, spec.keyboard);
  if (spec.toast) toast(ctx, th, spec.toast);
  if (spec.popup) popup(ctx, th, spec.popup);
  if (spec.banner) smsBanner(ctx, th, spec.banner);
  if (spec.overlay) spec.overlay(ctx, th, { W, H, DPR, th });
  if (spec.screenshot && spec.screenshot.draw) {
    const img = getPre(spec.screenshot.id);
    if (img) {
      const sw = spec.screenshot.w || 300;
      const sh = spec.screenshot.h || 560;
      const sx = spec.screenshot.x != null ? spec.screenshot.x : (W - sw) / 2;
      const sy = spec.screenshot.y != null ? spec.screenshot.y : 120;
      scrim(ctx, th);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 20 * DPR; ctx.shadowOffsetY = 8 * DPR;
      fillRR(ctx, px(sx - 6), px(sy - 6), px(sw + 12), px(sh + 12), px(18), th.light ? '#ffffff' : '#0c141d');
      ctx.restore();
      ctx.save();
      rr(ctx, px(sx), px(sy), px(sw), px(sh), px(12));
      ctx.clip();
      ctx.drawImage(img, px(sx), px(sy), px(sw), px(sh));
      ctx.restore();
    }
  }
  return c.toBuffer('image/png');
}

module.exports = {
  W, H, DPR, px, theme, createCanvas, loadImage, getPre, preload, preloadAssets, preloadWallpaper,
  renderChat, fillRR, rr, dot, drawLines, layoutRuns, normRuns, drawBlock, blockWidth, contentLines,
  drawKeyboard, kbHeight, popup, toast, smsBanner, smsThreadHeader, smsBubble, otpChips,
  fontFor, getEmojiImg, preloadEmoji, statusBar, header, inputBar, pinBar, drawMiniMap,
  progressSteps, timeline, scrim, EMOJI_ONE,
};
