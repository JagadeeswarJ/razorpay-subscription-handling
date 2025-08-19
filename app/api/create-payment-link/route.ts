import { NextRequest, NextResponse } from 'next/server';
import { getPlanDetails } from '@/lib/billing-config';
import https from 'https';

interface CreatePaymentLinkRequest {
  username: string;
  planId: string;
}

interface PaymentResponse {
  success: boolean;
  paymentLink: string;
  subscriptionId: string;
  status: string;
  planDetails: {
    tier: string;
    renewalPeriod: string;
    amount: number;
  };
}

// CORS headers
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
    const { username, planId }: CreatePaymentLinkRequest = await request.json();

    console.log('Create payment link request:', { username, planId });

    if (!username || !planId) {
      return NextResponse.json(
        { error: 'username and planId are required' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Get plan details
    const planDetails = getPlanDetails(planId);
    if (!planDetails) {
      return NextResponse.json(
        { error: 'Invalid planId' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Get Razorpay credentials from environment
    const razorpayKeyId = process.env.RAZORPAY_ID;
    const razorpayKeySecret = process.env.RAZORPAY_SECRET;

    if (!razorpayKeyId || !razorpayKeySecret) {
      console.error('Razorpay credentials not found');
      return NextResponse.json(
        { error: 'Payment service configuration error' },
        { status: 500, headers: corsHeaders }
      );
    }

    // Create Razorpay Subscription (for new subscriptions only)
    const subscription = await createRazorpaySubscription({
      planId,
      planDetails,
      username,
      razorpayKeyId,
      razorpayKeySecret,
    });

    console.log('Subscription created successfully:', {
      username,
      planId,
      subscriptionId: subscription.id,
      status: subscription.status,
    });

    const response: PaymentResponse = {
      success: true,
      paymentLink: subscription.short_url,
      subscriptionId: subscription.id,
      status: subscription.status,
      planDetails: {
        tier: planDetails.tier,
        renewalPeriod: planDetails.renewalPeriod,
        amount: planDetails.amount,
      },
    };

    return NextResponse.json(response, {
      status: 200,
      headers: corsHeaders,
    });
  } catch (error) {
    console.error('Error creating payment link:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders }
    );
  }
}

async function createRazorpaySubscription({
  planId,
  planDetails,
  username,
  razorpayKeyId,
  razorpayKeySecret,
}: {
  planId: string;
  planDetails: { tier: string; renewalPeriod: string; amount: number };
  username: string;
  razorpayKeyId: string;
  razorpayKeySecret: string;
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
    },
  };

  const postData = JSON.stringify(subscriptionData);
  const auth = Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64');

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
          console.log('Razorpay subscription created:', {
            subscriptionId: subscription.id,
            status: subscription.status,
            shortUrl: subscription.short_url,
          });
          resolve(subscription);
        } else {
          console.error('Razorpay API error:', {
            statusCode: res.statusCode,
            response: data,
          });
          reject(new Error(`Razorpay API error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error('Razorpay request error:', error);
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}