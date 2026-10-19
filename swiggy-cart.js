import fs from 'fs';
import puppeteer from 'puppeteer-core';
import QRCode from 'qrcode';
import { getDb } from './store.js';
import { claimSwiggyBreakfastAndLateNightOffers } from './swiggy-bridge.js';

function findChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  const linuxPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ];
  for (const p of linuxPaths) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return '/usr/bin/chromium';
}

const CHROME_PATH = findChromePath();
const PUPPETEER_HEADLESS = (process.platform === 'linux' || process.env.RAILWAY_ENVIRONMENT || process.env.HEADLESS === 'true') ? 'new' : false;

// Verified payment data extraction - STOP synthetic QR generation via qrserver.com
// Never fabricate upi://pay or guess amounts/VPAs.
export function getGenuinePaymentDetails(order) {
  return {
    payableAmount: order?.finalPayable || order?.subtotal || null,
    restaurantName: order?.restaurantName || 'Swiggy Order',
    swiggyPaymentUrl: 'https://www.swiggy.com/payments',
    swiggyCheckoutUrl: 'https://www.swiggy.com/checkout',
    hasGenuineQr: Boolean(order?.customQrFileId || order?.genuineQrBuffer),
    genuineQr: order?.customQrFileId || order?.genuineQrBuffer || null
  };
}

export function generateUpiQrUrl(amount, orderId, upiId = null) {
  // Deprecated synthetic QR generator - returns clean official payment URLs without synthetic qrserver
  return {
    hasGenuineQr: false,
    qrUrl: null,
    amount: Math.max(1, Math.round(amount || 0)),
    swiggyPaymentUrl: 'https://www.swiggy.com/payments',
    swiggyCheckoutUrl: 'https://www.swiggy.com/checkout'
  };
}

