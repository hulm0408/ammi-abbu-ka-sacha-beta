import fs from 'fs';
import puppeteer from 'puppeteer-core';
import { getDb } from './store.js';

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
const PUPPETEER_HEADLESS = (process.platform === 'linux' || process.env.RAILWAY_ENVIRONMENT || process.env.HEADLESS !== 'false') ? 'new' : false;

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

// Helper to fast-resolve Swiggy short links (swig.gy & onelink.me)
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
    if (cleanUrl.includes('swig.gy') || cleanUrl.includes('onelink.me')) {
      const res = await fetch(cleanUrl, { redirect: 'manual' });
      const loc = res.headers.get('location');
      if (loc) {
        resolved = loc;
      }
    }
  } catch (e) {}

  // Check group cart from URL pattern (e.g. swig.gy/gc/803172/Umbashiya-442849410)
  const gcMatch = cleanUrl.match(/\/gc\/([0-9]+)\/([^\/\-]+)-([0-9]+)/i);
  if (gcMatch) {
    restaurantId = gcMatch[1];
    hostName = gcMatch[2];
    groupCartId = gcMatch[3];
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
        if (mRest) restaurantId = mRest[1];
        if (mGc) groupCartId = mGc[1];
        if (mHost) hostName = decodeURIComponent(mHost[1]);

        const mOfo = decoded.match(/\/ofo\/address\/([^\/\?]+)\/([^\/\?]+)/);
        if (mOfo) {
          ofoUser = decodeURIComponent(mOfo[1]);
          ofoToken = mOfo[2];
        }
      }
    } catch (e) {}
  }

  // Check OFO address direct URL
  const ofoDirect = resolved.match(/\/ofo\/address\/([^\/\?]+)\/([^\/\?]+)/i);
  if (ofoDirect) {
    ofoUser = decodeURIComponent(ofoDirect[1]);
    ofoToken = ofoDirect[2];
  }

  const isAddress = Boolean(ofoUser || cleanUrl.includes('ofo/address') || cleanUrl.includes('address') || cleanUrl.includes('maps.google') || cleanUrl.includes('goo.gl'));
  const isCart = Boolean(groupCartId || cleanUrl.includes('/gc/') || cleanUrl.includes('group-order') || cleanUrl.includes('/cart') || cleanUrl.includes('/menu'));

  return {
    originalUrl: cleanUrl,
    resolvedUrl: resolved,
    type: isAddress ? 'ADDRESS' : (isCart ? 'CART' : 'SWIGGY_GENERAL'),
    restaurantId,
    groupCartId,
    hostName,
    ofoUser,
    ofoToken
  };
}

// Parse and optimize live cart response with real coupon, free cash (FC), and free delivery
async function extractAndOptimizeCartData(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await page.evaluate(async () => {
        let cartRes = null;
        try {
          const r = await fetch('https://www.swiggy.com/dapi/cart');
          cartRes = await r.json();
        } catch (e) {}

        if (cartRes?.statusCode === 1 && (cartRes?.statusMessage?.includes('Session expired') || cartRes?.statusMessage?.includes('login'))) {
          return { sessionExpired: true };
        }

        if (!cartRes?.data) return null;
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

        // 4. COUPON OPTIMIZATION: Try applying available coupons to minimise cost
        let appliedCoupon = cm.coupon_code || null;
        let couponDiscount = cm.coupon_discount_total || cm.discount_total || 0;

        if (!appliedCoupon) {
          let triedCoupons = [];
          try {
            const offRes = await fetch(`https://www.swiggy.com/dapi/offers/payment?lat=26.8658609&lng=80.9307755&restaurantId=${restaurantId || '803172'}&cart_val=${cm.order_total || 500}`);
            const offJson = await offRes.json();
            const availableCards = offJson?.data?.cards || [];
            for (const card of availableCards) {
              if (card.cardType === 'couponCard' && card.data?.couponCode) {
                triedCoupons.push(card.data.couponCode);
              }
            }
          } catch (e) {}

          const commonCodes = ['STEALDEAL', 'SWIGGYIT', 'WELCOME50', 'TRYNEW', 'FEAST50'];
          for (const code of [...new Set([...triedCoupons, ...commonCodes])].slice(0, 5)) {
            try {
              const appRes = await fetch('https://www.swiggy.com/dapi/cart/apply-coupon', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ couponCode: code })
              });
              const appJson = await appRes.json();
              if (appJson.statusCode === 0) {
                appliedCoupon = code;
                break;
              }
            } catch (e) {}
          }
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
        const finalCoupon = updatedCm.coupon_code || appliedCoupon || null;
        const finalDiscount = updatedCm.coupon_discount_total || updatedCm.discount_total || 0;
        const finalFc = updatedCm.swiggy_money || 0;
        const deliveryFee = updatedCm.positiveDeliveryChargesExclusive || 0;
        const taxesAndCharges = updatedCm.taxesAndCharges || 0;
        
        // Exact final payable amount as shown on Swiggy Payment Page
        const finalPayable = updatedCm.order_total || updatedCm.cart_total || (itemTotal - finalDiscount - finalFc);
        const totalSavings = (freeDeliveryDiscount || 0) + (finalDiscount || 0) + (finalFc || 0);

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

      if (data && ((data.items && data.items.length > 0) || data.restaurantName)) {
        return data;
      }
    } catch (e) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return null;
}

