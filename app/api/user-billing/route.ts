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
      subscription: {
        id: userTier.subscriptionId,
        tier: userTier.tier,
        status: userTier.status,
        planId: userTier.planId,
        amount: userTier.amount,
        renewalPeriod: userTier.renewalPeriod,
        nextBillingDate: userTier.nextBillingDate,
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