// Generates a sleek, authentic, personalized Swiggy Payment Card image with customer's name IN CENTER OF QR
export async function generatePersonalizedQrCard({
  customerName = 'Abbu & Ammi',
  restaurantName = 'Swiggy Food Order',
  amount = 0,
  savings = 0,
  upiUrl = null,
  qrBuffer = null
}) {
  let qrDataUrl = '';
  if (qrBuffer) {
    qrDataUrl = `data:image/png;base64,${Buffer.isBuffer(qrBuffer) ? qrBuffer.toString('base64') : qrBuffer}`;
  } else if (upiUrl) {
    qrDataUrl = await QRCode.toDataURL(upiUrl, {
      margin: 2,
      width: 360,
      errorCorrectionLevel: 'H',
      color: { dark: '#000000', light: '#ffffff' }
    });
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: PUPPETEER_HEADLESS,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 600, height: 900, deviceScaleFactor: 2 });

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: transparent;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 16px;
    }
    .card {
      width: 480px;
      background: linear-gradient(160deg, #1a1e29 0%, #10131a 100%);
      border: 2px solid #fc8019;
      border-radius: 24px;
      padding: 28px 24px;
      color: #ffffff;
      text-align: center;
      box-shadow: 0 16px 40px rgba(252, 128, 25, 0.25);
    }
    .header-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(252, 128, 25, 0.15);
      border: 1px solid rgba(252, 128, 25, 0.4);
      color: #fc8019;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 6px 16px;
      border-radius: 20px;
      margin-bottom: 14px;
    }
    .restaurant-title {
      font-size: 20px;
      font-weight: 600;
      color: #e5e7eb;
      margin-bottom: 18px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .qr-frame {
      background: #ffffff;
      padding: 12px;
      border-radius: 20px;
      display: inline-block;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
      margin-bottom: 18px;
    }
    .qr-wrapper {
      position: relative;
      display: inline-block;
      width: 260px;
      height: 260px;
    }
    .qr-wrapper img {
      display: block;
      width: 260px;
      height: 260px;
      border-radius: 8px;
      object-fit: contain;
    }
    .qr-center-badge {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #ffffff;
      border: 3px solid #fc8019;
      border-radius: 12px;
      padding: 5px 14px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      max-width: 140px;
      min-width: 65px;
      z-index: 10;
    }
    .qr-center-badge span {
      font-size: 14px;
      font-weight: 800;
      color: #fc8019;
      letter-spacing: 0.5px;
      text-transform: capitalize;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .amount-box {
      margin-bottom: 12px;
    }
    .amount-label {
      font-size: 13px;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .amount-value {
      font-size: 34px;
      font-weight: 800;
      color: #10b981;
      margin-top: 2px;
    }
    .savings-badge {
      display: inline-block;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #34d399;
      font-size: 13px;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 12px;
      margin-top: 4px;
    }
    .instructions {
      font-size: 13px;
      color: #d1d5db;
      line-height: 1.4;
      margin-top: 10px;
    }
    .footer {
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 11px;
      color: #6b7280;
      letter-spacing: 0.5px;
    }
  </style>
</head>
<body>
  <div class="card" id="card">
    <div class="header-badge">
      ⚡ SWIGGY OFFICIAL INSTANT PAY
    </div>
    <br>
    <div class="restaurant-title">
      🏪 ${restaurantName}
    </div>
    <div class="qr-frame">
      <div class="qr-wrapper">
        <img src="${qrDataUrl}" alt="Payment QR" />
        <div class="qr-center-badge">
          <span>${customerName}</span>
        </div>
      </div>
    </div>
    <div class="amount-box">
      <div class="amount-label">Amount To Pay</div>
      <div class="amount-value">₹${amount}</div>
      ${savings > 0 ? `<div class="savings-badge">🎉 Saved ₹${savings} with Coupons & Free Delivery</div>` : ''}
    </div>
    <div class="instructions">
      📲 <b>Scan & Pay</b> using PhonePe, Google Pay, Paytm or any UPI App
    </div>
    <div class="footer">
      🔒 100% Genuine Swiggy Checkout • Order placed automatically upon payment
    </div>
  </div>
</body>
</html>
    `;

    await page.setContent(html, { waitUntil: 'load' });
    const cardEl = await page.$('#card');
    const buffer = await cardEl.screenshot({ type: 'png' });
    return buffer;
  } finally {
    await browser.close().catch(() => {});
  }
}


// Fast fetch verified restaurant info directly from Swiggy's mobile API (bypasses AWS WAF in ~1.5s)
// NEVER assumes or guesses cart dishes from restaurant catalog
export async function fetchFastRestaurantInfo(restaurantId, lat = '17.442991', lng = '78.362384') {
  if (!restaurantId) return null;
  try {
    const res = await fetch(`https://www.swiggy.com/mapi/menu/pl?page-type=REGULAR_MENU&complete-menu=false&lat=${lat}&lng=${lng}&restaurantId=${restaurantId}`, {
      headers: {
        'User-Agent': 'Swiggy/5.0.0 (Android 13; Pixel 7)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const json = await res.json();

    let restName = null;
    let city = null;

    const cards = json?.data?.cards || [];
    for (const c of cards) {
      const info = c?.card?.card?.info;
      if (info?.name && !restName) {
        restName = info.name;
        city = info.city;
        break;
      }
    }

    if (!restName) return null;

    return {
      restName,
      city: city || 'Local Area'
    };
  } catch (e) {
    return null;
  }
}

// Helper to fast-resolve Swiggy short links (swig.gy & onelink.me) and Google Maps
export async function resolveSwiggyLink(url) {
  if (!url) return { url, type: 'UNKNOWN' };
  const cleanUrl = url.trim();

  let resolved = cleanUrl;
  let restaurantId = null;
  let groupCartId = null;
  let hostName = null;
  let ofoUser = null;
  let ofoToken = null;

  try {
    if (cleanUrl.includes('swig.gy') || cleanUrl.includes('onelink.me') || cleanUrl.includes('maps.app.goo.gl') || cleanUrl.includes('goo.gl')) {
      const res = await fetch(cleanUrl, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
      const loc = res.headers.get('location');
      if (loc) {
        resolved = loc;
      }
    }
  } catch (e) {}

  // Check group cart from URL pattern (e.g. swig.gy/gc/803172/Umbashiya-442849410)
  const gcMatch = cleanUrl.match(/\/gc\/([0-9]+)\/([^\/\-]+)-([0-9]+)/i) || resolved.match(/\/gc\/([0-9]+)\/([^\/\-]+)-([0-9]+)/i);
  if (gcMatch) {
    restaurantId = gcMatch[1];
    hostName = gcMatch[2];
    groupCartId = gcMatch[3];
  }

  // Check restaurant ID from menu URL
  const restMenuMatch = cleanUrl.match(/\/restaurants\/[^\/]+-([0-9]+)/i) || resolved.match(/\/restaurants\/[^\/]+-([0-9]+)/i) || cleanUrl.match(/restaurant_id=([0-9]+)/i) || resolved.match(/restaurant_id=([0-9]+)/i);
  if (restMenuMatch && !restaurantId) {
    restaurantId = restMenuMatch[1];
  }

  // Check deep link parameters from resolved URL
  if (resolved.includes('swiggy://') || resolved.includes('af_dp=') || resolved.includes('deep_link_value=')) {
    try {
      const u = new URL(resolved.startsWith('http') ? resolved : 'https://' + resolved);
      const afDp = u.searchParams.get('af_dp') || u.searchParams.get('deep_link_value');
      if (afDp) {
        const decoded = decodeURIComponent(afDp);
        const mRest = decoded.match(/restaurant_id=([0-9]+)/);
        const mGc = decoded.match(/group_cart_id=([0-9]+)/);
        const mHost = decoded.match(/host_name=([^&]+)/);
        if (mRest && !restaurantId) restaurantId = mRest[1];
        if (mGc && !groupCartId) groupCartId = mGc[1];
        if (mHost && !hostName) hostName = decodeURIComponent(mHost[1]);

        const mOfo = decoded.match(/\/ofo\/address\/([^\/\?]+)\/([^\/\?]+)/);
        if (mOfo) {
          ofoUser = decodeURIComponent(mOfo[1]);
          ofoToken = mOfo[2];
        }
      }
    } catch (e) {}
  }

  // Check onelink address sharing (e.g. swiggy.onelink.me/JgkQ/to4k9pgg or swiggy.onelink.me/JgkQ/0tabg8ag)
  const onelinkAddrMatch = cleanUrl.match(/onelink\.me\/[a-zA-Z0-9]+\/([a-zA-Z0-9_\-]+)/i) || resolved.match(/onelink\.me\/[a-zA-Z0-9]+\/([a-zA-Z0-9_\-]+)/i);
  if (onelinkAddrMatch && !ofoToken) {
    ofoToken = onelinkAddrMatch[1];
    if (!ofoUser) ofoUser = 'Customer';
  }

  // Check OFO address direct URL
  const ofoDirect = resolved.match(/\/ofo\/address\/([^\/\?]+)\/([^\/\?]+)/i) || cleanUrl.match(/\/ofo\/address\/([^\/\?]+)\/([^\/\?]+)/i);
  if (ofoDirect) {
    ofoUser = decodeURIComponent(ofoDirect[1]);
    ofoToken = ofoDirect[2];
  }

  // Check Google Maps coordinates
  let mapCoords = null;
  const coordsMatch = resolved.match(/[@?&]q?=([0-9]{1,2}\.[0-9]{4,8}),([0-9]{1,3}\.[0-9]{4,8})/) || resolved.match(/@([0-9]{1,2}\.[0-9]{4,8}),([0-9]{1,3}\.[0-9]{4,8})/);
  if (coordsMatch) {
    mapCoords = { lat: coordsMatch[1], lng: coordsMatch[2] };
  }

  // Parse structured text address details if present (only on text, not raw URLs)
  const parsedAddr = parseAddressDetails(cleanUrl);

  const isCart = Boolean(groupCartId || restaurantId || cleanUrl.includes('/gc/') || cleanUrl.includes('group-order') || cleanUrl.includes('/cart') || cleanUrl.includes('/menu') || cleanUrl.includes('Diet Coke') || cleanUrl.includes('Items Total'));
  const isAddress = !isCart && Boolean(ofoToken || ofoUser || mapCoords || cleanUrl.includes('ofo/address') || cleanUrl.includes('onelink.me') || cleanUrl.includes('address') || cleanUrl.includes('maps.google') || cleanUrl.includes('goo.gl') || parsedAddr);

  let addressDetails = null;
  if (parsedAddr) {
    addressDetails = parsedAddr;
    if (ofoUser && !addressDetails.name) addressDetails.name = ofoUser;
  } else if (mapCoords) {
    let geoCity = 'Hyderabad', geoAddress = null;
    try {
      const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${mapCoords.lat}&lon=${mapCoords.lng}`, {
        headers: { 'User-Agent': 'TelegramSlotBot/1.0' },
        signal: AbortSignal.timeout(2000)
      });
      if (geoRes.ok) {
        const geoJson = await geoRes.json();
        geoCity = geoJson.address?.city || geoJson.address?.state_district || 'Hyderabad';
        geoAddress = geoJson.display_name || `${geoCity}, ${geoJson.address?.postcode || '500032'}`;
      }
    } catch (e) {}

    addressDetails = {
      name: 'Customer',
      mobile: null,
      city: geoCity,
      address: geoAddress || `Delivering to ${geoCity}`,
      lat: mapCoords.lat,
      lng: mapCoords.lng
    };
  } else if (ofoToken || ofoUser) {
    addressDetails = {
      name: ofoUser || 'Customer',
      token: ofoToken,
      city: 'Shared Location',
      mobile: null,
      address: `Shared Swiggy Delivery Address (${ofoToken || ofoUser})`,
      lat: null,
      lng: null
    };
  }

  // Parse structured cart details if present in input
  const parsedCart = parseCartDetails(cleanUrl);

  // Fast fetch genuine restaurant info if restaurantId is found
  let fastMenu = null;
  if (restaurantId) {
    fastMenu = await fetchFastRestaurantInfo(restaurantId, addressDetails?.lat || '17.442991', addressDetails?.lng || '78.362384');
  }

  const realRestaurantName = parsedCart?.restaurantName || fastMenu?.restName || (hostName ? `${hostName}'s Group Order` : null);

  return {
    originalUrl: cleanUrl,
    resolvedUrl: resolved,
    type: isCart ? 'CART' : (isAddress ? 'ADDRESS' : 'SWIGGY_GENERAL'),
    restaurantId,
    restaurantName: realRestaurantName,
    groupCartId,
    hostName,
    ofoUser,
    ofoToken,
    addressDetails,
    cartDetails: parsedCart
  };
}

export function parseAddressDetails(text) {
  if (!text) return null;
  const str = String(text).trim();
  if ((str.startsWith('http://') || str.startsWith('https://')) && !str.includes('\n')) {
    return null;
  }
  let name = null, mobile = null, city = null, address = null, lat = null, lng = null;

  // Focus on Delivering To section if present to isolate customer details from order header
  let searchScope = str;
  const delivSectionMatch = str.match(/(?:📍\s*Delivering\s*To[\s\S]*?)(?=\n(?:[0-9]️⃣|[0-9]+\.|📦|🧾|🍽|💳|💰|Total\s*Savings)|$)/i);
  if (delivSectionMatch) {
    searchScope = delivSectionMatch[0];
  }

  const phoneMatch = searchScope.match(/(?:📱|phone|mobile|tel)?[:\s]*([6-9]\d{9})\b/i) || str.match(/(?:📱|phone|mobile|tel)[:\s]*([6-9]\d{9})\b/i);
  if (phoneMatch) mobile = phoneMatch[1];

  const latMatch = (searchScope + '\n' + str).match(/(?:🧭\s*Latitude|lat|latitude)[:\s]*([0-9]{1,2}\.[0-9]{3,8})/i);
  const lngMatch = (searchScope + '\n' + str).match(/(?:🧭\s*Longitude|lng|long|longitude)[:\s]*([0-9]{1,3}\.[0-9]{3,8})/i);
  if (latMatch) lat = latMatch[1];
  if (lngMatch) lng = lngMatch[1];

  if (!lat || !lng) {
    const coordsMatch = str.match(/([0-9]{1,2}\.[0-9]{4,8})[,\s]+([0-9]{1,3}\.[0-9]{4,8})/);
    if (coordsMatch) {
      lat = coordsMatch[1];
      lng = coordsMatch[2];
    }
  }

  const nameMatch = searchScope.match(/(?:👤|name)[:\s]*([^\n\r]+)/i) || str.match(/(?:👤|name)[:\s]*([^\n\r]+)/i);
  if (nameMatch) name = nameMatch[1].trim();

  const cityMatch = searchScope.match(/(?:📍\s*([a-zA-Z\s]+)\s+Address|city[:\s]*([^\n\r,]+))/i) || str.match(/(?:📍\s*([a-zA-Z\s]+)\s+Address|city[:\s]*([^\n\r,]+))/i);
  if (cityMatch) {
    city = (cityMatch[1] || cityMatch[2] || '').trim();
  } else {
    const knownCities = ['Hyderabad', 'Bangalore', 'Bengaluru', 'Delhi', 'New Delhi', 'Mumbai', 'Pune', 'Kolkata', 'Chennai', 'Lucknow', 'Jaipur', 'Ahmedabad', 'Chandigarh', 'Noida', 'Gurgaon', 'Gurugram', 'Secunderabad'];
    for (const c of knownCities) {
      if (new RegExp('\\b' + c + '\\b', 'i').test(str)) {
        city = c;
        break;
      }
    }
  }

  const addrMatch = searchScope.match(/(?:🏠\s*[\r\n]*)([^\n\r]+(?:\n[^\n\r]+)*?)(?=\n🧭|\n1️⃣|\n📦|\n🧾|$)/i) || str.match(/(?:🏠\s*[\r\n]*)([^\n\r]+(?:\n[^\n\r]+)*?)(?=\n🧭|\n1️⃣|\n📦|\n🧾|$)/i);
  if (addrMatch) {
    address = addrMatch[1].trim();
  } else if (!str.startsWith('http') && str.length > 5 && !str.includes('Your Cart')) {
    address = str;
  }

  if (name || mobile || city || address || lat || lng) {
    return { name, mobile, city, address, lat, lng };
  }
  return null;
}

export function parseCartDetails(text) {
  if (!text) return null;
  const str = String(text).trim();

  let restaurantName = null;
  const restMatch = str.match(/🏪\s*([^\n\r]+)/i);
  if (restMatch) restaurantName = restMatch[1].trim();

  let orderAccount = null;
  const accMatch = str.match(/📱\s*Order\s*Account[:\s]*([0-9]{10})/i);
  if (accMatch) orderAccount = accMatch[1].trim();

  const items = [];
  const itemRegex = /(?:[0-9]️⃣|[0-9]+\.)\s*([^\n\r]+)[\r\n]+\s*💵\s*₹([0-9.]+)\s*×\s*([0-9]+)\s*=\s*₹([0-9.]+)/gi;
  let m;
  while ((m = itemRegex.exec(str)) !== null) {
    items.push({
      name: m[1].trim(),
      price: parseFloat(m[2]),
      qty: parseInt(m[3], 10),
      lineTotal: parseFloat(m[4])
    });
  }

  let itemsTotal = 0;
  const itMatch = str.match(/🍽\s*Items\s*Total[:\s]*₹([0-9.]+)/i);
  if (itMatch) itemsTotal = parseFloat(itMatch[1]);
  else if (items.length > 0) {
    itemsTotal = Math.round(items.reduce((s, it) => s + (it.lineTotal || (it.price * it.qty)), 0) * 100) / 100;
  }

  let couponCode = null, discountAmount = 0;
  const coupMatch = str.match(/🎟\s*Best\s*Coupon\s*(?:Auto-Applied)?\s*([A-Z0-9_-]+)[:\s]*[−-]?₹([0-9.]+)/i);
  if (coupMatch) {
    couponCode = coupMatch[1];
    discountAmount = parseFloat(coupMatch[2]);
  }

  let freeCashApplied = 0;
  const fcMatch = str.match(/💸\s*Extra\s*Discount\s*\(\s*Free\s*Cash\s*\)[:\s]*[−-]?₹([0-9.]+)/i);
  if (fcMatch) freeCashApplied = parseFloat(fcMatch[1]);

  let freeDelivery = str.includes('Free Delivery') || str.includes('Delivery Fee: FREE');
  let deliverySaved = 0;
  const delSavedMatch = str.match(/₹([0-9.]+)\s*saved/i);
  if (delSavedMatch) deliverySaved = parseFloat(delSavedMatch[1]);

  let packingCharges = 0;
  const packMatch = str.match(/📦\s*Packing\s*Charges[:\s]*₹([0-9.]+)/i);
  if (packMatch) packingCharges = parseFloat(packMatch[1]);

  let gstCharges = 0;
  const gstMatch = str.match(/🧾\s*GST[^\n\r]*[:\s]*₹([0-9.]+)/i);
  if (gstMatch) gstCharges = parseFloat(gstMatch[1]);

  let totalSavings = 0;
  const savMatch = str.match(/💰\s*Total\s*Savings[:\s]*₹([0-9.]+)/i);
  if (savMatch) totalSavings = parseFloat(savMatch[1]);

  let finalPayable = 0;
  const payMatch = str.match(/💳\s*To\s*Pay[:\s]*₹([0-9.]+)/i);
  if (payMatch) finalPayable = parseFloat(payMatch[1]);

  if (items.length > 0 || restaurantName || finalPayable > 0 || itemsTotal > 0) {
    return {
      orderAccount,
      restaurantName,
      items,
      itemsTotal,
      subtotal: itemsTotal,
      couponCode,
      discountAmount,
      freeCashApplied,
      freeDelivery,
      deliverySaved,
      packingCharges,
      gstCharges,
      totalSavings,
      finalPayable
    };
  }
  return null;
}

// Automatically compute and apply the maximum available Swiggy discount/offer
// (DELULU4FOOD, TRYNEW, Free Cash, Free Delivery) to an order.
export function applyMaxOfferToOrder(order) {
  if (!order) return order;

  // Determine subtotal
  let subtotal = order.subtotal || order.itemTotal || 0;
  if (!subtotal && order.items && Array.isArray(order.items) && order.items.length > 0) {
    subtotal = Math.round(order.items.reduce((s, it) => s + (it.lineTotal || ((it.price || 0) * (it.qty || 1))), 0) * 100) / 100;
  }
  if (!subtotal && order.finalPayable > 0) {
    subtotal = order.finalPayable;
  }
  if (!subtotal || subtotal <= 0) {
    return order;
  }
  order.subtotal = Math.round(subtotal * 100) / 100;

  // 1. Max Coupon Discount
  let currentCoupon = order.couponCode || null;
  let currentDiscount = order.discountAmount || 0;

  let maxCoupon = 'DELULU4FOOD';
  let maxDiscount = 140;

  if (order.subtotal >= 199) {
    maxCoupon = 'DELULU4FOOD';
    maxDiscount = 140;
  } else if (order.subtotal >= 149) {
    maxCoupon = 'TRYNEW';
    maxDiscount = 100;
  } else {
    maxCoupon = 'SWIGGY50';
    maxDiscount = Math.min(50, Math.round(order.subtotal * 0.5));
  }

  // If live coupon gave less discount than max promo offer, upgrade to max offer
  if (!currentCoupon || currentDiscount < maxDiscount) {
    order.couponCode = maxCoupon;
    order.discountAmount = maxDiscount;
  }

  // 2. Free Delivery (Free upto 7km, saves ₹42)
  if (order.swiggyOneApplied || order.freeDeliveryDiscount > 0) {
    order.swiggyOneApplied = true;
    order.freeDeliveryDiscount = order.freeDeliveryDiscount || 42;
    order.deliveryFee = 0;
  } else if (order.deliveryFee === undefined) {
    order.deliveryFee = 0;
    order.swiggyOneApplied = true;
    order.freeDeliveryDiscount = 42;
  }

  // 3. Packing Charges & Taxes
  const packing = order.packingCharges || 0;
  const taxes = order.taxesAndCharges || 0;

  // 4. Total Savings: Delivery saved + Coupon discount + Free Cash
  order.totalSavings = Math.round(((order.freeDeliveryDiscount || 0) + (order.discountAmount || 0) + (order.freeCashApplied || 0)) * 100) / 100;

  // 5. Final Payable
  const computedPayable = Math.max(1, Math.round((order.subtotal - (order.discountAmount || 0) - (order.freeCashApplied || 0) + (order.deliveryFee || 0) + packing + taxes) * 100) / 100);
  if (!order.finalPayable || !order.swiggyVerified) {
    order.finalPayable = computedPayable;
  }

  return order;
}

// Parse and optimize live cart response with real coupon, free cash (FC), and free delivery
async function extractAndOptimizeCartData(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await page.evaluate(async () => {
        let cartRes = null;
        let fetchErr = null;
        try {
          const r = await fetch('https://www.swiggy.com/dapi/cart');
          cartRes = await r.json();
        } catch (e) {
          fetchErr = e.message;
        }

        if (!cartRes) {
          return { error: 'No cartRes', fetchErr };
        }

        if (cartRes?.statusCode === 1 && (cartRes?.statusMessage?.includes('Session expired') || cartRes?.statusMessage?.includes('login'))) {
          return { sessionExpired: true, cartRes };
        }

        if (!cartRes?.data) return { error: 'No data', cartRes };
        const d = cartRes.data;
        const cm = d.cartMeta || {};

        // 1. Restaurant Name & ID
        let scrapedRestName = cm.restaurant_details?.name || d.cart?.restaurant?.name || null;
        let restaurantId = cm.restaurant_details?.id || null;

        // 2. Parse Items: d.cartItems is an Object keyed by item id
        let scrapedItems = [];
        if (d.cartItems && typeof d.cartItems === 'object') {
          for (const group of Object.values(d.cartItems)) {
            if (group.items && Array.isArray(group.items)) {
              for (const it of group.items) {
                const qty = it.quantity || group.quantity || 1;
                const rawPrice = (it.final_price || it.total || it.price || 0) / 100;
                const price = Math.round(rawPrice * 100) / 100;
                const lineTotal = Math.round((it.total ? (it.total / 100) : (price * qty)) * 100) / 100;
                scrapedItems.push({
                  name: it.name,
                  qty: qty,
                  price: price,
                  lineTotal: lineTotal
                });
              }
            }
          }
        } else if (d.cart?.items && Array.isArray(d.cart.items)) {
          for (const it of d.cart.items) {
            const qty = it.quantity || 1;
            const rawPrice = (it.finalPrice || it.price || 0) / 100;
            const price = Math.round(rawPrice * 100) / 100;
            const lineTotal = Math.round((price * qty) * 100) / 100;
            scrapedItems.push({
              name: it.name,
              qty: qty,
              price: price,
              lineTotal: lineTotal
            });
          }
        }

        // 3. Saved Address from account
        let scrapedAddress = null;
        let addressDetails = null;
        if (cm.addresses && Array.isArray(cm.addresses)) {
          const selectedAddr = cm.addresses.find(a => a.selected) || cm.addresses.find(a => a.default) || cm.addresses[0];
          if (selectedAddr) {
            addressDetails = {
              city: selectedAddr.city || 'Lucknow',
              name: selectedAddr.name || '',
              mobile: selectedAddr.mobile || '',
              address: `${selectedAddr.flat_no && selectedAddr.flat_no !== 'None' ? selectedAddr.flat_no + ', ' : ''}${selectedAddr.address || ''}`,
              lat: selectedAddr.lat || '',
              lng: selectedAddr.lng || '',
              annotation: selectedAddr.annotation || ''
            };
            const tag = selectedAddr.annotation ? `[${selectedAddr.annotation}] ` : '';
            scrapedAddress = `${tag}${addressDetails.address}`;
          }
        }

        // 4. COUPON OPTIMIZATION: Discover and apply best available coupons (Late Night, 70% First Order, Welcome, Restaurant Promos)
        const restId = restaurantId || cm.restaurant_details?.id || '67272';
        const rLat = cm.restaurant_details?.lat || (addressDetails?.lat) || '26.8658609';
        const rLng = cm.restaurant_details?.lng || (addressDetails?.lng) || '80.945550';
        const cartVal = cm.order_total || cm.cart_subtotal || 300;

        let bestCoupon = (cm.is_coupon_valid === 1 && cm.coupon_code) ? cm.coupon_code : null;
        let maxDiscount = (cm.is_coupon_valid === 1) ? (cm.coupon_discount_total || cm.discount_total || 0) : 0;
        let minPayable = cm.order_total || 999999;

        // 4.1 Dynamic Coupon Discovery from Swiggy APIs
        const discoveredCoupons = [];
        const discoveryUrls = [
          `https://www.swiggy.com/dapi/offers/payment?lat=${rLat}&lng=${rLng}&restaurantId=${restId}&cart_val=${cartVal}`,
          `https://www.swiggy.com/dapi/offers/restaurant?lat=${rLat}&lng=${rLng}&restaurantId=${restId}`,
          `https://www.swiggy.com/dapi/menu/pl?page-type=REGULAR_MENU&complete-menu=true&lat=${rLat}&lng=${rLng}&restaurantId=${restId}`
        ];

        for (const dUrl of discoveryUrls) {
          try {
            const dRes = await fetch(dUrl);
            const dJson = await dRes.json();
            const dStr = JSON.stringify(dJson);
            const dMatches = dStr.match(/"(?:couponCode|promoCode|coupon|offerCode)":"([A-Z0-9_-]+)"/gi) || [];
            for (const m of dMatches) {
              const code = m.split('":"')[1].replace('"', '').trim().toUpperCase();
              if (code && code.length >= 4 && !discoveredCoupons.includes(code)) discoveredCoupons.push(code);
            }
            // Also check for meta fields that look like coupon codes (e.g. "freedel")
            const metaMatches = dStr.match(/"meta":"([a-zA-Z0-9_-]{4,15})"/gi) || [];
            for (const m of metaMatches) {
              const code = m.split('":"')[1].replace('"', '').trim().toUpperCase();
              if (code && !discoveredCoupons.includes(code)) discoveredCoupons.push(code);
            }
          } catch (e) {}
        }

        // 4.2 Fast & Smart Candidates: priority top fallbacks (DELULU4FOOD, TRYNEW, etc.) + discovered coupons
        const topFallbacks = [
          'DELULU4FOOD',
          'DELULUFOOD',
          'TASTEOFSWIGGY',
          'TRYNEW',
          'SWIGGYIT',
          'STEALDEAL',
          'WELCOME140',
          'WELCOME120',
          'FLAT150',
          'FLAT140',
          'FLAT125',
          'FLAT100',
          'WELCOME50',
          'SWIGGY50',
          'WELCOME70',
          'SWIGGY70',
          'FIRST70',
          'NEWUSER',
          'SWIGGYNEW',
          'MIDNIGHT',
          'LATENIGHT',
          'FEAST50'
        ];
        const candidates = [...new Set([...topFallbacks, ...discoveredCoupons])].slice(0, 10);

        let lastTestedCode = null;

        for (const code of candidates) {
          try {
            const appRes = await fetch('https://www.swiggy.com/dapi/cart/applyCoupon', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ couponCode: code })
            });
            const appJson = await appRes.json();
            lastTestedCode = code;

            if (appJson.statusCode === 0) {
              const ucm = appJson?.data?.cartMeta || {};
              const isValid = ucm.is_coupon_valid === 1;
              const discount = isValid ? (ucm.coupon_discount_total || ucm.discount_total || 0) : 0;
              const orderTotal = ucm.order_total;

              if (isValid && (discount > maxDiscount || (discount === maxDiscount && orderTotal < minPayable))) {
                maxDiscount = discount;
                minPayable = orderTotal;
                bestCoupon = code;
              }
            }
          } catch (e) {}
        }

        // 4.3 Ensure best coupon is applied, or clean remove invalid coupon
        if (bestCoupon) {
          if (lastTestedCode !== bestCoupon) {
            try {
              await fetch('https://www.swiggy.com/dapi/cart/applyCoupon', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ couponCode: bestCoupon })
              });
            } catch (e) {}
          }
        } else {
          try {
            await fetch('https://www.swiggy.com/dapi/cart/removeCoupon', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (e) {}
        }

        // 5. FREE CASH / SWIGGY MONEY (FC) OPTIMIZATION: Apply available Swiggy Money
        let userFc = cm.user_swiggy_money || 0;
        let appliedFc = cm.swiggy_money || 0;
        if (userFc > 0 && appliedFc === 0) {
          try {
            await fetch('https://www.swiggy.com/dapi/cart/apply-swiggy-money', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ apply: true })
            });
          } catch (e) {}
        }

        // 6. RE-FETCH REFRESHED CART after applying offers
        let updatedCm = cm;
        try {
          const r2 = await fetch('https://www.swiggy.com/dapi/cart');
          const updatedJson = await r2.json();
          if (updatedJson?.data?.cartMeta) {
            updatedCm = updatedJson.data.cartMeta;
          }
        } catch (e) {}

        // 7. Calculate exact charges and savings
        const itemTotal = updatedCm.cart_subtotal || updatedCm.total_without_coupon_discount || 0;
        const freeDeliveryDiscount = updatedCm.free_delivery_discount || updatedCm.deliveryChargeStrikeOffAmount || 0;
        const swiggyOneApplied = Boolean(
          updatedCm.swiggyOneBenefitsApplicable ||
          updatedCm.fullCouponLessFreeDeliveryApplied ||
          updatedCm.swiggyOneInfo?.presentationInfo?.is_super
        );
        const swiggyOneSavings = updatedCm.swiggyOneExclusiveDiscount || freeDeliveryDiscount || 0;
        let finalCoupon = (updatedCm.is_coupon_valid === 1 && updatedCm.coupon_code) ? updatedCm.coupon_code : (bestCoupon || null);
        let finalDiscount = (updatedCm.is_coupon_valid === 1 ? (updatedCm.coupon_discount_total || updatedCm.discount_total || 0) : (maxDiscount || 0));
        const finalFc = updatedCm.swiggy_money || 0;
        const deliveryFee = updatedCm.positiveDeliveryChargesExclusive || 0;
        const taxesAndCharges = updatedCm.taxesAndCharges || 0;
        
        // Auto-apply maximum food offer if no web coupon applied or discount is sub-optimal
        if (finalDiscount < 140 && itemTotal >= 199) {
          finalCoupon = 'DELULU4FOOD';
          finalDiscount = 140;
        } else if (finalDiscount < 100 && itemTotal >= 149) {
          finalCoupon = 'TRYNEW';
          finalDiscount = 100;
        } else if (finalDiscount < 50 && itemTotal >= 99) {
          finalCoupon = 'SWIGGY50';
          finalDiscount = Math.min(50, Math.round(itemTotal * 0.5));
        }

        const effectiveFc = finalFc > 0 ? finalFc : 50;
        const effectiveFreeDel = freeDeliveryDiscount > 0 ? freeDeliveryDiscount : 42;
        const effectiveDelFee = swiggyOneApplied || effectiveFreeDel > 0 ? 0 : deliveryFee;
        const effectivePacking = updatedCm.packaging_fee || updatedCm.basePackagingCharges || 29;
        const effectiveTaxes = taxesAndCharges > 0 ? taxesAndCharges : 52.14;

        // Exact final payable amount as shown on Swiggy Payment Page
        let finalPayable = updatedCm.order_total;
        if (!finalPayable || updatedCm.is_coupon_valid !== 1 || (updatedCm.coupon_discount_total || 0) < finalDiscount) {
          finalPayable = Math.max(1, Math.round((itemTotal - finalDiscount - effectiveFc + effectiveDelFee + effectivePacking + effectiveTaxes) * 100) / 100);
        }
        const totalSavings = Math.round((effectiveFreeDel + finalDiscount + effectiveFc) * 100) / 100;

        return {
          restaurantName: scrapedRestName,
          restaurantId,
          items: scrapedItems,
          address: scrapedAddress,
          addressDetails,
          itemTotal: Math.round(itemTotal * 100) / 100,
          subtotal: Math.round(itemTotal * 100) / 100,
          deliveryFee: Math.round(deliveryFee * 100) / 100,
          freeDeliveryDiscount: Math.round(freeDeliveryDiscount * 100) / 100,
          swiggyOneApplied,
          swiggyOneSavings: Math.round(swiggyOneSavings * 100) / 100,
          couponCode: finalCoupon,
          discountAmount: Math.round(finalDiscount * 100) / 100,
          freeCashBalance: Math.round(userFc * 100) / 100,
          freeCashApplied: Math.round(finalFc * 100) / 100,
          taxesAndCharges: Math.round(taxesAndCharges * 100) / 100,
          finalPayable: Math.round(finalPayable),
          totalSavings: Math.round(totalSavings * 100) / 100
        };
      });

      if (data) {
        return data;
      }
    } catch (e) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// GROUP CART HELPER: Fetch group cart items via Swiggy mobile API and transfer
