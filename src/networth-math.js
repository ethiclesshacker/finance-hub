// ======================================================
// Net worth computations — single source of truth.
// All views must use these instead of inline arithmetic.
// To add a new asset class, update only here.
//
// Deliberately free of imports: no DOM, no Chart.js, no Supabase. That keeps
// it runnable (and testable) outside a browser, which is why finance.js pulls
// from here rather than from utils.js.
// ======================================================

/**
 * Sum of all asset classes for a snapshot entry.
 * @param {object} e - a net_worth_entries row (may be null/undefined)
 */
export function computeAssets(e) {
  if (!e) return 0;
  return (e.stocks || 0) + (e.mutual_funds || 0) + (e.cash || 0)
       + (e.epf || 0) + (e.gold || 0) + (e.fds || 0);
}

/**
 * Everything you could reach quickly, market risk included.
 */
export function computeLiquid(e) {
  if (!e) return 0;
  return (e.stocks || 0) + (e.mutual_funds || 0) + (e.cash || 0);
}

/**
 * Cash-like assets only — cash and fixed deposits.
 *
 * The conservative emergency-fund basis. Stocks and mutual funds tend to be
 * down at exactly the moment an emergency arrives, so counting them makes the
 * runway read healthier than it is. Which basis the runway KPI uses is the
 * `emergency_fund_basis` setting.
 */
export function computeCashLike(e) {
  if (!e) return 0;
  return (e.cash || 0) + (e.fds || 0);
}

/** Emergency fund under the user's chosen basis. */
export function computeEmergencyFund(e, basis) {
  return basis === 'cash_like' ? computeCashLike(e) : computeLiquid(e);
}

/**
 * Net worth = total assets − liabilities.
 */
export function computeNet(e) {
  if (!e) return 0;
  return computeAssets(e) - (e.credit_cards || 0);
}
