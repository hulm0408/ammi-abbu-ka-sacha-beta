import { normalizeIndianMobileNumber } from './phone-utils.js';

// Never round a fractional paisa or treat a missing amount as zero.
export function exactPaise(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const amount = Number(value), paise = Math.round(amount * 100);
  return Number.isFinite(amount) && Number.isSafeInteger(paise) && Math.abs(amount * 100 - paise) < 1e-6 ? paise : null;
}

// Group-cart payloads can omit selected variants/add-ons and expose only the
// provider-marked defaults in valid_* metadata. Reuse those exact IDs when the
// selected list is empty; never invent a first option or a different variant.
export function selectedSwiggyChoices(item, kind) {
  const isVariant = kind === 'variants';
  const raw = Array.isArray(item?.[kind]) ? item[kind].filter(choice => choice?.selected !== 0 && choice?.selected !== false && choice?.is_selected !== 0 && choice?.is_selected !== false) : [];
  const groups = isVariant
    ? (item.valid_variants_v2?.variant_groups || item.valid_variants_v2?.variantGroups || item.valid_variants?.variantGroups || [])
    : (Array.isArray(item.valid_addons) ? item.valid_addons : []);
  if (!Array.isArray(groups)) return raw;
  const idKeys = isVariant
    ? ['variation_id', 'variationId', 'variant_id', 'variantId', 'id']
    : ['choice_id', 'choiceId', 'addon_choice_id', 'addon_id', 'addonId', 'id'];
  const canonical = (choice, fallbackGroup = '') => {
    const id = String(idKeys.map(key => choice?.[key]).find(value => value !== undefined && value !== null) ?? '');
    let groupId = String(choice?.group_id ?? choice?.groupId ?? choice?.variant_group_id ?? choice?.variantGroupId ?? choice?.addon_group_id ?? choice?.addonGroupId ?? fallbackGroup ?? '');
    // A selected choice can carry only its ID while its group exists solely in
    // valid_* metadata. The write payload needs that group too, not merely the
    // comparator: otherwise Swiggy silently applies its default variant.
    if (!groupId && id) {
      const owner = groups.find(group => (group?.variations || group?.choices || []).some(option =>
        idKeys.some(key => String(option?.[key] ?? '') === id) || String(option?.id ?? '') === id));
      groupId = String(owner?.group_id ?? owner?.groupId ?? '');
    }
    // Preserve malformed choices so strict verification still rejects them;
    // never silently discard an unknown/customized selection.
    if (!groupId || !id) return choice;
    return isVariant ? { group_id: groupId, variation_id: id } : { group_id: groupId, choice_id: id };
  };
  if (raw.length) return raw.map(choice => canonical(choice));
  if (!item) return [];
  const output = [];
  for (const group of groups) {
    const groupId = String(group?.group_id ?? group?.groupId ?? '');
    const options = group?.variations || group?.choices || [];
    const selected = options.filter(choice => choice?.selected === 1 || choice?.selected === true || choice?.is_selected === 1 || choice?.is_selected === true || choice?.default === 1 || choice?.default === true);
    const max = isVariant ? 1 : Math.max(0, Number(group?.maxAddons ?? group?.max_addons ?? selected.length) || selected.length);
    for (const choice of selected.slice(0, max)) {
      const choiceId = String(choice?.id ?? choice?.variation_id ?? choice?.choice_id ?? choice?.addon_id ?? '');
      if (!groupId || !choiceId) continue;
      output.push(isVariant ? { group_id: groupId, variation_id: choiceId } : { group_id: groupId, choice_id: choiceId });
    }
  }
  return output;
}

