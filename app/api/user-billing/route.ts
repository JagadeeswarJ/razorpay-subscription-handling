import { NextRequest, NextResponse } from 'next/server';
import { getUserBilling } from '@/lib/firebase';

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

    const userBilling = await getUserBilling(username);

    if (!userBilling) {
      return NextResponse.json({
        hasSubscription: false,
        username: username,
        message: 'Error fetching user billing information'
      });
    }

    console.log('Found user billing:', userBilling);

    return NextResponse.json(userBilling);
  } catch (error) {
    console.error('Error fetching user billing:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}