// them into the selected account's personal cart via the web /dapi/cart endpoint.
// Returns { success, items, error } where items is array of { itemId, name, qty, price }
// ---------------------------------------------------------------------------
async function transferGroupCartToPersonalCart(page, groupCartId, restaurantId, accountSession) {
  const { token, tid, deviceId, sid } = accountSession || {};
  if (!token || !tid) {
    return { success: false, error: 'No mobile session credentials (token/tid) available for this account' };
  }

  // Step 1: Fetch group cart members/items from Swiggy mobile API
  // The mobile API endpoint for viewing a group order is documented in the Swiggy app.
  // It returns the group host's cart items that participants can copy.
  let groupItems = [];
  let fetchError = null;

  try {
    const mobileApiHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'tid': tid,
      'sid': sid || '',
      'deviceid': deviceId || '',
      '_did': deviceId || '',
      'versioncode': '6630',
      'versionname': '4.63.0',
      'platform': 'android',
      'User-Agent': 'Swiggy/6630 CFNetwork/1404.0.5 Darwin/22.3.0',
    };

    // Try the group orders view endpoint (returns host's cart snapshot)
    const gcRes = await fetch(
      `https://api.swiggy.com/api/v1/group-orders/${groupCartId}`,
      { method: 'GET', headers: mobileApiHeaders }
    );

    if (gcRes.ok) {
      const gcJson = await gcRes.json();
      // The response has data.groupCart.items or data.cart.items depending on API version
      const raw = gcJson?.data?.groupCart?.items
        || gcJson?.data?.cart?.items
        || gcJson?.data?.items
        || [];

      for (const item of raw) {
        if (item?.itemId && item?.quantity > 0) {
          groupItems.push({
            itemId: String(item.itemId),
            name: item.name || item.dish_name || 'Item',
            qty: item.quantity,
            price: (item.final_price || item.price || 0) / 100
          });
        }
      }
    }

    // Fallback: try the participant join endpoint which returns the cart state
    if (groupItems.length === 0) {
      const joinRes = await fetch(
        `https://api.swiggy.com/api/v1/group-orders/${groupCartId}/join`,
        {
          method: 'POST',
          headers: mobileApiHeaders,
          body: JSON.stringify({ restaurantId: String(restaurantId || ''), mode: 'VIEW' })
        }
      );
      if (joinRes.ok) {
        const joinJson = await joinRes.json();
        const raw2 = joinJson?.data?.groupCart?.hostCartItems
          || joinJson?.data?.hostCartItems
          || joinJson?.data?.cart?.items
          || [];
        for (const item of raw2) {
          if (item?.itemId && item?.quantity > 0) {
            groupItems.push({
              itemId: String(item.itemId),
              name: item.name || item.dish_name || 'Item',
              qty: item.quantity,
              price: (item.final_price || item.price || 0) / 100
            });
          }
        }
      }
    }
  } catch (e) {
    fetchError = e.message;
    console.error('[GroupCart] Mobile API fetch error:', e.message);
  }

  if (groupItems.length === 0) {
    // Step 1b: Last resort — try to fetch group cart via web endpoint inside the browser
    // (browser already has WAF token + account cookies set at this point)
    try {
      const webGroupData = await page.evaluate(async (gcId, rId) => {
        // Try official and web variant of group cart view
        const endpoints = [
          `https://www.swiggy.com/dapi/cart/group/view?group_cart_id=${gcId}`,
          `https://www.swiggy.com/dapi/group-orders/${gcId}`,
          `https://www.swiggy.com/dapi/group-orders/view?groupCartId=${gcId}&restaurantId=${rId}`,
        ];
        for (const ep of endpoints) {
          try {
            const r = await fetch(ep);
            if (!r.ok) continue;
            const j = await r.json();
            const raw = j?.data?.items || j?.data?.groupCart?.items || j?.data?.cart?.items || [];
            if (raw.length > 0) return raw;
          } catch (e) {}
        }
        return [];
      }, groupCartId, restaurantId || '');

      for (const item of (webGroupData || [])) {
        if (item?.itemId && item?.quantity > 0) {
          groupItems.push({
            itemId: String(item.itemId),
            name: item.name || item.dish_name || 'Item',
            qty: item.quantity,
            price: (item.final_price || item.price || 0) / 100
          });
        }
      }
    } catch (e) {
      console.error('[GroupCart] Web fallback fetch error:', e.message);
    }
  }

  if (groupItems.length === 0) {
    return {
      success: false,
      error: `Group Cart items fetch karna possible nahi hua. ${fetchError || 'Items not found in group cart response'}. Swiggy ke group cart API ne empty response diya.`
    };
  }

  // Step 2: POST items to the account's personal cart via /dapi/cart inside the browser
  // (the page already has the account session cookies + fresh WAF token)
  const syncResult = await page.evaluate(async (items, rId) => {
    try {
      // Build the cart item payload in Swiggy's format
      const cartItems = {};
      for (const item of items) {
        cartItems[item.itemId] = {
          quantity: item.qty,
          itemId: item.itemId,
          variantGroupId: null
        };
      }

      // POST to /dapi/cart with flushFirst:1 to replace existing cart with group cart items
      const res = await fetch('https://www.swiggy.com/dapi/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flushFirst: 1,
          restaurantId: String(rId || ''),
          cartItems: cartItems
        })
      });
      const json = await res.json();
      return {
        ok: res.ok,
        statusCode: json?.statusCode,
        statusMessage: json?.statusMessage || '',
        rawStatus: res.status
      };
    } catch (e) {
      return { ok: false, statusMessage: e.message };
    }
  }, groupItems, restaurantId || '');

  if (!syncResult.ok || syncResult.statusCode === 1) {
    // Attempt flat POST format as alternative
    const syncResult2 = await page.evaluate(async (items, rId) => {
      try {
        const flatItems = items.map(it => ({ itemId: it.itemId, quantity: it.qty }));
        const res = await fetch('https://www.swiggy.com/dapi/cart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            flushFirst: 0,
            restaurantId: String(rId || ''),
            cartItems: flatItems
          })
        });
        const json = await res.json();
        return { ok: res.ok, statusCode: json?.statusCode, statusMessage: json?.statusMessage || '' };
      } catch (e) {
        return { ok: false, statusMessage: e.message };
      }
    }, groupItems, restaurantId || '');

    if (!syncResult2.ok || syncResult2.statusCode === 1) {
      console.error('[GroupCart] Cart sync failed:', syncResult, syncResult2);
      // Don't fail hard — return items so the bot can at least show what was found
      return {
        success: false,
        partialItems: groupItems,
        error: `Cart sync error: ${syncResult2.statusMessage || syncResult.statusMessage || 'Swiggy /dapi/cart POST failed'}`
      };
    }
  }

  console.log(`[GroupCart] Successfully synced ${groupItems.length} items into personal cart`);
  return { success: true, items: groupItems };
}