// Compare provider cart items without silently dropping variants or add-ons.
export function sameCartItems(expected, actual) {
  const makeSignature = (item) => {
    const id = String(item?.menu_item_id || item?.itemId || item?.id || '');
    if (!/^\d+$/.test(id)) return null;
    const choices = (list, choiceKeys, validGroups) => {
      if (!Array.isArray(list)) return null;
      const output = [];
      for (const choice of list) {
        const choiceId = String(choiceKeys.map(key => choice?.[key]).find(v => v !== undefined && v !== null) ?? '');
        let group = String(choice?.group_id ?? choice?.groupId ?? choice?.variant_group_id ?? choice?.variantGroupId ?? choice?.addon_group_id ?? choice?.addonGroupId ?? '');
        // Some Swiggy readbacks put the selected choice in `variants/addons`
        // but keep its group only in valid_variants_v2/valid_addons. Resolve
        // that exact ID instead of rejecting an otherwise identical cart.
        if (!group && choiceId) {
          const owner = validGroups.find(candidate => {
            const options = candidate?.variations || candidate?.choices || [];
            return options.some(option => choiceKeys.some(key => String(option?.[key] ?? '') === choiceId) || String(option?.id ?? '') === choiceId);
          });
          group = String(owner?.group_id ?? owner?.groupId ?? '');
        }
        if (!group || !choiceId) return null;
        output.push(`${group}:${choiceId}`);
      }
      return output.sort();
    };
    const validVariants = item.valid_variants_v2?.variant_groups || item.valid_variants_v2?.variantGroups || item.valid_variants?.variantGroups || [];
    const variants = choices(selectedSwiggyChoices(item, 'variants'), ['variation_id', 'variationId', 'variant_id', 'variantId', 'id'], Array.isArray(validVariants) ? validVariants : []);
    const addons = choices(selectedSwiggyChoices(item, 'addons'), ['choice_id', 'choiceId', 'addon_choice_id', 'addon_id', 'addonId', 'id'], Array.isArray(item.valid_addons) ? item.valid_addons : []);
    if (!variants || !addons) return null;
    return JSON.stringify([id, variants, addons]);
  };
  const aggregate = (list, providerSide = false) => {
    if (!Array.isArray(list) || !list.length) return null;
    const result = new Map();
    for (const item of list) {
      const id = String(item?.menu_item_id || item?.itemId || item?.id || '');
      const quantity = Number(item.qty ?? item.quantity);
      // Provider readbacks can carry freebie/gift/removed lines (no numeric
      // menu id, qty 0) that are not comparable menu lines — one such noise
      // line must not fail the whole cart check. The expected cart is ours:
      // any unusable line there still fails, and a real readback item whose
      // choices cannot be verified still fails (signature null below).
      if (!/^\d+$/.test(id) || !Number.isInteger(quantity) || quantity <= 0) {
        if (providerSide) continue;
        return null;
      }
      const signature = makeSignature(item);
      if (!signature) return null;
      result.set(signature, (result.get(signature) || 0) + quantity);
    }
    return result.size ? result : null;
  };
  const left = aggregate(expected), right = aggregate(actual, true);
  return Boolean(left && right && left.size === right.size && [...left].every(([key, qty]) => right.get(key) === qty));
}


function validIndianCoordinates(lat, lng) {
  const a = Number(lat), b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && a >= 5.5 && a <= 38.5 && b >= 67 && b <= 99;
}

export function sameDeliveryRecipient(expected, saved) {
  const expectedPhone = normalizeIndianMobileNumber(expected?.mobile || '');
  const savedPhone = normalizeIndianMobileNumber(saved?.mobile || '');
  const normalizeText = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!expectedPhone || expectedPhone !== savedPhone || !normalizeText(expected?.name) || normalizeText(expected.name) !== normalizeText(saved?.name)) return false;
  if (!normalizeText(expected?.address) || normalizeText(expected.address) !== normalizeText(saved?.address)) return false;
  if (!validIndianCoordinates(expected?.lat, expected?.lng) || !validIndianCoordinates(saved?.lat, saved?.lng)) return false;
  const toRad = n => n * Math.PI / 180;
  const lat1 = Number(expected.lat), lat2 = Number(saved.lat);
  const dLat = toRad(lat2 - lat1), dLng = toRad(Number(saved.lng) - Number(expected.lng));
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, a))) <= 35;
}
