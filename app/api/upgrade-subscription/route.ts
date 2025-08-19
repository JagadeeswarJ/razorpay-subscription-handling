import { NextRequest, NextResponse } from 'next/server';
import { getPlanDetails } from '@/lib/billing-config';
import { getUserTier, updateUserTier } from '@/lib/firebase';
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
    if (!currentTier || currentTier.subscriptionId !== currentSubscriptionId) {
      return NextResponse.json(
        { error: 'Current subscription not found or mismatch' },
        { status: 404, headers: corsHeaders }
      );
    }

    // Check if it's actually an upgrade/downgrade
    if (currentTier.planId === newPlanId) {
      return NextResponse.json(
        { error: 'User is already on this plan' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Initialize Razorpay
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_ID!,
      key_secret: process.env.RAZORPAY_SECRET!,
    });

    console.log(`Processing ${changeType} for subscription:`, currentSubscriptionId, 'to plan:', newPlanId);

    // Handle upgrade vs downgrade differently
    const scheduleChangeAt = changeType === 'upgrade' ? 'now' : 'cycle_end';
    
    const updateParams: any = {
      plan_id: newPlanId,
      schedule_change_at: scheduleChangeAt,
    };

    // For upgrades: Apply immediately with proration (charge difference now)
    // For downgrades: Apply at end of current cycle (no immediate charge)
    const updatedSubscription = await razorpay.subscriptions.update(currentSubscriptionId, updateParams);

    console.log('Razorpay subscription updated:', updatedSubscription);

    // Update Firebase based on change type
    if (changeType === 'upgrade') {
      // For upgrades, update immediately
      await updateUserTier(username, currentSubscriptionId, {
        tier: newPlanDetails.tier,
        planId: newPlanId,
        amount: newPlanDetails.amount,
      });
    } else {
      // For downgrades, just mark the pending change (actual change happens at cycle end)
      await updateUserTier(username, currentSubscriptionId, {
        pendingPlanChange: newPlanId,
        pendingTier: newPlanDetails.tier,
        pendingAmount: newPlanDetails.amount,
      });
    }

    console.log(`Firebase updated for user: ${username}, change type: ${changeType}`);

    const responseMessage = changeType === 'upgrade' 
      ? `${changeType.charAt(0).toUpperCase() + changeType.slice(1)} successful! You'll be charged the prorated difference immediately.`
      : `${changeType.charAt(0).toUpperCase() + changeType.slice(1)} successful! Your plan will change at the end of the current billing cycle.`;

    const prorationMessage = changeType === 'upgrade'
      ? 'Razorpay has charged the prorated difference for the remaining days'
      : 'No immediate charge. Plan change will take effect at the next billing cycle';

    return NextResponse.json({
      success: true,
      message: responseMessage,
      changeType: changeType,
      subscription: {
        id: updatedSubscription.id,
        status: updatedSubscription.status,
        planId: newPlanId,
        tier: newPlanDetails.tier,
        amount: newPlanDetails.amount,
        scheduleChangeAt: scheduleChangeAt,
      },
      proration: {
        message: prorationMessage,
        newTier: newPlanDetails.tier,
        newAmount: newPlanDetails.amount / 100, // Convert paise to rupees for display
        appliedAt: changeType === 'upgrade' ? 'immediately' : 'next_billing_cycle',
      }
    }, {
      status: 200,
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Error upgrading subscription:', error);
    return NextResponse.json(
      { 
        error: 'Failed to upgrade subscription',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500, headers: corsHeaders }
    );
  }
}