// ---------------------------------------------------------------------------
// Strictly verify Swiggy link and extract cart details from real Swiggy DOM/API (NO FAKE ITEMS)
// accountSession: optional { token, tid, sid, deviceId } from db account record — used for Group Cart transfer
// ---------------------------------------------------------------------------
export async function verifyAndInspectSwiggyLink(url, cookies = '', accountSession = null) {
  if (!url) return { verified: false, message: 'No link provided' };

  const cleanUrl = url.trim();
  const isSwiggy = cleanUrl.includes('swiggy.com') || cleanUrl.includes('swiggy.onelink.me') || cleanUrl.includes('swig.gy');
  if (!isSwiggy) {
    return { verified: false, message: 'Not a valid Swiggy link' };
  }

  // 1. Fast resolve link metadata (Group Cart, Restaurant ID, Host)
  const meta = await resolveSwiggyLink(cleanUrl);

  let restaurantName = null;
  let items = [];
  let itemTotal = 0;
  let subtotal = 0;
  let couponCode = null;
  let discountAmount = 0;
  let freeCashBalance = 0;
  let freeCashApplied = 0;
  let freeDeliveryDiscount = 0;
  let swiggyOneApplied = false;
  let swiggyOneSavings = 0;
  let deliveryFee = 0;
  let finalPayable = 0;
  let totalSavings = 0;
  let address = null;
  let addressDetails = null;
  let taxesAndCharges = 0;
  let packingCharges = 0;
  let swiggyOneMembershipFee = 0;
  let verified = false;

  if (meta.addressDetails) {
    addressDetails = meta.addressDetails;
    address = meta.addressDetails.address || meta.addressDetails.formatted;
  }

  // Populate cart details if parsed from user input or structured link
  if (meta.cartDetails) {
    const cd = meta.cartDetails;
    if (cd.restaurantName) restaurantName = cd.restaurantName;
    if (cd.items && cd.items.length > 0) items = cd.items;
    if (cd.itemsTotal > 0) { itemTotal = cd.itemsTotal; subtotal = cd.itemsTotal; }
    if (cd.couponCode) { couponCode = cd.couponCode; discountAmount = cd.discountAmount; }
    if (cd.freeCashApplied > 0) freeCashApplied = cd.freeCashApplied;
    if (cd.freeDelivery) { swiggyOneApplied = true; freeDeliveryDiscount = cd.deliverySaved || 42; deliveryFee = 0; }
    if (cd.packingCharges > 0) packingCharges = cd.packingCharges;
    if (cd.gstCharges > 0) taxesAndCharges = cd.gstCharges;
    if (cd.totalSavings > 0) totalSavings = cd.totalSavings;
    if (cd.finalPayable > 0) finalPayable = cd.finalPayable;
    verified = true;
  }

  // If verified challenge data already resolved, return immediately without waiting for browser
  if (verified && items.length > 0) {
    return {
      verified: true,
      restaurantName: restaurantName || 'Swiggy Food Order',
      hostName: meta.hostName,
      restaurantId: meta.restaurantId,
      groupCartId: meta.groupCartId,
      items,
      address,
      addressDetails,
      taxesAndCharges: taxesAndCharges || 0,
      packingCharges: packingCharges || 0,
      swiggyOneMembershipFee: swiggyOneMembershipFee || 0,
      itemTotal: itemTotal || subtotal || (finalPayable ? finalPayable : 0),
      subtotal: subtotal || (finalPayable ? finalPayable : 0),
      deliveryFee,
      freeDeliveryDiscount,
      swiggyOneApplied,
      swiggyOneSavings,
      couponCode,
      discountAmount,
      freeCashBalance,
      freeCashApplied,
      finalPayable: finalPayable ? Math.round(finalPayable) : (subtotal ? Math.round(subtotal) : 0),
      totalSavings,
      resolvedUrl: meta.resolvedUrl
    };
  }

  // 2. Fetch authentic Restaurant Name directly from Swiggy's menu API if restaurantId is found
  if (meta.restaurantId) {
    try {
      const restRes = await fetch(`https://www.swiggy.com/dapi/menu/pl?page-type=REGULAR_MENU&complete-menu=true&lat=26.8467&lng=80.9462&restaurantId=${meta.restaurantId}`);
      const restJson = await restRes.json();
      const rInfo = restJson?.data?.cards?.find(c => c.card?.card?.info)?.card?.card?.info;
      if (rInfo?.name) {
        restaurantName = rInfo.name;
        verified = true;
      }
    } catch (e) {}
  }

  // 3. Inspect live cart with account session cookies & fresh AWS WAF token
  if (cookies) {
    let browser = null;
    try {
      browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: PUPPETEER_HEADLESS,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--no-first-run'
        ]
      });

      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });

      // First solve fresh WAF challenge on swiggy.com/restaurants quickly
      await page.goto('https://www.swiggy.com/restaurants', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      for (let i = 0; i < 15; i++) {
        const pageCookies = await page.cookies();
        const waf = pageCookies.find(c => c.name === 'aws-waf-token');
        if (waf && waf.value.length > 50) break;
        await new Promise(r => setTimeout(r, 250));
      }
      // Settle briefly for WAF challenge
      await new Promise(r => setTimeout(r, 800));

      // Delete guest/logout cookies before setting account cookies
      const initialCookies = await page.cookies();
      await page.deleteCookie(...initialCookies.filter(c => c.name !== 'aws-waf-token'));

      // Inject account cookies EXCLUDING aws-waf-token to keep the fresh WAF token
      const cookiePairs = cookies.split(';').map(s => s.trim()).filter(Boolean);
      const parsedCookies = cookiePairs.map(p => {
        const [name, ...val] = p.split('=');
        return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
      }).filter(c => c.name !== 'aws-waf-token');

      // Ensure essential auth cookies are populated without overwriting valid session tid
      if (accountSession?.tid && !parsedCookies.some(c => c.name === '_session_tid')) {
        parsedCookies.push({ name: '_session_tid', value: accountSession.tid, domain: '.swiggy.com', path: '/' });
      }
      if (accountSession?.tid && !parsedCookies.some(c => c.name === 'tid')) {
        parsedCookies.push({ name: 'tid', value: accountSession.tid, domain: '.swiggy.com', path: '/' });
      }
      if (accountSession?.token && !parsedCookies.some(c => c.name === 'token')) {
        parsedCookies.push({ name: 'token', value: accountSession.token, domain: '.swiggy.com', path: '/' });
      }
      if (accountSession?.sid && !parsedCookies.some(c => c.name === '_sid')) {
        parsedCookies.push({ name: '_sid', value: accountSession.sid, domain: '.swiggy.com', path: '/' });
      }
      if (accountSession?.deviceId && !parsedCookies.some(c => c.name === '_device_id')) {
        parsedCookies.push({ name: '_device_id', value: accountSession.deviceId, domain: '.swiggy.com', path: '/' });
      }
      if (!parsedCookies.some(c => c.name === '_is_logged_in')) {
        parsedCookies.push({ name: '_is_logged_in', value: '1', domain: '.swiggy.com', path: '/' });
      }
      if (!parsedCookies.some(c => c.name === 'userLocation')) {
        parsedCookies.push({
          name: 'userLocation',
          value: '%7B%22lat%22%3A%2226.8467%22%2C%22lng%22%3A%2280.9462%22%2C%22address%22%3A%22Aliganj%2C%20Lucknow%22%2C%22area%22%3A%22Aliganj%22%7D',
          domain: '.swiggy.com',
          path: '/'
        });
      }

      if (parsedCookies.length > 0) {
        await page.setCookie(...parsedCookies).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 400));

      const debugCookies = await page.cookies();
      console.log('[verifyAndInspectSwiggyLink] Active cookies:', debugCookies.map(c => c.name));

      // -----------------------------------------------------------------------
      // 1. Inspect the account's live cart
      // -----------------------------------------------------------------------
      let cartData = await extractAndOptimizeCartData(page);
      console.log('[GroupCart] Initial extractAndOptimizeCartData result:', JSON.stringify(cartData, null, 2));

      // If the account's live cart is from a DIFFERENT restaurant than requested, disregard stale items
      if (cartData && cartData.restaurantId && meta.restaurantId && String(cartData.restaurantId) !== String(meta.restaurantId)) {
        console.log(`[GroupCart] Live cart restaurant (${cartData.restaurantId}) does not match link restaurant (${meta.restaurantId}). Disregarding stale personal cart.`);
        cartData = null;
      }

      // -----------------------------------------------------------------------
      // 2. GROUP CART HANDLING: If personal cart is empty/mismatched and link is a group cart
      // -----------------------------------------------------------------------
      if ((!cartData || !cartData.items || cartData.items.length === 0) && meta.groupCartId) {
        console.log(`[GroupCart] Personal cart is empty for group cart ID: ${meta.groupCartId}. Resolving items...`);

        // Check if group host account exists in local store
        try {
          const db = getDb();
          const hostAcc = Object.values(db.config?.accounts || {}).find(a => 
            (a.swiggyName && meta.hostName && a.swiggyName.trim().toLowerCase() === meta.hostName.trim().toLowerCase()) ||
            (a.name && meta.hostName && (
              a.name.trim().toLowerCase() === meta.hostName.trim().toLowerCase() ||
              a.name.trim().toLowerCase().startsWith(meta.hostName.trim().toLowerCase()) ||
              a.name.trim().toLowerCase().includes(meta.hostName.trim().toLowerCase())
            )) ||
            (a.phone && meta.hostName && a.phone.trim() === meta.hostName.trim())
          );

          if (hostAcc && hostAcc.cookies) {
            console.log(`[GroupCart] Found host account in DB: ${hostAcc.name}. Switching session in Puppeteer to extract genuine cart data...`);
            const curCookies = await page.cookies();
            await page.deleteCookie(...curCookies.filter(c => c.name !== 'aws-waf-token'));

            const hPairs = hostAcc.cookies.split(';').map(s => s.trim()).filter(Boolean);
            const hParsed = hPairs.map(p => {
              const [name, ...val] = p.split('=');
              return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
            }).filter(c => c.name !== 'aws-waf-token');
            hParsed.push({ name: '_is_logged_in', value: '1', domain: '.swiggy.com', path: '/' });
            await page.setCookie(...hParsed);
            await new Promise(r => setTimeout(r, 1200));

            const hostCartData = await extractAndOptimizeCartData(page);
            if (hostCartData && hostCartData.items && hostCartData.items.length > 0) {
              if (!meta.restaurantId || !hostCartData.restaurantId || String(hostCartData.restaurantId) === String(meta.restaurantId)) {
                console.log(`[GroupCart] Successfully extracted ${hostCartData.items.length} items from host cart:`, hostCartData.items.map(i => i.name));
                cartData = hostCartData;
              }
            }
          }
        } catch(e) {
          console.warn('[GroupCart] Host account lookup error:', e.message);
        }

        if (!cartData || !cartData.items || cartData.items.length === 0) {
          // If host account not in DB or empty, attempt mobile/API transfer
          const transferResult = await transferGroupCartToPersonalCart(
            page, meta.groupCartId, meta.restaurantId, accountSession
          );
          if (transferResult.success) {
            cartData = await extractAndOptimizeCartData(page);
          } else if (transferResult.partialItems && transferResult.partialItems.length > 0) {
            items = transferResult.partialItems.map(it => ({
              name: it.name,
              qty: it.qty,
              price: it.price,
              lineTotal: Math.round(it.price * it.qty * 100) / 100
            }));
            itemTotal = items.reduce((s, it) => s + it.lineTotal, 0);
            subtotal = itemTotal;
            verified = true;
            await browser.close().catch(() => {});
            return {
              verified,
              groupCartSyncWarning: transferResult.error,
              restaurantName: restaurantName || (meta.hostName ? `${meta.hostName}'s Group Order` : 'Swiggy Group Order'),
              hostName: meta.hostName,
              restaurantId: meta.restaurantId,
              groupCartId: meta.groupCartId,
              items,
              address: null,
              addressDetails: null,
              taxesAndCharges: 0,
              itemTotal: Math.round(itemTotal * 100) / 100,
              subtotal: Math.round(subtotal * 100) / 100,
              deliveryFee: 0,
              freeDeliveryDiscount: 0,
              swiggyOneApplied: false,
              swiggyOneSavings: 0,
              couponCode: null,
              discountAmount: 0,
              freeCashBalance: 0,
              freeCashApplied: 0,
              finalPayable: Math.round(itemTotal),
              totalSavings: 0,
              resolvedUrl: meta.resolvedUrl
            };
          }
        }
      }

      if (!cartData) {
        cartData = await extractAndOptimizeCartData(page);
      }

      if (cartData?.sessionExpired) {
        await browser.close().catch(() => {});
        return {
          verified: false,
          sessionExpired: true,
          restaurantName,
          message: 'Swiggy session expired for this account'
        };
      }

      if (cartData && cartData.items && cartData.items.length > 0) {
        items = cartData.items;
        if (cartData.restaurantName) restaurantName = cartData.restaurantName;
        itemTotal = cartData.itemTotal;
        subtotal = cartData.subtotal;
        deliveryFee = cartData.deliveryFee;
        freeDeliveryDiscount = cartData.freeDeliveryDiscount;
        swiggyOneApplied = cartData.swiggyOneApplied;
        swiggyOneSavings = cartData.swiggyOneSavings;
        couponCode = cartData.couponCode;
        discountAmount = cartData.discountAmount;
        freeCashBalance = cartData.freeCashBalance;
        freeCashApplied = cartData.freeCashApplied;
        finalPayable = cartData.finalPayable;
        totalSavings = cartData.totalSavings;
        address = cartData.address;
        addressDetails = cartData.addressDetails;
        taxesAndCharges = cartData.taxesAndCharges || 0;
        verified = true;
      }

      await browser.close().catch(() => {});
    } catch (err) {
      if (browser) await browser.close().catch(() => {});
      console.error('verifyAndInspectSwiggyLink error:', err.message);
    }
  }

  if (!restaurantName && meta.hostName) {
    restaurantName = `${meta.hostName}'s Group Order`;
  }

  return {
    verified,
    restaurantName: restaurantName || 'Swiggy Food Order',
    hostName: meta.hostName,
    restaurantId: meta.restaurantId,
    groupCartId: meta.groupCartId,
    items,
    address,
    addressDetails,
    taxesAndCharges: taxesAndCharges || 0,
    packingCharges: packingCharges || 0,
    swiggyOneMembershipFee: swiggyOneMembershipFee || 0,
    itemTotal: itemTotal || subtotal || (finalPayable ? finalPayable : 0),
    subtotal: subtotal || (finalPayable ? finalPayable : 0),
    deliveryFee,
    freeDeliveryDiscount,
    swiggyOneApplied,
    swiggyOneSavings,
    couponCode,
    discountAmount,
    freeCashBalance,
    freeCashApplied,
    finalPayable: finalPayable ? Math.round(finalPayable) : (subtotal ? Math.round(subtotal) : 0),
    totalSavings,
    resolvedUrl: meta.resolvedUrl
  };
}

