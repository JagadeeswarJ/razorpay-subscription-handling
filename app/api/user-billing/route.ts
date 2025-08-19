import { NextRequest, NextResponse } from 'next/server';
import { getUserTier } from '@/lib/firebase';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const username = searchParams.get('username');

    if (!username) {
      return NextResponse.json(
        { error: 'Username is required' },
        { status: 400 }
      );
    }

    console.log('Fetching billing status for username:', username);

    const userTier = await getUserTier(username);

    if (!userTier) {
      return NextResponse.json({
        hasSubscription: false,
        username: username,
        message: 'No active subscription found'
      });
    }

    console.log('Found user tier:', userTier);

    return NextResponse.json({
      hasSubscription: true,
      username: username,
      tierEntity: {
        tier: userTier.tier,
        billing: userTier.billing ? {
          renewalPeriod: userTier.billing.renewalPeriod,
          subscriptionStartDate: userTier.billing.subscriptionStartDate,
          subscriptionEndDate: userTier.billing.subscriptionEndDate,
          razorpaySubscriptionId: userTier.billing.razorpaySubscriptionId,
          razorpayCustomerId: userTier.billing.razorpayCustomerId,
        } : undefined,
        createdAt: userTier.createdAt,
        updatedAt: userTier.updatedAt,
      }
    });
  } catch (error) {
    console.error('Error fetching user billing:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}