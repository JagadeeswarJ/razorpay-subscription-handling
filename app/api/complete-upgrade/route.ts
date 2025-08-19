import { NextRequest, NextResponse } from 'next/server';
import { getUserTier, updateUserTier } from '@/lib/firebase';
import { getPlanDetails } from '@/lib/billing-config';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders,
  });
}

export async function POST(request: NextRequest) {
  try {
    const { username } = await request.json();

    if (!username) {
      return NextResponse.json(
        { error: 'username is required' },
        { status: 400, headers: corsHeaders }
      );
    }

    console.log('Manually completing upgrade for user:', username);
    
    // Get current user tier
    const currentTier = await getUserTier(username);
    if (!currentTier?.billing?.upgradeInProgress) {
      return NextResponse.json(
        { error: 'No upgrade in progress for this user' },
        { status: 400, headers: corsHeaders }
      );
    }

    const newPlanId = currentTier.billing?.newPlanId;
    if (!newPlanId) {
      return NextResponse.json(
        { error: 'No new plan ID found for upgrade' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Get new plan details
    const newPlanDetails = getPlanDetails(newPlanId);
    if (!newPlanDetails) {
      return NextResponse.json(
        { error: 'Invalid new plan ID' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Update user tier immediately with new plan details
    const updates = {
      tier: newPlanDetails.tier,
      'billing.upgradeInProgress': false,
      'billing.proratedPaid': true,
      'billing.proratedPaidAt': new Date().toISOString(),
    };

    await updateUserTier(username, updates);

    console.log(`Manual upgrade completed for user ${username} to tier ${newPlanDetails.tier}`);

    return NextResponse.json({
      success: true,
      message: `Upgrade completed! User ${username} is now on ${newPlanDetails.tier} tier`,
      newTier: newPlanDetails.tier,
    }, {
      status: 200,
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Error completing upgrade:', error);
    return NextResponse.json(
      { error: 'Failed to complete upgrade' },
      { status: 500, headers: corsHeaders }
    );
  }
}