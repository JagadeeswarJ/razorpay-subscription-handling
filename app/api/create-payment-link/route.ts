import { NextRequest, NextResponse } from 'next/server';
import { getPlanDetails } from '@/lib/billing-config';
import https from 'https';

interface CreatePaymentLinkRequest {
  username: string;
  planId?: string;
  orderId?: string;
  type?: 'prorated' | 'subscription';
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
    const { username, planId, orderId, type }: CreatePaymentLinkRequest = await request.json();

    console.log('Create payment link request:', { username, planId, orderId, type });

    // Handle prorated payment
    if (type === 'prorated' && orderId && username) {
      return await handleProratedPayment(username, orderId);
    }

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

async function handleProratedPayment(username: string, orderId: string) {
  try {
    const razorpayKeyId = process.env.RAZORPAY_ID;
    const razorpayKeySecret = process.env.RAZORPAY_SECRET;

    if (!razorpayKeyId || !razorpayKeySecret) {
      return NextResponse.json(
        { error: 'Payment service configuration error' },
        { status: 500, headers: corsHeaders }
      );
    }

    // Fetch order details from Razorpay
    const auth = Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64');
    
    const orderResponse = await new Promise<any>((resolve, reject) => {
      const options = {
        hostname: 'api.razorpay.com',
        port: 443,
        path: `/v1/orders/${orderId}`,
        method: 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`Failed to fetch order: ${res.statusCode} - ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });

    // Create payment link using Razorpay Payment Links API
    const paymentLinkData = {
      amount: orderResponse.amount,
      currency: 'INR',
      accept_partial: false,
      description: `Prorated upgrade payment for ${username}`,
      customer: {
        name: username,
        contact: username, // assuming username is phone number
      },
      notify: {
        sms: true,
        email: false,
      },
      reminder_enable: true,
      notes: {
        orderId: orderId,
        username: username,
        type: 'prorated_upgrade',
      },
      callback_url: `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/`,
      callback_method: 'get',
    };

    const paymentLink = await new Promise<any>((resolve, reject) => {
      const postData = JSON.stringify(paymentLinkData);
      const options = {
        hostname: 'api.razorpay.com',
        port: 443,
        path: '/v1/payment_links',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          Authorization: `Basic ${auth}`,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`Failed to create payment link: ${res.statusCode} - ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    return NextResponse.json({
      success: true,
      paymentLink: paymentLink.short_url,
      orderId: orderId,
      amount: orderResponse.amount / 100, // Convert to rupees
    }, {
      status: 200,
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Error creating prorated payment link:', error);
    return NextResponse.json(
      { error: 'Failed to create payment link' },
      { status: 500, headers: corsHeaders }
    );
  }
}