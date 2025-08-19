export const RAZORPAY_PLAN_IDS = {
  BASIC_MONTHLY: 'plan_R7G6hu5lBKJdpl',
  PRO_MONTHLY: 'plan_R7G7VNbsYt55dG',
  BASIC_YEARLY: 'plan_R7G8xw8x4WDSoM',
  PRO_YEARLY: 'plan_R7G9duBj5HV9Oz',
};

export const getPlanDetails = (planId: string) => {
  const planMapping: Record<string, {
    tier: "BASIC" | "PRO";
    renewalPeriod: "MONTHLY" | "ANNUAL";
    amount: number;
  }> = {
    [RAZORPAY_PLAN_IDS.BASIC_MONTHLY]: {
      tier: "BASIC",
      renewalPeriod: "MONTHLY",
      amount: 8900, // ₹89 in paise
    },
    [RAZORPAY_PLAN_IDS.PRO_MONTHLY]: {
      tier: "PRO",
      renewalPeriod: "MONTHLY",
      amount: 12900, // ₹129 in paise
    },
    [RAZORPAY_PLAN_IDS.BASIC_YEARLY]: {
      tier: "BASIC",
      renewalPeriod: "ANNUAL",
      amount: 74900, // ₹749 in paise
    },
    [RAZORPAY_PLAN_IDS.PRO_YEARLY]: {
      tier: "PRO",
      renewalPeriod: "ANNUAL",
      amount: 108900, // ₹1089 in paise
    },
  };

  return planMapping[planId] || null;
};

// Calculate prorated upgrade cost for mid-cycle upgrades
export const calculateProratedUpgradeCost = (
  currentPlanAmount: number, // in paise
  newPlanAmount: number, // in paise
  daysRemaining: number,
  totalDaysInCycle: number = 30
): number => {
  const dailyDifference = (newPlanAmount - currentPlanAmount) / totalDaysInCycle;
  const proratedCost = Math.round(dailyDifference * daysRemaining);
  return Math.max(0, proratedCost);
};

// Calculate days remaining in current billing cycle
export const getDaysRemainingInCycle = (subscriptionEndDate: Date): number => {
  const now = new Date();
  const diffTime = subscriptionEndDate.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
};

// Calculate total days in billing cycle
export const getTotalDaysInCycle = (renewalPeriod: "MONTHLY" | "ANNUAL"): number => {
  return renewalPeriod === "ANNUAL" ? 365 : 30;
};

