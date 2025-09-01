import { NextRequest, NextResponse } from 'next/server';
import { getUserTier, cancelUserSubscription } from '@/lib/firebase';
import Razorpay from 'razorpay';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

interface CancelRequest {
  username: string;
  subscriptionId: string;
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders,
  });
}

export async function POST(request: NextRequest) {
  try {
    const { username, subscriptionId }: CancelRequest = await request.json();

    console.log('Cancel subscription request:', { username, subscriptionId });

    if (!username || !subscriptionId) {
      return NextResponse.json(
        { error: 'username and subscriptionId are required' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Verify subscription exists
    const currentTier = await getUserTier(username);
    if (!currentTier || currentTier.billing?.razorpaySubscriptionId !== subscriptionId) {
      return NextResponse.json(
        { error: 'Subscription not found or mismatch' },
        { status: 404, headers: corsHeaders }
      );
    }

    // Check if already cancelled
    if (currentTier.billing?.isCancelled) {
      return NextResponse.json(
        { error: 'Subscription is already cancelled' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Initialize Razorpay
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_ID!,
      key_secret: process.env.RAZORPAY_SECRET!,
    });

    // Cancel at end of cycle - user can use until current period ends, but stops future billing
    const razorpayCancellation = await razorpay.subscriptions.cancel(subscriptionId, true);
    
    const endDate = currentTier.billing?.subscriptionEndDate 
      ? new Date(currentTier.billing.subscriptionEndDate).toLocaleDateString()
      : 'current period end';
      
    const message = `Subscription cancelled successfully! You can continue using the service until ${endDate}. No further charges will be made.`;
    
    // Note: Database will be updated via webhook when Razorpay sends subscription.cancelled event

    console.log('Razorpay cancellation response:', razorpayCancellation);

    return NextResponse.json({
      success: true,
      message,
      subscription: {
        id: subscriptionId,
        status: razorpayCancellation.status,
        cancelledAt: new Date().toISOString(),
        accessUntil: currentTier.billing?.subscriptionEndDate,
      },
    }, {
      status: 200,
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Error cancelling subscription:', error);
    return NextResponse.json(
      {
        error: 'Failed to cancel subscription',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500, headers: corsHeaders }
    );
  }
}