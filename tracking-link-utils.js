// Decode transport escaping, not URL encoding: decoding a complete signed URL
// would change its token/query semantics (notably %26, %2B and %3D).
export function normalizeTrackingText(value) {
  return String(value || '').replace(/&amp;|&#0*38;|&#x0*26;/gi, '&')
    .replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=');
}
const NESTED_LINK_KEYS = new Set(['tracking_url', 'track_url', 'shareable_url', 'share_url', 'ofo_share_url', 'ofo_url', 'af_web_dp', 'af_dp', 'deep_link_value', 'redirect_url', 'url', 'link']);
const officialHost = host => ['swiggy.com', 'www.swiggy.com', 'm.swiggy.com', 'r.swiggy.com', 'swig.gy', 'swiggy.onelink.me'].includes(host.toLowerCase());
export function expandTrackingCandidates(values) {
  const out = new Set();
  const walk = (value, depth = 0) => {
    if (depth > 4 || out.size >= 40) return;
    const text = normalizeTrackingText(value);
    let url;
    try { url = new URL(text); } catch { return; }
    if (!['http:', 'https:', 'swiggy:'].includes(url.protocol)) return;
    if (url.protocol !== 'swiggy:' && !officialHost(url.hostname)) return;
    for (const [key, nested] of url.searchParams) {
      if (!NESTED_LINK_KEYS.has(key.toLowerCase())) continue;
      let decoded = nested;
      if (/^(?:https?|swiggy)%3a/i.test(decoded)) {
        try { decoded = decodeURIComponent(decoded); } catch { continue; }
      }
      walk(decoded, depth + 1);
    }
    if (/^https?:$/.test(url.protocol)) out.add(text);
  };
  for (const value of values) walk(value);
  return [...out];
}

export function trackingQueryMatchesOrder(value, orderId) {
  if (!orderId) return true;
  const walk = (text, depth = 0) => {
    if (depth > 4) return false;
    let url;
    try { url = new URL(normalizeTrackingText(text)); } catch { return false; }
    if (url.username || url.password || url.port) return false;
    if (!['http:', 'https:', 'swiggy:'].includes(url.protocol)) return false;
    if (url.protocol !== 'swiggy:' && !officialHost(url.hostname)) return false;
    for (const [key, nested] of url.searchParams) {
      if (/^(?:order_id|orderid)$/i.test(key) && nested !== String(orderId)) return false;
      if (NESTED_LINK_KEYS.has(key.toLowerCase())) {
        let decoded = nested;
        if (/^(?:https?|swiggy)%3a/i.test(decoded)) {
          try { decoded = decodeURIComponent(decoded); } catch { return false; }
        }
        if (/^(?:https?|swiggy):\/\//i.test(decoded) && !walk(decoded, depth + 1)) return false;
      }
    }
    return true;
  };
  return walk(value);
}