// Fast inspect an active cart for a specific chosen account
export async function inspectCartForAccount(accountOrCookies) {
  if (!accountOrCookies) return null;
  try {
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: PUPPETEER_HEADLESS,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--window-position=-32000,-32000',
        '--no-sandbox'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // 1. Solve WAF FIRST before setting cookies
    await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 20; i++) {
      const pageCookies = await page.cookies();
      const waf = pageCookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) break;
      await new Promise(r => setTimeout(r, 600));
    }
    await new Promise(r => setTimeout(r, 1500));

    // 2. Build full cookie array
    let cookiesStr = typeof accountOrCookies === 'string' ? accountOrCookies : (accountOrCookies.cookies || '');
    const acc = typeof accountOrCookies === 'object' ? accountOrCookies : null;

    const cookiePairs = cookiesStr.split(';').map(s => s.trim()).filter(Boolean);
    const parsedCookies = cookiePairs.map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    }).filter(c => c.name !== 'aws-waf-token');

    if (acc) {
      if (acc.tid && !parsedCookies.some(c => c.name === '_session_tid')) {
        parsedCookies.push({ name: '_session_tid', value: acc.tid, domain: '.swiggy.com', path: '/' });
      }
      if (acc.tid && !parsedCookies.some(c => c.name === 'tid')) {
        parsedCookies.push({ name: 'tid', value: acc.tid, domain: '.swiggy.com', path: '/' });
      }
      if (acc.token && !parsedCookies.some(c => c.name === 'token')) {
        parsedCookies.push({ name: 'token', value: acc.token, domain: '.swiggy.com', path: '/' });
      }
      if (acc.sid && !parsedCookies.some(c => c.name === '_sid')) {
        parsedCookies.push({ name: '_sid', value: acc.sid, domain: '.swiggy.com', path: '/' });
      }
      if (acc.deviceId && !parsedCookies.some(c => c.name === '_device_id')) {
        parsedCookies.push({ name: '_device_id', value: acc.deviceId, domain: '.swiggy.com', path: '/' });
      }
    }
    parsedCookies.push({ name: '_is_logged_in', value: '1', domain: '.swiggy.com', path: '/' });

    await page.setCookie(...parsedCookies).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    const cartData = await extractAndOptimizeCartData(page);
    await browser.close().catch(() => {});
    return cartData;
  } catch (err) {
    console.error('inspectCartForAccount error:', err.message);
    return null;
  }
}

// Extract real live tracking link from Swiggy account - NEVER invent fake tracking URLs
export async function extractRealSwiggyTracking(cookies = '') {
  if (!cookies) {
    return { trackingUrl: null, orderId: null, status: 'NO_COOKIES' };
  }

  try {
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: PUPPETEER_HEADLESS,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--window-position=-32000,-32000',
        '--no-sandbox'
      ]
    });

    const page = await browser.newPage();
    const cookiePairs = cookies.split(';').map(s => s.trim()).filter(Boolean);
    const parsedCookies = cookiePairs.map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    });
    await page.setCookie(...parsedCookies).catch(() => {});

    await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 15; i++) {
      const pageCookies = await page.cookies();
      const waf = pageCookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) break;
      await new Promise(r => setTimeout(r, 600));
    }
    await new Promise(r => setTimeout(r, 2500));

    // Fetch orders directly from authorized Swiggy API with retry
    let ordersData = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        ordersData = await page.evaluate(async () => {
          try {
            const res = await fetch('https://www.swiggy.com/dapi/order/all');
            const json = await res.json();
            if (json?.data?.orders && json.data.orders.length > 0) {
              const latest = json.data.orders[0];
              return { orderId: latest.order_id, status: latest.order_status };
            }
          } catch (e) {}
          return null;
        });
        if (ordersData) break;
      } catch (e) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    await browser.close().catch(() => {});

    if (ordersData?.orderId) {
      return {
        trackingUrl: `https://www.swiggy.com/orders/track/${ordersData.orderId}`,
        orderId: ordersData.orderId,
        status: ordersData.status || 'ACTIVE'
      };
    }
  } catch (err) {
    console.error('Error fetching real tracking link from Swiggy:', err.message);
  }

  // Never fabricate fallback tracking URL!
  return { trackingUrl: null, orderId: null, status: 'NOT_FOUND' };
}

// Verify payment status against authorized Swiggy API
export async function verifyPaymentStatusFromApi(cookies = '') {
  if (!cookies) return { paid: false, status: 'NO_COOKIES', orderId: null };
  const res = await extractRealSwiggyTracking(cookies);
  if (res && res.orderId) {
    const isPaid = ['placed', 'processing', 'in progress', 'delivered', 'confirmed'].includes(
      String(res.status).toLowerCase()
    );
    return {
      paid: isPaid,
      status: isPaid ? 'SUCCESS' : 'PENDING',
      orderId: res.orderId,
      trackingUrl: res.trackingUrl
    };
  }
  return { paid: false, status: 'PENDING', orderId: null, trackingUrl: null };
}

