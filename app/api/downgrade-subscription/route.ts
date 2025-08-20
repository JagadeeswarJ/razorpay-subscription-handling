import { NextRequest, NextResponse } from 'next/server';
import { getPlanDetails, getDaysRemainingInCycle, getTotalDaysInCycle, RAZORPAY_PLAN_IDS } from '@/lib/billing-config';
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

interface DowngradeRequest {
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
    const { username, newPlanId, currentSubscriptionId }: DowngradeRequest = await request.json();

    console.log('Downgrade subscription request:', { username, newPlanId, currentSubscriptionId });

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

    // Check if it's actually a downgrade
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

    const paymentMethod = currentTier.billing?.payment_method;
    const billingEndDate = currentTier.billing?.currentPeriodEnd || currentTier.billing?.subscriptionEndDate || null;

    // Check if user has UPI payment method - use different flow for UPI
    if (paymentMethod === 'upi') {
      return await handleUPIDowngrade(
        username,
        currentSubscriptionId,
        newPlanId,
        newPlanDetails,
        currentTier,
        razorpay,
        billingEndDate,
        corsHeaders
      );
    }

    // For card/other payment methods: Schedule downgrade for next cycle
    console.log('Processing card/non-UPI downgrade with schedule change');

    try {
      // Update subscription to change at next cycle
      const updatedSubscription = await razorpay.subscriptions.update(currentSubscriptionId, {
        plan_id: newPlanId,
        schedule_change_at: "now", // This will typically apply at next billing cycle for downgrades
        customer_notify: 1
      });

      console.log('Subscription downgrade scheduled:', updatedSubscription.id);

      // Update user tier with downgrade information
      await updateUserTier(username, {
        'billing.targetPlanId': newPlanId,
        'billing.upgradeInProgress': true, // We reuse this flag for downgrades too
        'billing.transitionAt': billingEndDate || new Date().toISOString(),
      });

      console.log('Downgrade scheduled for user:', username);

      return NextResponse.json({
        success: true,
        message: `Downgrade scheduled! Your plan will change to ${newPlanDetails.tier} at the end of your current billing cycle.`,
        downgradeType: 'scheduled',
        subscription: {
          id: updatedSubscription.id,
          status: updatedSubscription.status,
          currentPlanId: getCurrentPlanId(currentTier.tier, currentTier.billing.renewalPeriod || "MONTHLY"),
          targetPlanId: newPlanId,
          tier: newPlanDetails.tier,
          amount: newPlanDetails.amount,
          effectiveDate: billingEndDate || new Date().toISOString(),
        },
      }, {
        status: 200,
        headers: corsHeaders,
      });

    } catch (error) {
      console.error('Failed to schedule downgrade:', error);
      return NextResponse.json(
        {
          error: 'Failed to schedule downgrade',
          details: error instanceof Error ? error.message : 'Unknown error'
        },
        { status: 500, headers: corsHeaders }
      );
    }

  } catch (error) {
    console.error('Error processing downgrade:', error);
    return NextResponse.json(
      {
        error: 'Failed to process downgrade',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Handle UPI downgrades - calculate prorated refund and process immediately
async function handleUPIDowngrade(
  username: string,
  currentSubscriptionId: string,
  newPlanId: string,
  newPlanDetails: { tier: string; renewalPeriod: string; amount: number },
  currentTier: any,
  razorpay: any,
  billingEndDate: string | null,
  corsHeaders: any
) {
  try {
    console.log('Processing UPI downgrade with prorated refund calculation');

    // Step 1: Fetch current subscription details from Razorpay
    const currentSubscription = await razorpay.subscriptions.fetch(currentSubscriptionId);
    console.log('Current subscription fetched:', currentSubscription.id);

    // Step 2: Calculate prorated refund amount
    let refundAmount = 0;
    if (billingEndDate) {
      const subscriptionEndDate = new Date(billingEndDate);
      const daysRemaining = getDaysRemainingInCycle(subscriptionEndDate);
      const totalDays = getTotalDaysInCycle(currentTier.billing.renewalPeriod || "MONTHLY");
      
      // Get current plan amount based on tier
      const currentPlanDetails = getPlanDetails(getCurrentPlanId(currentTier.tier, currentTier.billing.renewalPeriod || "MONTHLY"));
      const currentPlanAmount = currentPlanDetails?.amount || 0;
      
      // Calculate difference in pricing for remaining days
      const currentDailyRate = currentPlanAmount / totalDays;
      const newDailyRate = newPlanDetails.amount / totalDays;
      const dailyDifference = currentDailyRate - newDailyRate;
      
      if (dailyDifference > 0) {
        refundAmount = Math.round(dailyDifference * daysRemaining);
      }

      console.log('UPI Downgrade calculation:', {
        currentPlanAmount,
        newPlanAmount: newPlanDetails.amount,
        daysRemaining,
        totalDays,
        dailyDifference,
        refundAmount,
      });
    }

    // Step 3: Cancel current subscription
    await razorpay.subscriptions.cancel(currentSubscriptionId, false); // Cancel immediately
    console.log('Current subscription cancelled for UPI downgrade:', currentSubscriptionId);

    // Step 4: Create new subscription with lower tier
    const newSubscription = await createRazorpaySubscription({
      planId: newPlanId,
      planDetails: newPlanDetails,
      username,
      razorpayKeyId: process.env.RAZORPAY_ID!,
      razorpayKeySecret: process.env.RAZORPAY_SECRET!,
      isUpgrade: false, // This is a downgrade
      oldSubscriptionId: currentSubscriptionId,
    });

    console.log('New subscription created for UPI downgrade:', newSubscription.id);

    // Step 5: Process refund if applicable
    if (refundAmount > 0) {
      try {
        console.log('Processing prorated refund for UPI downgrade:', refundAmount);
        
        // Find the last payment for the cancelled subscription using fetch
        const paymentsResponse = await fetch(`https://api.razorpay.com/v1/subscriptions/${currentSubscriptionId}/payments`, {
          headers: {
            'Authorization': `Basic ${Buffer.from(`${process.env.RAZORPAY_ID!}:${process.env.RAZORPAY_SECRET!}`).toString('base64')}`,
            'Content-Type': 'application/json',
          }
        });

        const paymentsData = await paymentsResponse.json();
        
        if (paymentsResponse.ok && paymentsData.items && paymentsData.items.length > 0) {
          const lastPayment = paymentsData.items[0]; // Most recent payment
          
          // Create refund for the difference using fetch
          const refundResponse = await fetch(`https://api.razorpay.com/v1/payments/${lastPayment.id}/refund`, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${Buffer.from(`${process.env.RAZORPAY_ID!}:${process.env.RAZORPAY_SECRET!}`).toString('base64')}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              amount: refundAmount,
              notes: {
                reason: 'UPI downgrade prorated refund',
                old_subscription_id: currentSubscriptionId,
                new_subscription_id: newSubscription.id,
                username: username
              }
            })
          });

          const refundResult = await refundResponse.json();
          
          if (refundResponse.ok) {
            console.log('Refund created for downgrade:', refundResult.id, 'amount:', refundAmount);
          } else {
            console.error('Failed to create refund:', refundResult);
          }
        } else {
          console.log('No payments found for refund, skipping prorated amount');
        }
      } catch (refundError) {
        console.error('Failed to process refund for downgrade:', refundError);
        // Continue with downgrade even if refund fails
      }
    }

    // Step 6: Update user tier
    await updateUserTier(username, {
      'billing.razorpaySubscriptionId': newSubscription.id,
      tier: newPlanDetails.tier,
      'billing.renewalPeriod': newPlanDetails.renewalPeriod,
      'billing.targetPlanId': null,
      'billing.upgradeInProgress': false,
      'billing.transitionAt': new Date().toISOString(),
      'billing.status': 'ACTIVE',
      'billing.lastPaymentStatus': 'PAID',
      'billing.lastPaymentAt': new Date().toISOString(),
    });

    console.log('UPI downgrade completed for user:', username);

    return NextResponse.json({
      success: true,
      message: refundAmount > 0 
        ? `UPI downgrade completed! You will receive a refund of ₹${refundAmount / 100} for the unused period.`
        : 'UPI downgrade completed successfully!',
      downgradeType: 'upi_immediate_with_refund',
      subscription: {
        id: newSubscription.id,
        status: newSubscription.status,
        planId: newPlanId,
        tier: newPlanDetails.tier,
        amount: newPlanDetails.amount,
      },
      refundAmount: refundAmount > 0 ? refundAmount / 100 : 0,
    }, {
      status: 200,
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Failed to process UPI downgrade:', error);
    return NextResponse.json(
      {
        error: 'Failed to process UPI downgrade',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Helper function to create new subscription (copied from upgrade route for consistency)
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