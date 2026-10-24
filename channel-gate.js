// ============================================================================
// channel-gate.js — Mandatory Telegram Channel Subscription Gate
// ============================================================================
// Ensures that NO user can use the bot until they have joined the required channel:
//   Channel: @its_NoooB (https://t.me/its_NoooB)
//
// Rules enforced:
//   1. All non-boss users are verified via Telegram Bot API getChatMember.
//   2. If a user has not joined, all commands, messages, and callback actions
//      are blocked with a clean "Join @its_NoooB" card.
//   3. Bosses (isBoss) are 100% exempt and never blocked.
//   4. Membership is cached in-memory with a short TTL to keep bot responses fast
//      and avoid Telegram API rate limits.
//   5. Manual "Check Joined" button forces an instant live re-verification.

import { isBoss } from './store.js';

export const REQUIRED_CHANNEL = '@its_NoooB';
export const REQUIRED_CHANNEL_URL = 'https://t.me/its_NoooB';

// In-memory cache for user channel verification: userId -> { isMember: boolean, reason?: string, expiresAt: number }
const memberCache = new Map();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes cache for verified members

let testMockChecker = null;

/**
 * Configure a mock checker for unit/E2E testing without external Telegram network calls.
 */
export function setChannelGateMock(fn) {
  testMockChecker = typeof fn === 'function' ? fn : (fn === null ? null : () => Boolean(fn));
}

/**
 * Clear cached verification for a user so next check is guaranteed live.
 */
export function clearChannelMemberCache(userId) {
  if (userId) memberCache.delete(String(userId));
}

/**
 * Format the user-facing Force-Join Card.
 */
export function formatChannelJoinCard() {
  const text =
    `📢 <b>Channel Join Karna Zaroori Hai!</b>\n\n` +
    `Mera bot use karne ke liye pehle hamara official channel join karein:\n` +
    `👉 <b>${REQUIRED_CHANNEL}</b>\n\n` +
    `Channel join karne ke baad neeche <b>[ ✅ Check Joined ]</b> button dabayein taaki aapka access unlock ho sake!`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: `📢 Join ${REQUIRED_CHANNEL}`, url: REQUIRED_CHANNEL_URL }],
        [{ text: '✅ Check Joined', callback_data: 'check_channel_joined' }]
      ]
    }
  };

  return { text, keyboard };
}

/**
 * Helper to determine if we are running in an offline automated test suite.
 */
export function isTestRunner() {
  if (process.env.ENFORCE_CHANNEL_GATE === '1') return false;
  return process.argv.some(arg => /test_[^/\\]+\.mjs$/i.test(arg));
}

/**
 * Checks whether a user is currently a member of the required channel.
 * Returns { isMember: boolean, reason: string }
 */
export async function checkUserChannelMembership(telegram, userId, { bypassCache = false } = {}) {
  const idStr = String(userId || '');
  if (!idStr) return { isMember: false, reason: 'NO_USER_ID' };

  // Boss is unconditionally exempt from channel gate
  if (isBoss(idStr)) return { isMember: true, reason: 'BOSS_EXEMPT' };

  // Testing mock override
  if (testMockChecker) {
    const res = await testMockChecker(idStr);
    return typeof res === 'object' ? res : { isMember: Boolean(res), reason: res ? 'MOCK_JOINED' : 'MOCK_NOT_JOINED' };
  }

  // Check cached status
  const now = Date.now();
  if (!bypassCache && memberCache.has(idStr)) {
    const cached = memberCache.get(idStr);
    if (now < cached.expiresAt) {
      return { isMember: cached.isMember, reason: cached.reason };
    }
    memberCache.delete(idStr);
  }

  try {
    const member = await telegram.getChatMember(REQUIRED_CHANNEL, Number(idStr) || idStr);
    const validStatuses = ['creator', 'administrator', 'member', 'restricted'];
    const isMember = Boolean(member && validStatuses.includes(member.status));

    const result = {
      isMember,
      reason: isMember ? 'VERIFIED_MEMBER' : 'NOT_MEMBER'
    };

    memberCache.set(idStr, {
      isMember,
      reason: result.reason,
      expiresAt: now + (isMember ? CACHE_TTL_MS : 10_000)
    });

    return result;
  } catch (err) {
    const desc = String(err?.description || err?.message || '');
    if (/member list is inaccessible/i.test(desc)) {
      console.warn(`[ChannelGate] Telegram API: member list is inaccessible. Please ensure the bot is added as an Administrator to ${REQUIRED_CHANNEL}.`);
      return { isMember: false, reason: 'ADMIN_REQUIRED' };
    }

    if (/user not found|PARTICIPANT_ID_INVALID|not a member|chat not found/i.test(desc)) {
      memberCache.set(idStr, { isMember: false, reason: 'NOT_FOUND', expiresAt: now + 10_000 });
      return { isMember: false, reason: 'NOT_FOUND' };
    }

    console.warn(`[ChannelGate] Error verifying membership for user ${idStr}:`, desc);
    return { isMember: false, reason: 'API_ERROR' };
  }
}