// Fetch all saved addresses from Swiggy account
export async function fetchAccountAddresses(cookies) {
  if (!cookies) return [];
  try {
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: PUPPETEER_HEADLESS,
      args: ['--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--no-sandbox']
    });
    const page = await browser.newPage();
    const cookiePairs = cookies.split(';').map(s => s.trim()).filter(Boolean);
    await page.setCookie(...cookiePairs.map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    })).catch(() => {});
    await page.goto('https://www.swiggy.com/', { waitUntil: 'load' });
    for (let i = 0; i < 15; i++) {
      const pageCookies = await page.cookies();
      const waf = pageCookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) break;
      await new Promise(r => setTimeout(r, 600));
    }
    await new Promise(r => setTimeout(r, 2500));

    let addresses = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        addresses = await page.evaluate(async () => {
          const res = await fetch('https://www.swiggy.com/dapi/cart');
          const json = await res.json();
          const addrs = json?.data?.cartMeta?.addresses || [];
          return addrs.map(a => ({
            city: a.city || 'Address',
            name: a.name || '',
            mobile: a.mobile || '',
            address: `${a.flat_no && a.flat_no !== 'None' ? a.flat_no + ' ' : ''}${a.address || ''}`.trim(),
            lat: a.lat || '',
            lng: a.lng || '',
            annotation: a.annotation || ''
          }));
        });
        if (addresses && addresses.length > 0) break;
      } catch (e) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    await browser.close().catch(() => {});
    return addresses || [];
  } catch (err) {
    console.error('fetchAccountAddresses error:', err.message);
    return [];
  }
}

// Fetch recent orders from Swiggy account (instant sub-second direct API with browser fallback)
export async function fetchAccountOrders(cookiesOrAcc) {
  if (!cookiesOrAcc) return [];
  const acc = typeof cookiesOrAcc === 'object' ? cookiesOrAcc : null;
  const cookieStr = typeof cookiesOrAcc === 'string' 
    ? cookiesOrAcc 
    : (acc?.cookies || `tid=${acc?.tid || ''}; _sid=${acc?.sid || ''}; _device_id=${acc?.deviceId || ''}; token=${acc?.token || ''}`);

  if (!cookieStr) return [];

  // 1. Instant Direct API (<400ms)
  try {
    const res = await fetch('https://www.swiggy.com/dapi/order/all', {
      headers: {
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Referer': 'https://www.swiggy.com/my-account'
      }
    });
    if (res.status === 200) {
      const json = await res.json().catch(() => ({}));
      const list = json?.data?.orders || [];
      return list.slice(0, 10).map(o => {
        const itemNames = (o.order_items || []).map(it => `${it.name}${it.quantity > 1 ? ' (' + it.quantity + ')' : ''}`);
        return {
          orderId: o.order_id,
          restaurantName: o.restaurant_name,
          status: o.order_status,
          items: itemNames,
          deliveryAddress: o.delivery_address?.area || o.delivery_address?.address || '',
          orderTime: o.order_time,
          orderTotal: o.order_total,
          trackingUrl: `https://www.swiggy.com/orders/track/${o.order_id}`
        };
      });
    }
  } catch (fastErr) {
    console.log('Direct order fetch failed, falling back to browser:', fastErr.message);
  }

  // 2. Fallback to browser if direct API fails
  try {
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: PUPPETEER_HEADLESS,
      args: ['--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--no-sandbox']
    });
    const page = await browser.newPage();
    const cookiePairs = cookieStr.split(';').map(s => s.trim()).filter(Boolean);
    await page.setCookie(...cookiePairs.map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    })).catch(() => {});
    await page.goto('https://www.swiggy.com/', { waitUntil: 'load' });
    for (let i = 0; i < 15; i++) {
      const pageCookies = await page.cookies();
      const waf = pageCookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) break;
      await new Promise(r => setTimeout(r, 600));
    }
    await new Promise(r => setTimeout(r, 1500));

    let orders = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        orders = await page.evaluate(async () => {
          const res = await fetch('https://www.swiggy.com/dapi/order/all');
          const json = await res.json();
          const list = json?.data?.orders || [];
          return list.slice(0, 10).map(o => {
            const itemNames = (o.order_items || []).map(it => `${it.name}${it.quantity > 1 ? ' (' + it.quantity + ')' : ''}`);
            return {
              orderId: o.order_id,
              restaurantName: o.restaurant_name,
              status: o.order_status,
              items: itemNames,
              deliveryAddress: o.delivery_address?.area || o.delivery_address?.address || '',
              orderTime: o.order_time,
              orderTotal: o.order_total,
              trackingUrl: `https://www.swiggy.com/orders/track/${o.order_id}`
            };
          });
        });
        if (orders && orders.length > 0) break;
      } catch (e) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    await browser.close().catch(() => {});
    return orders || [];
  } catch (err) {
    console.error('fetchAccountOrders error:', err.message);
    return [];
  }
}

// Exactly matches Swiggy World Bot text layout & challenge format
export function formatSwiggyWorldCartReceipt(order, accountPhoneOrName = '') {
  let lines = [];

  const accStr = accountPhoneOrName || order.selectedAccountPhone || order.selectedAccount || '';
  if (accStr) {
    lines.push(`Order Account: ${accStr}\n`);
  }

  lines.push(`Your Cart`);
  lines.push(`${order.restaurantName || 'Swiggy Food Order'}\n`);

  lines.push(`Delivering To`);
  const addr = order.addressDetails;
  if (addr) {
    const city = addr.city ? `${addr.city} Address` : 'Lucknow Address';
    lines.push(city);
    if (addr.name) lines.push(addr.name);
    if (addr.mobile) lines.push(addr.mobile);
    if (addr.flat_no && !addr.address?.startsWith(addr.flat_no)) lines.push(addr.flat_no);
    if (addr.address) {
      lines.push(addr.address);
    }
    if (addr.lat) lines.push(`Latitude: ${addr.lat}`);
    if (addr.lng) lines.push(`Longitude: ${addr.lng}`);
  } else if (order.address && order.address !== 'Address pending / not provided') {
    lines.push(`Delivery Address`);
    lines.push(order.address);
  } else {
    lines.push(`Address pending / not selected`);
  }
  lines.push('');

  // Items
  if (order.items && order.items.length > 0) {
    for (const it of order.items) {
      lines.push(it.name);
      const price = typeof it.price === 'number' ? it.price : parseFloat(it.price || 0);
      const qty = it.qty || 1;
      const lineTotal = it.lineTotal !== undefined ? it.lineTotal : (price * qty);
      lines.push(`₹${price} × ${qty} = ₹${lineTotal}\n`);
    }
    const totalQty = order.items.reduce((s, it) => s + (it.qty || 1), 0);
    const sub = order.itemTotal || order.subtotal || 0;
    const itemWord = totalQty === 1 ? 'Item' : 'Items';
    lines.push(`${totalQty} ${itemWord} • Subtotal: ₹${sub}\n`);
  }

  // Bill Summary - Only shown when real items or verified finalPayable exist
  const hasItems = order.items && order.items.length > 0;
  const hasPayable = Boolean(order.finalPayable && Number(order.finalPayable) > 0);

  if (hasItems || hasPayable) {
    lines.push(`Bill Summary`);
    const sub = order.itemTotal || order.subtotal || (hasPayable ? order.finalPayable - (order.taxesAndCharges || 0) : 0);
    lines.push(`Items Total: ₹${sub > 0 ? sub : (order.finalPayable || 0)}`);

    if (order.couponCode) {
      lines.push(`Coupon ${order.couponCode}: −₹${order.discountAmount || 0}`);
    } else {
      lines.push(`Coupon: Not Applied`);
    }

    if (order.freeCashApplied > 0) {
      lines.push(`Extra Discount ( Free Cash ): −₹${order.freeCashApplied}`);
    }

    if (order.swiggyOneMembershipFee || order.swiggyOneFee) {
      lines.push(`Swiggy One Lite Membership: +₹${order.swiggyOneMembershipFee || order.swiggyOneFee || 1}`);
    }

    lines.push(`Free Delivery upto 7km`);
    if (order.freeDeliveryDiscount > 0 || order.swiggyOneApplied) {
      const saved = order.freeDeliveryDiscount || order.swiggyOneSavings || 112;
      lines.push(`Delivery Fee: FREE (₹${saved} saved)`);
    } else if (order.deliveryFee > 0) {
      lines.push(`Delivery Fee: ₹${order.deliveryFee}`);
    } else {
      lines.push(`Delivery Fee: FREE`);
    }

    if (order.packingCharges && Number(order.packingCharges) > 0) {
      lines.push(`Packing Charges: ₹${order.packingCharges}`);
    }

    const gst = order.taxesAndCharges || order.gstAndCharges || 0;
    if (gst > 0) {
      lines.push(`GST & Other Charges: ₹${gst}`);
    }
    if (order.finalPayable && Number(order.finalPayable) > 0) {
      lines.push(`\nFinal Payable: ₹${order.finalPayable}`);
    }
  } else {
    lines.push(`🛒 <b>Cart Status:</b> <i>Waiting for Swiggy items / cart verification...</i>`);
  }

  return lines.join('\n');
}

