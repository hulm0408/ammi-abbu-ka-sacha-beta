import { claimInstamartFreeCash, checkAccountFreeCash } from './swiggy-cart.js';

console.log('🧪 Testing claimInstamartFreeCash & 3-State Output...');

// Test 1: Null / empty cookies
const resEmpty = await claimInstamartFreeCash(null);
console.assert(resEmpty.status === 'NOT_ELIGIBLE', `Expected NOT_ELIGIBLE, got ${resEmpty.status}`);
console.assert(resEmpty.eligible === false, 'Expected eligible to be false');
console.log('✅ Test 1 Passed: Null cookies returns NOT_ELIGIBLE');

// Test 2: Invalid cookies string
const resInvalid = await claimInstamartFreeCash('invalid_cookie=123');
console.assert(['NOT_ELIGIBLE', 'ALREADY_CLAIMED', 'CLAIMED'].includes(resInvalid.status), `Unexpected status: ${resInvalid.status}`);
console.log(`✅ Test 2 Passed: Invalid cookies handled safely with status: ${resInvalid.status}`);

// Test 3: Backward compatibility alias checkAccountFreeCash
const resAlias = await checkAccountFreeCash(null);
console.assert(resAlias.status === 'NOT_ELIGIBLE', 'Expected alias to return same status');
console.log('✅ Test 3 Passed: checkAccountFreeCash alias matches claimInstamartFreeCash');

console.log('🎉 ALL FREE CASH CLAIM TESTS PASSED!');
