/**
 * run_guards.mjs — guard suite ko DETERMINISTIC tarike se chalata hai.
 *
 * Pehle tests ek hi `data/db.json` par line-se-line chalte the: ek test jo apna
 * state saaf nahi karta, agle test ko tod deta tha (v23 ka fake tracking link
 * v26 ko, v51 ko bhi). Store ab data honest tareeke se rakhta hai, isliye har
 * test ko apna saaf DB milna chahiye.
 *
 * Har test ke pehle `data/db.json` + `accounts.json` hata diye jaate hain (test
 * khud apna state banata hai), aakhir me bhi saaf.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const TESTS = [
  "test_v16_url_only_address_and_order_card_e2e.mjs",
  "test_v17_customer_auto_offer_e2e.mjs",
  "test_v19_share_link_only_e2e.mjs",
  "test_v20_single_card_chat_e2e.mjs",
  "test_v21_personalised_qr_prompts_and_routing_e2e.mjs",
  "test_v22_orders_done_all_ids_e2e.mjs",
  "test_v23_auto_tracking_dashboard_e2e.mjs",
  "test_v24_extract_tracking_fix_e2e.mjs",
  "test_v25_finished_order_otp_status_e2e.mjs",
  "test_v26_real_tracking_and_delivered_links_e2e.mjs",
  "test_v18_auto_bill_summary_and_tracking_e2e.mjs",
  "test_v35_ammi_abbu_topics_progression_e2e.mjs",
  "test_v36_login_prefetch_logout_autoselect_duallink_e2e.mjs",
  "test_v37_order_count_id_assign_choose_diagnostic_e2e.mjs",
  "test_v38_accounts_logout_purge_order_count_display_e2e.mjs",
  "test_v39_file_sequential_intake_order_count_logout_all_e2e.mjs",
  "test_v40_simple_chat_consent_tracking_e2e.mjs",
  "test_v41_integrity_hardening_e2e.mjs",
  "test_v40_lazy_boss_autopilot_e2e.mjs",
  "test_v42_address_link_recovery_e2e.mjs",
  "test_v43_all_six_fixes_e2e.mjs",
  "test_v47_no_false_address_expiry_e2e.mjs",
  "test_v48_address_fetched_but_retry_e2e.mjs",
  "test_v49_payment_ofo_link_e2e.mjs",
  "test_v50_no_fake_incognito_e2e.mjs",
  "test_v51_active_orders_no_wipe_e2e.mjs",
  "test_v52_fast_id_selection_and_qr_deadline_e2e.mjs",
  "test_v53_instant_tracking_link_e2e.mjs",
  "test_v54_any_id_order_extraction_e2e.mjs",
  "test_v55_offer_cash_panel_e2e.mjs",
  "test_v56_user_controls_onoff_quantity_e2e.mjs",
  "test_v57_instant_id_rotation_e2e.mjs",
  "test_v58_auto_offer_claim_and_copy_json_e2e.mjs",
  "test_v59_export_logout_fix_auto_delivery_export_e2e.mjs",
  "test_v60_invalid_qr_and_same_qr_fix_e2e.mjs",
  "test_v61_account_suspension_failover_fast_id_e2e.mjs",
  "test_v62_offer_doctor_night_offer_e2e.mjs",
  "test_v63_no_loop_place_truth_amount_lock_e2e.mjs",
  "test_v64_perf_optimization_e2e.mjs",
  "test_v65_four_offers_every_import_e2e.mjs",
  "test_v66_four_offer_status_boss_and_user_e2e.mjs",
  "test_v67_fixed_offer_discovery_ladder_e2e.mjs",
  "test_v68_qr_applies_offer_before_place_e2e.mjs",
  "test_v69_bulk_files_and_honest_claim_e2e.mjs",
  "test_v70_karwa_chauth_and_customer_phone_login_e2e.mjs",
  "test_v71_order_account_lock_e2e.mjs",
  "test_v72_wallet_fee_e2e.mjs",
  "test_v73_qr_hold_release_and_fee_panel_e2e.mjs",
  "test_v74_tracking_id_adoption_e2e.mjs"
];

const CLEAN_FILES = ['data/db.json', 'accounts.json'];

function cleanState() {
  for (const f of CLEAN_FILES) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
}

const failed = [];
const t0 = Date.now();
for (const test of TESTS) {
  cleanState();
  const started = Date.now();
  const res = spawnSync(process.execPath, [test], { stdio: 'inherit', env: { ...process.env, GUARDS_RUN: '1' } });
  const ms = Date.now() - started;
  if (res.status !== 0) {
    failed.push({ test, status: res.status, ms });
    console.error(`\n❌ GUARD FAILED: ${test} (${ms}ms, exit ${res.status})\n`);
  } else {
    console.log(`\n✓ ${test} (${(ms / 1000).toFixed(1)}s)`);
  }
}
cleanState();

const total = Date.now() - t0;
console.log('\n' + '='.repeat(70));
if (failed.length === 0) {
  console.log(`🏆 GUARDS PASSED — ${TESTS.length}/${TESTS.length} suites, ${(total / 1000).toFixed(1)}s`);
} else {
  console.log(`❌ GUARDS FAILED — ${failed.length}/${TESTS.length} suites failed:`);
  for (const f of failed) console.log(`   • ${f.test} (exit ${f.status})`);
}
console.log('='.repeat(70));
process.exitCode = failed.length === 0 ? 0 : 1;
