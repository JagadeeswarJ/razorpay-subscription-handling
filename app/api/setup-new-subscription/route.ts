import { NextRequest, NextResponse } from 'next/server';
import { getUserTier, updateUserTier } from '@/lib/firebase';
import Razorpay from 'razorpay';

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

    console.log('Setting up new subscription mandate for user:', username);
    
    // Get current user tier
    const currentTier = await getUserTier(username);
    if (!currentTier?.billing?.newSubscriptionId) {
      return NextResponse.json(
        { error: 'No new subscription found for this user' },
        { status: 400, headers: corsHeaders }
      );
    }

    const newSubscriptionId = currentTier.billing.newSubscriptionId;

    // Initialize Razorpay
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_ID!,
      key_secret: process.env.RAZORPAY_SECRET!,
    });

    try {
      // Fetch the new subscription details from Razorpay
      const subscription = await razorpay.subscriptions.fetch(newSubscriptionId);
      
      console.log('New subscription details:', {
        id: subscription.id,
        status: subscription.status,
        short_url: subscription.short_url
      });

      if (subscription.status === 'created' && subscription.short_url) {
        return NextResponse.json({
          success: true,
          message: 'Please authenticate your new subscription to set up UPI mandate',
          subscriptionId: subscription.id,
          paymentLink: subscription.short_url,
          status: subscription.status,
        }, {
          status: 200,
          headers: corsHeaders,
        });
      } else {
        return NextResponse.json({
          success: false,
          message: `Subscription is in ${subscription.status} status`,
          subscriptionId: subscription.id,
          status: subscription.status,
        }, {
          status: 400,
          headers: corsHeaders,
        });
      }

    } catch (razorpayError) {
      console.error('Razorpay API error:', razorpayError);
      return NextResponse.json(
        { error: 'Failed to fetch subscription details from Razorpay' },
        { status: 500, headers: corsHeaders }
      );
    }

  } catch (error) {
    console.error('Error setting up new subscription:', error);
    return NextResponse.json(
      { error: 'Failed to setup new subscription' },
      { status: 500, headers: corsHeaders }
    );
  }
}