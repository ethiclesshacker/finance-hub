// Personal finance constants — single source of truth
export const USER_NAME = 'Aditya';
export const USER_AGE = 26;
export const USER_MONTHLY_NET_INCOME = 93795;   // ₹93795/month
export const USER_MONTHLY_EXPENSES = 40000;     // ₹40,000/month baseline

// FI targets
export const FI_ANNUAL_EXPENSES = USER_MONTHLY_EXPENSES * 12;  // ₹4,80,000/yr
export const FI_TARGET = FI_ANNUAL_EXPENSES * 25;              // ₹1,05,00,000 (25× rule)
export const PASSIVE_INCOME_YIELD = 0.05;                     // 5% blended yield

// Points / HSBC TravelOne
export const POINTS_PER_EUR = 50;
export const EUR_INR_FALLBACK = 110.00;
export const MULTIPLIER_OPTIONS = [
  { label: '0× (Non-earning)', value: 0 },
  { label: '2× (Base rate)', value: 2 },
  { label: '4× (Select merchants)', value: 4 },
  { label: '16× (Partner bonus)', value: 16 },
  { label: '24× (Max bonus)', value: 24 },
];

// Reward partners
export const REDEMPTION_PARTNERS = [
  'United Miles', 'Singapore KrisFlyer', 'Air India',
  'British Airways Avios', 'Cathay Asia Miles', 'Emirates Skywards',
  'Marriott Bonvoy', 'IHG One Rewards', 'Hilton Honors',
  'Club Vistara', 'Etihad Guest', 'Accor ALL','Other'
];

// Targets & thresholds
export const CC_MILESTONE_TARGET = 1200000;              // ₹12L milestone for HSBC TravelOne
export const CC_REWARD_TARGET_RATE = 8;                 // 8% reward target rate
export const SOLVENCY_HEALTHY_TARGET = 3;               // 3× solvency ratio target
export const EMERGENCY_RUNWAY_HEALTHY_TARGET = 6;       // 6 months emergency runway target

