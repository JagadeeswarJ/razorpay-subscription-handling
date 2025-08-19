export const RAZORPAY_PLAN_IDS = {
  BASIC_MONTHLY: 'plan_R7BqkdMkgrZtTS',
  PRO_MONTHLY: 'plan_R7Br0ZKLvh9HXT',
};

export const getPlanDetails = (planId: string) => {
  const planMapping: Record<string, {
    tier: "BASIC" | "PRO";
    renewalPeriod: "MONTHLY";
    amount: number;
  }> = {
    [RAZORPAY_PLAN_IDS.BASIC_MONTHLY]: {
      tier: "BASIC",
      renewalPeriod: "MONTHLY",
      amount: 99900, // ₹999 in paise
    },
    [RAZORPAY_PLAN_IDS.PRO_MONTHLY]: {
      tier: "PRO",
      renewalPeriod: "MONTHLY",
      amount: 299900, // ₹2999 in paise
    },
  };

  return planMapping[planId] || null;
};

// Calculate proration for mid-cycle upgrades
export const calculateProration = (
  currentTier: 'BASIC' | 'PRO',
  newTier: 'BASIC' | 'PRO',
  daysRemaining: number
): number => {
  const currentAmount = currentTier === 'BASIC' ? 99900 : 299900;
  const newAmount = newTier === 'BASIC' ? 99900 : 299900;
  
  // Calculate daily rates (assuming 30 days in a month)
  const currentDailyRate = currentAmount / 30;
  const newDailyRate = newAmount / 30;
  
  // Credit for unused days of current plan
  const creditAmount = Math.round(currentDailyRate * daysRemaining);
  
  // Cost for remaining days of new plan
  const newPlanCost = Math.round(newDailyRate * daysRemaining);
  
  // Net amount to charge (can be negative for downgrades)
  const prorationAmount = newPlanCost - creditAmount;
  
  return Math.max(0, prorationAmount); // Don't allow negative amounts
};

export const getDaysRemainingInCycle = (nextBillingDate: Date): number => {
  const now = new Date();
  const diffTime = nextBillingDate.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
};