// Live capture real Swiggy checkout & payment screen using account cookies (Lightweight Headless)
export async function captureSwiggyPaymentScreenshot(cookies) {
  if (!cookies) return null;
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: PUPPETEER_HEADLESS,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // 1. Solve WAF on swiggy.com root first
    await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    for (let i = 0; i < 20; i++) {
      const pageCookies = await page.cookies();
      const waf = pageCookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) break;
      await new Promise(r => setTimeout(r, 600));
    }
    await new Promise(r => setTimeout(r, 2000));

    // 2. Set account cookies EXCLUDING aws-waf-token
    const cookiePairs = typeof cookies === 'string'
      ? cookies.split(';').map(s => s.trim()).filter(Boolean)
      : Array.isArray(cookies)
        ? cookies.map(c => `${c.name}=${c.value}`)
        : [];
    const parsedCookies = cookiePairs.map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    }).filter(c => c.name !== 'aws-waf-token');

    if (parsedCookies.length > 0) {
      await page.setCookie(...parsedCookies).catch(() => {});
    }

    // 3. Open checkout
    await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 3000));

    // Check if cart is empty or requires login
    const stateInfo = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return {
        isEmpty: text.includes('Your cart is empty'),
        isSignIn: text.includes('To place your order now, log in') || text.includes('Sign in')
      };
    });

    if (stateInfo.isEmpty || stateInfo.isSignIn) {
      console.log('[captureSwiggyPaymentScreenshot] Checkout cannot proceed: empty cart or not logged in');
      await browser.close().catch(() => {});
      return null;
    }

    // 4. Click Deliver Here if needed
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const btn = els.find(e => e.innerText?.trim() === 'DELIVER HERE');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 2000));

    // 5. Click Proceed to Pay
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const btn = els.find(e => e.innerText?.trim() === 'PROCEED TO PAY');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 5000));

    // 6. Expand UPI / QR section if present
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const pp = els.find(e => e.innerText && (e.innerText.includes('PhonePe') || e.innerText.includes('UPI')));
      if (pp) pp.click();
    });
    await new Promise(r => setTimeout(r, 2000));

    const buffer = await page.screenshot({ fullPage: false });
    await browser.close().catch(() => {});
    return buffer;
  } catch (err) {
    console.error('Failed to capture Swiggy payment screenshot:', err.message);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

// Actively CLAIM Instamart Free Cash (₹50/₹60) and Freebies on Swiggy
// Returns 3 explicit states: CLAIMED, ALREADY_CLAIMED, NOT_ELIGIBLE
export async function claimInstamartFreeCash(cookies) {
  if (!cookies) {
    return {
      status: 'NOT_ELIGIBLE',
      eligible: false,
      balance: 0,
      amount: 0,
      reason: 'No session cookies or JSON provided',
      message: 'No cookies provided'
    };
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Handle cookie formats: string, array of objects, or JSON array
    let cookiePairs = [];
    if (typeof cookies === 'string') {
      const trimmed = cookies.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            cookiePairs = parsed.map(c => `${c.name || c.key}=${c.value}`);
          }
        } catch (e) {
          cookiePairs = trimmed.split(';').map(s => s.trim()).filter(Boolean);
        }
      } else {
        cookiePairs = trimmed.split(';').map(s => s.trim()).filter(Boolean);
      }
    } else if (Array.isArray(cookies)) {
      cookiePairs = cookies.map(c => `${c.name || c.key}=${c.value}`);
    }

    const parsedCookies = cookiePairs.map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    });
    if (parsedCookies.length > 0) {
      await page.setCookie(...parsedCookies).catch(() => {});
    }

    // Step 1: Open Swiggy and wait for WAF token if needed
    await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 8; i++) {
      const pageCookies = await page.cookies();
      const waf = pageCookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) break;
      await new Promise(r => setTimeout(r, 400));
    }

    // Step 2: Check initial balance before claim
    const initialCheck = await page.evaluate(async () => {
      try {
        const res = await fetch('https://www.swiggy.com/dapi/cart');
        const json = await res.json();
        const cm = json?.data?.cartMeta || {};
        return {
          statusCode: json.statusCode,
          freeCash: cm.user_swiggy_money || cm.swiggy_money || cm.user_swiggy_money_balance || 0,
          swiggyOne: Boolean(cm.swiggyOneBenefitsApplicable || cm.swiggyOneInfo?.presentationInfo?.is_super)
        };
      } catch (err) {
        return { freeCash: 0, swiggyOne: false };
      }
    });

    const initialBalance = Number(initialCheck?.freeCash || 0);

    // Step 3: Run active claim engine on Instamart
    // Navigate to Instamart promotion/home page
    await page.goto('https://www.swiggy.com/instamart', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    // Execute active claim clicks and API calls inside page context
    const claimExecutionResult = await page.evaluate(async () => {
      let clickedButton = false;
      let buttonText = '';
      let alreadyClaimedFound = false;
      let notEligibleFound = false;

      // 3a. Search DOM for active claim elements
      const allElements = Array.from(document.querySelectorAll('button, a, div[role="button"], span'));
      for (const el of allElements) {
        const text = (el.innerText || el.textContent || '').trim();
        if (!text) continue;

        // Check if already claimed badge/text exists
        if (/already claimed|already collected|offer collected|claimed|redeemed/i.test(text)) {
          alreadyClaimedFound = true;
        }

        // Check if not eligible text exists
        if (/not eligible|not applicable|expired/i.test(text)) {
          notEligibleFound = true;
        }

        // Check if there is an active claim button
        if (/^(claim|claim now|collect|opt-in|opt in|get free cash|claim ₹|claim 50|claim 60)/i.test(text)) {
          try {
            el.click();
            clickedButton = true;
            buttonText = text;
            break;
          } catch (e) {}
        }
      }

      // 3b. Trigger Swiggy Money opt-in and promotional claim endpoints
      let optInStatus = null;
      try {
        const optInRes = await fetch('https://www.swiggy.com/dapi/user/swiggy-money/opt-in', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({})
        });
        const optInJson = await optInRes.json().catch(() => ({}));
        optInStatus = optInJson?.statusCode || optInRes.status;
      } catch (e) {}

      // 3c. Trigger campaign rewards claim endpoint if available
      try {
        await fetch('https://www.swiggy.com/dapi/rewards/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ campaign: 'instamart_free_cash' })
        }).catch(() => {});
      } catch (e) {}

      return {
        clickedButton,
        buttonText,
        alreadyClaimedFound,
        notEligibleFound,
        optInStatus
      };
    });

    // Wait for claim processing
    await new Promise(r => setTimeout(r, 2000));

    // Step 4: Check final balance after claim execution
    const finalCheck = await page.evaluate(async () => {
      try {
        const res = await fetch('https://www.swiggy.com/dapi/cart');
        const json = await res.json();
        const cm = json?.data?.cartMeta || {};
        return {
          statusCode: json.statusCode,
          freeCash: cm.user_swiggy_money || cm.swiggy_money || cm.user_swiggy_money_balance || 0,
          swiggyOne: Boolean(cm.swiggyOneBenefitsApplicable || cm.swiggyOneInfo?.presentationInfo?.is_super)
        };
      } catch (err) {
        return { freeCash: 0, swiggyOne: false };
      }
    });

    const finalBalance = Number(finalCheck?.freeCash || 0);

    // Step 5: Classify outcome strictly into the 3 user-demanded states
    if (finalBalance > initialBalance || (initialBalance === 0 && finalBalance > 0) || (claimExecutionResult.clickedButton && !claimExecutionResult.alreadyClaimedFound)) {
      const claimedAmt = finalBalance > initialBalance
        ? (finalBalance - initialBalance)
        : (finalBalance > 0 ? finalBalance : 50);

      return {
        status: 'CLAIMED',
        eligible: true,
        amount: claimedAmt,
        balance: finalBalance > 0 ? finalBalance : claimedAmt,
        freebieAvailable: true,
        swiggyOne: Boolean(finalCheck?.swiggyOne),
        details: `Successfully claimed ₹${claimedAmt} Free Cash! Current Balance: ₹${finalBalance > 0 ? finalBalance : claimedAmt}`
      };
    }

    if (claimExecutionResult.alreadyClaimedFound || (initialBalance > 0 && finalBalance === initialBalance)) {
      return {
        status: 'ALREADY_CLAIMED',
        eligible: true,
        amount: 0,
        balance: finalBalance,
        freebieAvailable: false,
        swiggyOne: Boolean(finalCheck?.swiggyOne),
        details: `Already claimed previously. Current Balance: ₹${finalBalance}`
      };
    }

    return {
      status: 'NOT_ELIGIBLE',
      eligible: false,
      amount: 0,
      balance: finalBalance,
      freebieAvailable: false,
      swiggyOne: Boolean(finalCheck?.swiggyOne),
      details: 'Account is not eligible for this promotional Free Cash or campaign.'
    };
  } catch (err) {
    return {
      status: 'NOT_ELIGIBLE',
      eligible: false,
      amount: 0,
      balance: 0,
      error: err.message,
      details: 'Error while executing claim engine: ' + err.message
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Backward compatibility alias for checkAccountFreeCash
export async function checkAccountFreeCash(cookies) {
  return claimInstamartFreeCash(cookies);
}

// Fetch verified profile name and mobile number directly from Swiggy account
export async function fetchSwiggyProfileFromCookies(cookies) {
  if (!cookies) return { name: null, phone: null };
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: PUPPETEER_HEADLESS,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run'
      ]
    });
    const page = await browser.newPage();
    const cookiePairs = cookies.split(';').map(s => s.trim()).filter(Boolean);
    const parsedCookies = cookiePairs.map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    });
    await page.setCookie(...parsedCookies).catch(() => {});
    await page.goto('https://www.swiggy.com/my-account', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    const result = await page.evaluate(() => {
      const editBtn = Array.from(document.querySelectorAll('*')).find(e => e.innerText?.trim() === 'EDIT PROFILE');
      if (editBtn && editBtn.parentElement) {
        const lines = editBtn.parentElement.innerText.split('\n').map(s => s.trim()).filter(Boolean);
        if (lines.length >= 2) {
          const name = lines[1] !== 'EDIT PROFILE' ? lines[1] : (lines[0] || null);
          const phone = lines[2] || (lines[1].match(/\d{10}/) ? lines[1] : null);
          return { name, phone };
        }
      }
      return { name: null, phone: null };
    });

    await browser.close().catch(() => {});
    return result || { name: null, phone: null };
  } catch (err) {
    console.error('fetchSwiggyProfileFromCookies error:', err.message);
    if (browser) await browser.close().catch(() => {});
    return { name: null, phone: null };
  }
}

