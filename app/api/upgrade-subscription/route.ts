import { NextRequest, NextResponse } from 'next/server';
import { getPlanDetails, calculateRefundAmount, getDaysUsedInCycle, getLastBillingDate } from '@/lib/billing-config';
import { getUserTier, updateUserTier, cancelUserSubscription } from '@/lib/firebase';
import Razorpay from 'razorpay';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

interface PlanChangeRequest {
  username: string;
  newPlanId: string;
  currentSubscriptionId: string;
  changeType: 'upgrade' | 'downgrade';
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders,
  });
}

export async function POST(request: NextRequest) {
  try {
    const { username, newPlanId, currentSubscriptionId, changeType }: PlanChangeRequest = await request.json();

    console.log('Subscription plan change request:', { username, newPlanId, currentSubscriptionId, changeType });

    if (!username || !newPlanId || !currentSubscriptionId || !changeType) {
      return NextResponse.json(
        { error: 'username, newPlanId, currentSubscriptionId, and changeType are required' },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!['upgrade', 'downgrade'].includes(changeType)) {
      return NextResponse.json(
        { error: 'changeType must be either "upgrade" or "downgrade"' },
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

    // Check if it's actually an upgrade/downgrade based on tier
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

    console.log(`Processing ${changeType} using cancel+refund+create flow`);

    let refundAmount = 0;
    let refundDetails = null;
    const currentPlanAmount = currentTier.tier === 'BASIC' ? 99900 : 299900;

    // Step 1: Calculate refund (if upgrade) - No refund for downgrades
    if (changeType === 'upgrade' && currentTier.billing?.subscriptionEndDate) {
      const lastBillingDate = getLastBillingDate(new Date(currentTier.billing.subscriptionEndDate));
      const daysUsed = getDaysUsedInCycle(lastBillingDate);
      refundAmount = calculateRefundAmount(currentPlanAmount, daysUsed);

      console.log('Refund calculation:', {
        paidAmount: currentPlanAmount,
        daysUsed,
        refundAmount,
      });
    }

    // Step 2: Cancel current subscription
    console.log('Cancelling current subscription:', currentSubscriptionId);
    await razorpay.subscriptions.cancel(currentSubscriptionId, false);

    // Step 3: Process refund if applicable (only for upgrades)
    if (changeType === 'upgrade' && refundAmount > 0) {
      try {
        // Get recent payments and filter by subscription
        const payments = await razorpay.payments.all({ count: 100 });
        const lastPayment = payments.items.find((p: any) => 
          p.status === 'captured' && 
          p.notes && 
          (p.notes.subscription_id === currentSubscriptionId || p.subscription_id === currentSubscriptionId)
        );

        if (lastPayment) {
          const refund = await razorpay.payments.refund(lastPayment.id, {
            amount: refundAmount,
            speed: 'optimum',
            notes: {
              reason: `Refund for ${changeType}: unused subscription period`,
              subscription_id: currentSubscriptionId,
              new_plan: newPlanId,
              days_unused: Math.ceil(refundAmount / (currentPlanAmount / 30)),
            },
            receipt: `refund_${currentSubscriptionId}_${Date.now()}`,
          });

          refundDetails = {
            refundId: refund.id,
            amount: refundAmount,
            status: refund.status,
          };

          console.log('Refund created:', refundDetails);
        }
      } catch (refundError) {
        console.error('Refund failed:', refundError);
        // Continue with subscription creation even if refund fails
      }
    }

    // Step 4: Create new subscription via payment link
    const newSubscription = await createRazorpaySubscription({
      planId: newPlanId,
      planDetails: newPlanDetails,
      username,
      razorpayKeyId: process.env.RAZORPAY_ID!,
      razorpayKeySecret: process.env.RAZORPAY_SECRET!,
      isReplacement: true,
      oldSubscriptionId: currentSubscriptionId,
    });

    // Step 5: Update Firebase - mark old as cancelled
    await cancelUserSubscription(username, changeType);

    console.log(`Plan change process completed for user: ${username}`);

    const responseMessage = changeType === 'upgrade'
      ? `Upgrade initiated! ${refundAmount > 0 ? `₹${refundAmount / 100} refunded for unused period.` : ''} Complete payment for new plan.`
      : `Downgrade initiated! No refund issued. Complete payment for new plan.`;

    return NextResponse.json({
      success: true,
      message: responseMessage,
      changeType: changeType,
      paymentLink: newSubscription.short_url,
      subscription: {
        id: newSubscription.id,
        status: newSubscription.status,
        planId: newPlanId,
        tier: newPlanDetails.tier,
        amount: newPlanDetails.amount,
      },
      refund: refundDetails,
      refundAmount: refundAmount / 100, // Convert to rupees for display
    }, {
      status: 200,
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Error processing plan change:', error);
    return NextResponse.json(
      {
        error: 'Failed to process plan change',
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
  isReplacement = false,
  oldSubscriptionId,
}: {
  planId: string;
  planDetails: { tier: string; renewalPeriod: string; amount: number };
  username: string;
  razorpayKeyId: string;
  razorpayKeySecret: string;
  isReplacement?: boolean;
  oldSubscriptionId?: string;
}): Promise<any> {
  const totalCount = planDetails.renewalPeriod === 'MONTHLY' ? 12 : 5;

  const subscriptionData = {
    plan_id: planId,
    total_count: totalCount,
    quantity: 1,
    customer_notify: true,
    notes: {
      userId: `USER#${username}`,
      tier: planDetails.tier,
      renewalPeriod: planDetails.renewalPeriod,
      planId: planId,
      isReplacement: isReplacement ? 'true' : 'false',
      oldSubscriptionId: oldSubscriptionId || '',
    },
  };

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