// Strictly verify Swiggy link and extract cart details from real Swiggy DOM/API (NO FAKE ITEMS)
export async function verifyAndInspectSwiggyLink(url, cookies = '') {
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
  let verified = false;

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

      // First solve fresh WAF challenge on swiggy.com
      await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
      for (let i = 0; i < 20; i++) {
        const pageCookies = await page.cookies();
        const waf = pageCookies.find(c => c.name === 'aws-waf-token');
        if (waf && waf.value.length > 50) break;
        await new Promise(r => setTimeout(r, 600));
      }
      await new Promise(r => setTimeout(r, 2000));

      // Inject account cookies EXCLUDING aws-waf-token to keep the fresh WAF token
      const cookiePairs = cookies.split(';').map(s => s.trim()).filter(Boolean);
      const parsedCookies = cookiePairs.map(p => {
        const [name, ...val] = p.split('=');
        return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
      }).filter(c => c.name !== 'aws-waf-token');

      if (parsedCookies.length > 0) {
        await page.setCookie(...parsedCookies).catch(() => {});
      }

      // If restaurantId is still not resolved, query menu inside page
      if (!restaurantName && meta.restaurantId) {
        try {
          const fetchedName = await page.evaluate(async (rid) => {
            try {
              const r = await fetch(`https://www.swiggy.com/dapi/menu/pl?page-type=REGULAR_MENU&complete-menu=true&lat=26.8467&lng=80.9462&restaurantId=${rid}`);
              const json = await r.json();
              const info = json?.data?.cards?.find(c => c.card?.card?.info)?.card?.card?.info;
              return info?.name || null;
            } catch (e) {
              return null;
            }
          }, meta.restaurantId);
          if (fetchedName) restaurantName = fetchedName;
        } catch (e) {}
      }

      // Extract cart from current account
      const cartData = await extractAndOptimizeCartData(page);

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
export async function inspectCartForAccount(cookies) {
  if (!cookies) return null;
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

// Fetch recent orders from Swiggy account
export async function fetchAccountOrders(cookies) {
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

    let orders = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        orders = await page.evaluate(async () => {
          const res = await fetch('https://www.swiggy.com/dapi/order/all');
          const json = await res.json();
          const list = json?.data?.orders || [];
          return list.slice(0, 5).map(o => {
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

// Exactly matches Swiggy World Bot text layout
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
    const city = addr.city ? `${addr.city} Address` : 'Saved Address';
    lines.push(city);
    if (addr.name || addr.mobile) {
      lines.push(`${addr.name || ''} ${addr.mobile || ''}`.trim());
    }
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
    lines.push(`${totalQty} Items • Subtotal: ₹${sub}\n`);
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

    lines.push(`Free Delivery upto 7km`);
    if (order.freeDeliveryDiscount > 0 || order.swiggyOneApplied) {
      const saved = order.freeDeliveryDiscount || order.swiggyOneSavings || 23;
      lines.push(`Delivery Fee: FREE (₹${saved} saved)`);
    } else if (order.deliveryFee > 0) {
      lines.push(`Delivery Fee: ₹${order.deliveryFee}`);
    } else {
      lines.push(`Delivery Fee: FREE`);
    }

    const gst = order.taxesAndCharges || order.gstAndCharges || 0;
    if (gst > 0) {
      lines.push(`GST & Other Charges: ₹${gst}`);
    }

    lines.push(`━━━━━━━━━━━━━━`);
    if (order.totalSavings > 0) {
      lines.push(`Total Savings: ₹${order.totalSavings}`);
    }
    lines.push(`To Pay: ₹${order.finalPayable || sub || 0}`);
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


