import { NextRequest, NextResponse } from 'next/server';
import { getPlanDetails, calculateProratedUpgradeCost, getDaysRemainingInCycle, getTotalDaysInCycle, RAZORPAY_PLAN_IDS } from '@/lib/billing-config';
import { getUserTier, updateUserTier } from '@/lib/firebase';
import Razorpay from 'razorpay';

// Helper function to get current plan ID based on tier and renewal period
function getCurrentPlanId(tier: string, renewalPeriod: string): string {
  if (tier === 'BASIC') {
    return renewalPeriod === 'ANNUAL' ? RAZORPAY_PLAN_IDS.BASIC_YEARLY : RAZORPAY_PLAN_IDS.BASIC_MONTHLY;
  } else if (tier === 'PRO') {
    return renewalPeriod === 'ANNUAL' ? RAZORPAY_PLAN_IDS.PRO_YEARLY : RAZORPAY_PLAN_IDS.PRO_MONTHLY;
  }
  
  return RAZORPAY_PLAN_IDS.BASIC_MONTHLY; // fallback
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

interface UpgradeRequest {
  username: string;
  newPlanId: string;
  currentSubscriptionId: string;
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders,
  });
}

export async function POST(request: NextRequest) {
  try {
    const { username, newPlanId, currentSubscriptionId }: UpgradeRequest = await request.json();

    console.log('Upgrade subscription request:', { username, newPlanId, currentSubscriptionId });

    if (!username || !newPlanId || !currentSubscriptionId) {
      return NextResponse.json(
        { error: 'username, newPlanId, and currentSubscriptionId are required' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Get new plan details
    const newPlanDetails = getPlanDetails(newPlanId);
    if (!newPlanDetails) {
      return NextResponse.json(
        { error: 'Invalid newPlanId' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Get current user tier to verify subscription
    const currentTier = await getUserTier(username);
    if (!currentTier || currentTier.billing?.razorpaySubscriptionId !== currentSubscriptionId) {
      return NextResponse.json(
        { error: 'Current subscription not found or mismatch' },
        { status: 404, headers: corsHeaders }
      );
    }

    // Check if it's actually an upgrade
    const currentTierType = currentTier.tier;
    const newTierType = newPlanDetails.tier;
    if (currentTierType === newTierType) {
      return NextResponse.json(
        { error: 'User is already on this tier' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Initialize Razorpay
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_ID!,
      key_secret: process.env.RAZORPAY_SECRET!,
    });

    // Step 1: Calculate prorated upgrade cost
    let proratedAmount = 0;
    const billingEndDate = currentTier.billing?.currentPeriodEnd || currentTier.billing?.subscriptionEndDate;
    if (billingEndDate) {
      const subscriptionEndDate = new Date(billingEndDate);
      const daysRemaining = getDaysRemainingInCycle(subscriptionEndDate);
      const totalDays = getTotalDaysInCycle(currentTier.billing.renewalPeriod || "MONTHLY");
      
      // Get current plan amount based on tier
      const currentPlanDetails = getPlanDetails(getCurrentPlanId(currentTier.tier, currentTier.billing.renewalPeriod || "MONTHLY"));
      const currentPlanAmount = currentPlanDetails?.amount || 0;
      
      proratedAmount = calculateProratedUpgradeCost(
        currentPlanAmount,
        newPlanDetails.amount,
        daysRemaining,
        totalDays
      );

      console.log('Prorated calculation:', {
        currentPlanAmount,
        newPlanAmount: newPlanDetails.amount,
        daysRemaining,
        totalDays,
        proratedAmount,
      });
    }

    let proratedPaymentOrder = null;
    
    // Step 2: Create prorated payment order if needed
    if (proratedAmount > 0) {
      proratedPaymentOrder = await razorpay.orders.create({
        amount: proratedAmount, // amount in paise
        currency: 'INR',
        receipt: `upgrade_${currentSubscriptionId}_${Date.now()}`,
        notes: {
          userId: `USER#${username}`,
          subscriptionId: currentSubscriptionId,
          newPlanId: newPlanId,
          upgradeType: 'prorated',
          proratedAmount: proratedAmount.toString(),
        },
      });

      console.log('Prorated payment order created:', proratedPaymentOrder.id);
    }

    // Step 3: Create new subscription for next cycle
    const newSubscription = await createRazorpaySubscription({
      planId: newPlanId,
      planDetails: newPlanDetails,
      username,
      razorpayKeyId: process.env.RAZORPAY_ID!,
      razorpayKeySecret: process.env.RAZORPAY_SECRET!,
      isUpgrade: true,
      oldSubscriptionId: currentSubscriptionId,
      startAt: billingEndDate ? Math.floor(new Date(billingEndDate).getTime() / 1000) : undefined,
    });

    // Step 4: Update user tier with upgrade info using new structure
    await updateUserTier(username, {
      'billing.upgradeInProgress': true,
      'billing.targetPlanId': newPlanId,
      'billing.transitionAt': billingEndDate || new Date().toISOString(),
      // Keep legacy fields for backward compatibility
      'billing.newPlanId': newPlanId,
      'billing.newSubscriptionId': newSubscription.id,
      'billing.proratedOrderId': proratedPaymentOrder?.id || null,
      'billing.proratedAmount': proratedAmount,
    });

    console.log('Upgrade process initiated for user:', username);

    return NextResponse.json({
      success: true,
      message: proratedAmount > 0 
        ? `Upgrade initiated! Pay ₹${proratedAmount / 100} prorated amount to complete upgrade.`
        : 'Upgrade initiated! Your new plan will start from the next billing cycle.',
      upgradeType: proratedAmount > 0 ? 'immediate_with_proration' : 'next_cycle',
      proratedPayment: proratedPaymentOrder ? {
        orderId: proratedPaymentOrder.id,
        amount: proratedAmount,
        currency: 'INR',
      } : null,
      newSubscription: {
        id: newSubscription.id,
        status: newSubscription.status,
        planId: newPlanId,
        tier: newPlanDetails.tier,
        amount: newPlanDetails.amount,
        startDate: billingEndDate || new Date().toISOString(),
      },
      proratedAmount: proratedAmount / 100, // Convert to rupees for display
    }, {
      status: 200,
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Error processing upgrade:', error);
    return NextResponse.json(
      {
        error: 'Failed to process upgrade',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500, headers: corsHeaders }
    );
  }
}


// Helper function to create new subscription
async function createRazorpaySubscription({
  planId,
  planDetails,
  username,
  razorpayKeyId,
  razorpayKeySecret,
  isUpgrade = false,
  oldSubscriptionId,
  startAt,
}: {
  planId: string;
  planDetails: { tier: string; renewalPeriod: string; amount: number };
  username: string;
  razorpayKeyId: string;
  razorpayKeySecret: string;
  isUpgrade?: boolean;
  oldSubscriptionId?: string;
  startAt?: number;
}): Promise<any> {
  const totalCount = planDetails.renewalPeriod === 'MONTHLY' ? 12 : 5;

  const subscriptionData: any = {
    plan_id: planId,
    total_count: totalCount,
    quantity: 1,
    customer_notify: true,
    notes: {
      userId: `USER#${username}`,
      tier: planDetails.tier,
      renewalPeriod: planDetails.renewalPeriod,
      planId: planId,
      isUpgrade: isUpgrade ? 'true' : 'false',
      oldSubscriptionId: oldSubscriptionId || '',
    },
  };

  // If startAt is provided, schedule the subscription to start at that time
  if (startAt) {
    subscriptionData.start_at = startAt;
  }

  const postData = JSON.stringify(subscriptionData);
  const auth = Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64');

  const https = await import('https');

  const options = {
    hostname: 'api.razorpay.com',
    port: 443,
    path: '/v1/subscriptions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      Authorization: `Basic ${auth}`,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          const subscription = JSON.parse(data);
          resolve(subscription);
        } else {
          reject(new Error(`Razorpay API error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}