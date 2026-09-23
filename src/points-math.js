// ======================================================
// Card points arithmetic — pure, import-free, shared by the Dashboard and
// the Points screen. Both used to carry their own copy of `calcPoints` and
// of the accrued / redeemed / balance / reward-rate block, which is how a
// fix in one screen could leave the other reporting a different balance.
// ======================================================

/** parseFloat that reads null, undefined and garbage as 0. */
const num = v => {
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
};

/**
 * Points on one transaction. An explicit `points` override wins; otherwise
 * amount × multiplier ÷ 100. Every field goes through `num` — a single null
 * amount or multiplier used to turn an entire KPI row into NaN.
 */
export function calcPoints(t) {
  if (t.points !== null && t.points !== undefined) return num(t.points);
  return num(t.amount) * num(t.multiplier) / 100;
}

/**
 * The headline figures for a set of transactions and redemptions.
 *
 * @param {object[]} transactions  cc_points rows
 * @param {object[]} redemptions   cc_redemptions rows
 * @param {{ pointsPerEur: number, eurRate: number }} fx
 *   pointsPerEur — the card's conversion (points per €1 of transfer value)
 *   eurRate      — INR per EUR, live or fallback
 */
export function pointsSummary(transactions, redemptions, { pointsPerEur, eurRate }) {
  const totalAccrued  = transactions.reduce((s, t) => s + calcPoints(t), 0);
  const totalRedeemed = redemptions.reduce((s, r) => s + num(r.points_redeemed), 0);
  const balance       = totalAccrued - totalRedeemed;
  const balanceEUR    = pointsPerEur > 0 ? balance / pointsPerEur : 0;
  const balanceINR    = balanceEUR * eurRate;
  const totalSpent    = transactions.reduce((s, t) => s + num(t.amount), 0);
  const totalRdValue  = redemptions.reduce((s, r) => s + num(r.value_amount), 0);
  // What the card has given back — value already realised plus what the
  // balance is worth today — as a share of everything put through it.
  const rewardRate    = totalSpent > 0 ? ((totalRdValue + balanceINR) / totalSpent) * 100 : 0;
  const avgVPP        = totalRedeemed > 0 ? totalRdValue / totalRedeemed : 0;

  return {
    totalAccrued, totalRedeemed, balance, balanceEUR, balanceINR,
    totalSpent, totalRdValue, rewardRate, avgVPP,
  };
}