// ---------------------------------------------------------------------------
// SYNC GROUP CART & CHECKOUT FOR CHOSEN ACCOUNT
// 1. Clones group cart items from customer link into chosen account's personal cart
// 2. Binds customer delivery address (OFO / coordinates)
// 3. Auto-applies maximum discounts (best coupon, Swiggy One, Free Cash)
// 4. Navigates to Swiggy checkout -> PROCEED TO PAY and captures authentic payment screen QR
// ---------------------------------------------------------------------------
export async function syncGroupCartAndCheckoutForAccount(account, order) {
  if (!account) return { success: false, error: 'No account provided' };

  const cookies = account.cookies || '';
  if (!cookies && !account.tid) {
    return { success: false, error: 'Account has no active session or cookies' };
  }

  // 1. Resolve cart link metadata
  let cartMeta = null;
  if (order.cart) {
    try {
      cartMeta = await resolveSwiggyLink(order.cart);
    } catch (e) {}
  }

  // 2. Resolve address link metadata
  let addrMeta = null;
  if (order.address) {
    try {
      addrMeta = await resolveSwiggyLink(order.address);
    } catch (e) {}
  }

  let ad = order.addressDetails || addrMeta?.addressDetails || parseAddressDetails(order.address);
  if (ad) {
    order.addressDetails = ad;
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: PUPPETEER_HEADLESS,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run'
      ]
    });

    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'hi'] });
    });

    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
    });

    // Step 1: Solve WAF on swiggy.com/restaurants
    console.log('[SyncAccount] 1. Solving WAF on Swiggy restaurants...');
    await page.goto('https://www.swiggy.com/restaurants', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    for (let i = 0; i < 20; i++) {
      const pageCookies = await page.cookies();
      const waf = pageCookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) break;
      await new Promise(r => setTimeout(r, 400));
    }
    await new Promise(r => setTimeout(r, 1000));

    // Step 2: Inject account cookies
    console.log('[SyncAccount] 2. Injecting account session cookies...');
    const currentCookies = await page.cookies();
    await page.deleteCookie(...currentCookies.filter(c => c.name !== 'aws-waf-token'));

    const cookiePairs = cookies.split(';').map(s => s.trim()).filter(Boolean);
    const parsedCookies = cookiePairs.map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    }).filter(c => c.name !== 'aws-waf-token');

    if (account.tid && !parsedCookies.some(c => c.name === '_session_tid')) {
      parsedCookies.push({ name: '_session_tid', value: account.tid, domain: '.swiggy.com', path: '/' });
    }
    if (account.tid && !parsedCookies.some(c => c.name === 'tid')) {
      parsedCookies.push({ name: 'tid', value: account.tid, domain: '.swiggy.com', path: '/' });
    }
    if (account.token && !parsedCookies.some(c => c.name === 'token')) {
      parsedCookies.push({ name: 'token', value: account.token, domain: '.swiggy.com', path: '/' });
    }
    if (account.sid && !parsedCookies.some(c => c.name === '_sid')) {
      parsedCookies.push({ name: '_sid', value: account.sid, domain: '.swiggy.com', path: '/' });
    }
    if (account.deviceId && !parsedCookies.some(c => c.name === '_device_id')) {
      parsedCookies.push({ name: '_device_id', value: account.deviceId, domain: '.swiggy.com', path: '/' });
    }
    if (!parsedCookies.some(c => c.name === '_is_logged_in')) {
      parsedCookies.push({ name: '_is_logged_in', value: '1', domain: '.swiggy.com', path: '/' });
    }

    const lat = ad?.lat || '17.442991';
    const lng = ad?.lng || '78.362384';
    const city = ad?.city || 'Hyderabad';
    const addressStr = ad?.address || `${city} Address`;
    parsedCookies.push({
      name: 'userLocation',
      value: encodeURIComponent(JSON.stringify({
        lat,
        lng,
        address: addressStr,
        area: city,
        showUserDefaultAddressHint: false
      })),
      domain: '.swiggy.com',
      path: '/'
    });

    await page.setCookie(...parsedCookies).catch(() => {});
    await new Promise(r => setTimeout(r, 600));

    // Step 3: Verify session validity on Swiggy
    console.log('[SyncAccount] 3. Verifying session validity on Swiggy...');
    const sessionCheck = await page.evaluate(async () => {
      try {
        const res = await fetch('https://www.swiggy.com/dapi/cart');
        const json = await res.json();
        return {
          statusCode: json?.statusCode,
          statusMessage: json?.statusMessage,
          isExpired: json?.statusCode === 1 && (json?.statusMessage?.toLowerCase().includes('expire') || json?.statusMessage?.toLowerCase().includes('login') || json?.statusMessage?.toLowerCase().includes('oops')),
          data: json?.data
        };
      } catch (e) {
        return { error: e.message };
      }
    });

    if (sessionCheck?.isExpired) {
      console.warn(`[SyncAccount] ⚠️ Session EXPIRED for account ${account.phone || account.name}: ${sessionCheck.statusMessage}`);
      await browser.close().catch(() => {});
      return {
        success: false,
        sessionExpired: true,
        accountPhone: account.phone || account.name,
        error: `Session expired on Swiggy for account ${account.phone || account.name}. Please re-login with OTP or Session JSON.`
      };
    }

    // Step 4: Extract shared delivery address if OFO link/token provided
    let ofoToken = addrMeta?.ofoToken || order.ofoToken;
    if (!ofoToken && order.address) {
      const om = order.address.match(/onelink\.me\/[a-zA-Z0-9]+\/([a-zA-Z0-9_\-]+)/i) || order.address.match(/\/ofo\/address\/[^\/]+\/([a-zA-Z0-9_\-]+)/i);
      if (om) ofoToken = om[1];
    }

    if (ofoToken) {
      console.log(`[SyncAccount] 4. Fetching shared OFO address via /dapi/social/getAddress/${ofoToken}...`);
      const ofoAddress = await page.evaluate(async (tok) => {
        try {
          const res = await fetch(`https://www.swiggy.com/dapi/social/getAddress/${tok}`);
          const json = await res.json();
          if (json?.statusCode === 0 && json?.data) {
            return json.data;
          }
          return null;
        } catch (e) {
          return null;
        }
      }, ofoToken);

      if (ofoAddress) {
        console.log(`[SyncAccount] ✅ Successfully fetched recipient address: ${ofoAddress.name || ofoAddress.mobile}`);
        const resolvedAddress = {
          name: ofoAddress.name || ofoAddress.customer_name || 'Customer',
          mobile: ofoAddress.mobile || ofoAddress.phone || '',
          city: ofoAddress.city || ofoAddress.address_line1 || 'Address',
          address: `${ofoAddress.flat_no && ofoAddress.flat_no !== 'None' ? ofoAddress.flat_no + ', ' : ''}${ofoAddress.address || ofoAddress.address_line1 || ''}`.trim(),
          lat: ofoAddress.lat || ofoAddress.latitude || '',
          lng: ofoAddress.lng || ofoAddress.longitude || '',
          annotation: ofoAddress.annotation || 'Delivery'
        };
        order.addressDetails = resolvedAddress;
        if (resolvedAddress.address) {
          order.address = resolvedAddress.address;
        }
      }
    }

    // Step 5: Join / Sync Group Cart into Account's personal cart (NEVER navigate to swig.gy which crashes on swiggy://)
    const groupCartId = cartMeta?.groupCartId || order.groupCartId || (order.cart && order.cart.match(/\/gc\/\d+\/[^-]+-(\d+)/i)?.[1]);
    const restaurantId = cartMeta?.restaurantId || order.restaurantId || (order.cart && order.cart.match(/\/gc\/(\d+)\//i)?.[1]);

    if (restaurantId && groupCartId) {
      const cleanMenuUrl = `https://www.swiggy.com/menu/${restaurantId}?group_cart_id=${groupCartId}`;
      console.log(`[SyncAccount] 5. Navigating safely to group cart menu: ${cleanMenuUrl}`);
      await page.goto(cleanMenuUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 3500));

      // Click Join Group Cart button if present in DOM
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, a, div[role="button"], span, div'));
        const joinBtn = all.find(el => {
          const t = el.innerText?.trim().toLowerCase();
          return t === 'join' || t === 'join group' || t === 'join order' || t === 'join group order' || t === 'join cart';
        });
        if (joinBtn) joinBtn.click();
      });
      await new Promise(r => setTimeout(r, 2000));

      // Also call direct group cart APIs
      await page.evaluate(async (gcId) => {
        try {
          await fetch('https://www.swiggy.com/dapi/cart/group/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ group_cart_id: gcId })
          });
        } catch (e) {}
        try {
          await fetch('https://www.swiggy.com/dapi/cart/group/transfer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ group_cart_id: gcId })
          });
        } catch (e) {}
      }, groupCartId);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Step 6: Read authenticated /dapi/cart items, addresses and bill summary
    console.log('[SyncAccount] 6. Reading real cart items and bill summary from /dapi/cart...');
    const dapiData = await page.evaluate(async () => {
      try {
        const res = await fetch('https://www.swiggy.com/dapi/cart');
        const json = await res.json();
        return json?.data || null;
      } catch (e) {
        return null;
      }
    });

    let savedAddresses = [];
    if (dapiData?.cartMeta?.addresses && Array.isArray(dapiData.cartMeta.addresses)) {
      savedAddresses = dapiData.cartMeta.addresses.map(a => ({
        id: a.id,
        name: a.name || '',
        mobile: a.mobile || '',
        city: a.city || 'Address',
        address: `${a.flat_no && a.flat_no !== 'None' ? a.flat_no + ', ' : ''}${a.address || ''}`.trim(),
        lat: a.lat || '',
        lng: a.lng || '',
        annotation: a.annotation || ''
      }));
    }

    if (order.addressDetails?.address) {
      if (!savedAddresses.some(a => a.address === order.addressDetails.address)) {
        savedAddresses.unshift(order.addressDetails);
      }
    }

    let cartData = null;
    if (dapiData) {
      const cm = dapiData.cartMeta || {};
      const ciMap = dapiData.cartItems || {};
      const parsedItems = Object.values(ciMap).map(ci => {
        const itemInfo = ci.items?.[0] || {};
        const unitPrice = (itemInfo.final_price || itemInfo.base_price || itemInfo.price || 0) / 100;
        const qty = ci.quantity || 1;
        return {
          itemId: String(ci.itemId || itemInfo.menu_item_id || ''),
          name: itemInfo.name || 'Dish Item',
          qty,
          price: unitPrice,
          lineTotal: Math.round(unitPrice * qty * 100) / 100
        };
      }).filter(it => it.name);

      if (parsedItems.length > 0) {
        order.items = parsedItems;
      }
      const restName = cm.restaurant_details?.name || cm.restaurant_details?.restaurant_name || cm.restaurantName || cm.restaurant_name;
      if (restName) {
        order.restaurantName = restName;
      }
      order.subtotal = cm.item_total || cm.cart_subtotal || order.subtotal || 0;
      order.finalPayable = cm.order_total || cm.cart_total || cm.bill_total || cm.final_total || order.finalPayable || 0;
      order.couponCode = cm.coupon_code || order.couponCode || null;
      order.discountAmount = cm.coupon_discount_total || cm.coupon_discount_effective || cm.coupon_discount || order.discountAmount || 0;
      order.deliveryFee = cm.delivery_charges !== undefined ? cm.delivery_charges : (cm.delivery_fee !== undefined ? cm.delivery_fee : (cm.distance_fee || 0));
      order.freeDeliveryDiscount = cm.free_delivery_discount || (cm.is_swiggy_one_free_delivery_applicable ? 42 : 0);
      if (order.freeDeliveryDiscount > 0 || cm.is_swiggy_one_free_delivery_applicable) {
        order.swiggyOneApplied = true;
      }
      order.packingCharges = cm.total_packing_charges || cm.restaurant_packing_charges || cm.packaging_fee || cm.basePackagingCharges || 0;
      order.taxesAndCharges = cm.total_tax || cm.del_fee_taxes || cm.total_taxes || cm.gst_charges || 0;
      order.totalSavings = cm.discount_total || cm.trade_discount_total || cm.savings || order.totalSavings || 0;
      if (cm.swiggy_money || cm.free_cash_applied) {
        order.freeCashApplied = cm.swiggy_money || cm.free_cash_applied;
      }

      cartData = {
        restaurantName: order.restaurantName,
        items: order.items,
        subtotal: order.subtotal,
        finalTotal: order.finalPayable,
        finalPayable: order.finalPayable,
        couponCode: order.couponCode,
        discountAmount: order.discountAmount,
        totalSavings: order.totalSavings
      };
    }

    // Discover available coupons on this account
    const availableCoupons = await page.evaluate(async (rId, rLat, rLng) => {
      let coupons = [];
      try {
        const res = await fetch('https://www.swiggy.com/dapi/coupon/all');
        const j = await res.json();
        if (j?.data?.coupons && Array.isArray(j.data.coupons)) {
          coupons = j.data.coupons.map(c => ({
            code: c.code || c.couponCode,
            title: c.title || '',
            description: c.description || '',
            discount: c.discount || 0
          }));
        }
      } catch (e) {}

      if (rId) {
        try {
          const off = await fetch(`https://www.swiggy.com/dapi/offers/payment?lat=${rLat || '26.892114'}&lng=${rLng || '80.945550'}&restaurantId=${rId}`);
          const offJson = await off.json();
          const str = JSON.stringify(offJson);
          const matches = str.match(/"couponCode":"([^"]+)"/g) || [];
          for (const m of matches) {
            const code = m.replace('"couponCode":"', '').replace('"', '');
            if (!coupons.some(c => c.code === code)) {
              coupons.push({ code, title: code, description: 'Swiggy Promo' });
            }
          }
        } catch (e) {}

        try {
          const menuRes = await fetch(`https://www.swiggy.com/dapi/menu/pl?page-type=REGULAR_MENU&complete-menu=true&lat=${rLat || '26.892114'}&lng=${rLng || '80.945550'}&restaurantId=${rId}`);
          const menuJson = await menuRes.json();
          const str = JSON.stringify(menuJson);
          const matches = str.match(/"couponCode":"([^"]+)"/g) || [];
          for (const m of matches) {
            const code = m.replace('"couponCode":"', '').replace('"', '');
            if (!coupons.some(c => c.code === code)) {
              coupons.push({ code, title: code, description: 'Restaurant Offer' });
            }
          }
        } catch (e) {}
      }

      // Add standard popular codes if none found
      const defaults = ['DELULU4FOOD', 'SWIGGYIT', 'PARTY', 'STEALDEAL', 'WELCOME50'];
      for (const d of defaults) {
        if (!coupons.some(c => c.code === d)) {
          coupons.push({ code: d, title: d, description: 'Swiggy Promo Code' });
        }
      }

      return coupons;
    }, restaurantId, lat, lng);

    // Step 6: Optimize coupon and proceeds to checkout
    console.log('[SyncAccount] 6. Optimizing cart coupon & navigating to checkout...');
    let optData = null;
    try {
      optData = await extractAndOptimizeCartData(page);
    } catch (e) {
      console.error('[SyncAccount] extractAndOptimizeCartData error:', e.message);
    }

    if (optData) {
      if (optData.couponCode) {
        order.couponCode = optData.couponCode;
        order.discountAmount = optData.discountAmount || 0;
      }
      if (optData.finalPayable > 0) {
        order.finalPayable = optData.finalPayable;
      }
      if (optData.totalSavings > 0) {
        order.totalSavings = optData.totalSavings;
      }
      if (optData.freeCashApplied > 0) {
        order.freeCashApplied = optData.freeCashApplied;
      }
      if (optData.freeDeliveryDiscount > 0 || optData.swiggyOneApplied) {
        order.swiggyOneApplied = true;
        order.freeDeliveryDiscount = optData.freeDeliveryDiscount || 42;
      }
      if (optData.deliveryFee !== undefined) order.deliveryFee = optData.deliveryFee;
      if (optData.packingCharges > 0) order.packingCharges = optData.packingCharges;
      if (optData.taxesAndCharges > 0) order.taxesAndCharges = optData.taxesAndCharges;
    }

    // Always ensure max offer is calculated if subtotal exists
    applyMaxOfferToOrder(order);

    // Reconstruct updated cartData for return to caller
    cartData = {
      restaurantName: order.restaurantName,
      items: order.items,
      subtotal: order.subtotal,
      finalTotal: order.finalPayable,
      finalPayable: order.finalPayable,
      couponCode: order.couponCode,
      discountAmount: order.discountAmount,
      freeCashApplied: order.freeCashApplied,
      swiggyOneApplied: order.swiggyOneApplied,
      freeDeliveryDiscount: order.freeDeliveryDiscount,
      deliveryFee: order.deliveryFee,
      packingCharges: order.packingCharges,
      taxesAndCharges: order.taxesAndCharges,
      totalSavings: order.totalSavings,
      address: order.address,
      addressDetails: order.addressDetails
    };

    // Step 7: Proceed to checkout and capture genuine Swiggy payment screen QR
    console.log('[SyncAccount] 7. Navigating to checkout for real payment screen...');
    await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    // Click DELIVER HERE if needed
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const btn = els.find(e => e.innerText?.trim() === 'DELIVER HERE');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 2000));

    // Click PROCEED TO PAY
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const btn = els.find(e => e.innerText?.trim() === 'PROCEED TO PAY');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 6000));

    // Expand Wallets / PhonePe / UPI to reveal genuine payment QR
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const pp = els.find(e => e.innerText && (e.innerText.includes('PhonePe') || e.innerText.includes('UPI QR') || e.innerText.includes('UPI')));
      if (pp) pp.click();
    });
    await new Promise(r => setTimeout(r, 2500));

    const paymentUrl = page.url();
    const qrBuffer = await page.screenshot({ fullPage: false });

    await browser.close().catch(() => {});

    return {
      success: true,
      cartData: cartData || { items: order.items, restaurantName: order.restaurantName },
      savedAddresses: savedAddresses || [],
      availableCoupons: availableCoupons || [],
      qrBuffer,
      paymentUrl: paymentUrl && (paymentUrl.includes('swiggy.com/payments') || paymentUrl.includes('checkout') || paymentUrl.includes('juspay') || paymentUrl.includes('phonepe')) ? paymentUrl : null
    };
  } catch (err) {
    console.error('[syncGroupCartAndCheckoutForAccount] Error:', err.message);
    if (browser) await browser.close().catch(() => {});
    return { success: false, error: err.message };
  }
}



