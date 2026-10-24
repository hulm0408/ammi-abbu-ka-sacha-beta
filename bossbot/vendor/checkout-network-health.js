// Observe checkout refusals and respect a shared cooldown. This does not
// rotate addresses, solve challenges, or attempt another gateway to evade a block.
const originBlocks = new Map();
const ORIGIN = 'https://chkout.swiggy.com';

export function classifyCheckoutResponse(response, now = Date.now()) {
  const status = Number(response?.status || 0);
  const action = String(response?.headers?.get?.('x-amzn-waf-action') || '').toLowerCase();
  const challenge = /^(?:challenge|captcha|block)$/.test(action);
  if (status !== 403 && status !== 429 && !challenge) return null;
  const code = status === 429 ? 'CHECKOUT_RATE_LIMITED' : challenge ? 'CHECKOUT_SECURITY_CHALLENGE' : 'CHECKOUT_ACCESS_DENIED';
  const retryHeader = String(response?.headers?.get?.('retry-after') || '').trim();
  const numeric = retryHeader ? Number(retryHeader) : NaN;
  const retryMs = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(retryHeader) - now;
  const delay = Number.isFinite(retryMs) && retryMs > 0 ? retryMs : status === 429 ? 60_000 : 180_000;
  return {
    code, httpStatus: status, stage: 'NATIVE_CHECKOUT',
    retryAfterMs: Math.min(86_400_000, Math.max(1000, delay)),
    // 403 can also be an account/permission refusal. Never label it a proven IP ban.
    ipBlockConfirmed: false,
    error: status === 429
      ? 'Swiggy checkout ne rate-limit kiya (HTTP 429). Retry-After/cooldown tak auto requests rok di gayi hain; ye akela IP ban ka proof nahi hai.'
      : challenge
        ? 'Swiggy checkout ne security challenge diya. Automatic retries/fallback rok diye gaye; official Swiggy app/support mein resolve karein.'
        : 'Swiggy checkout ne access deny kiya (HTTP 403). Account, permission ya network restriction ho sakti hai; IP ban confirm nahi hai. Automatic retries/fallback temporarily rok diye gaye.'
  };
}

export function observeCheckoutResponse(response, now = Date.now()) {
  const diagnostic = classifyCheckoutResponse(response, now);
  if (diagnostic) originBlocks.set(ORIGIN, { diagnostic, until: now + diagnostic.retryAfterMs });
  return diagnostic;
}

export function checkoutCooldownResponse(now = Date.now()) {
  const block = originBlocks.get(ORIGIN);
  if (!block) return null;
  if (now >= block.until) {
    originBlocks.delete(ORIGIN);
    return null;
  }
  return { ok: false, status: block.diagnostic.httpStatus, json: null,
    networkDiagnostic: { ...block.diagnostic, retryAfterMs: block.until - now } };
}

export function checkoutFailureResult(response) {
  const diag = response?.networkDiagnostic;
  if (!diag) return null;
  return { success: false, code: diag.code, error: diag.error,
    networkDiagnostic: { ...diag } };
}
