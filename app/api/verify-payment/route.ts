import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const {
      razorpay_payment_id,
      razorpay_subscription_id,
      razorpay_signature,
    } = await request.json();

    const body = razorpay_payment_id + '|' + razorpay_subscription_id;
    
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_SECRET!)
      .update(body.toString())
      .digest('hex');

    const isAuthentic = expectedSignature === razorpay_signature;

    if (isAuthentic) {
      console.log('Payment verified successfully:', {
        payment_id: razorpay_payment_id,
        subscription_id: razorpay_subscription_id,
        timestamp: new Date().toISOString(),
      });

      return NextResponse.json({
        message: 'Payment verified successfully',
        verified: true,
      });
    } else {
      console.error('Payment verification failed:', {
        payment_id: razorpay_payment_id,
        subscription_id: razorpay_subscription_id,
        timestamp: new Date().toISOString(),
      });

      return NextResponse.json(
        { error: 'Payment verification failed' },
        { status: 400 }
      );
    }
  } catch (error) {
    console.error('Payment verification error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}