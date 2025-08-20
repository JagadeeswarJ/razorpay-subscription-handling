import { NextRequest, NextResponse } from 'next/server';
import { getPlanDetails, calculateProratedUpgradeCost, getDaysRemainingInCycle, getTotalDaysInCycle, RAZORPAY_PLAN_IDS } from '@/lib/billing-config';
import { getUserTier, updateUserTier } from '@/lib/firebase';
import Razorpay from 'razorpay';

// Helper function to get current plan ID based on tier and renewal period
function getCurrentPlanId(tier: string, renewalPeriod: string): string {
  if (tier === 'BASIC') {
    return renewalPeriod === 'ANNUAL' ? RAZORPAY_PLAN_IDS.BASIC_YEARLY : RAZORPAY_PLAN_IDS.BASIC_MONTHLY;
  } else if (tier === 'PRO') {
    return renewalPeriod === 'ANNUAL' ? RAZORPAY_PLAN_IDS.PRO_YEARLY : RAZORPAY_PLAN_IDS.PRO_MONTHLY;
  }
  
  return RAZORPAY_PLAN_IDS.BASIC_MONTHLY; // fallback
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

interface UpgradeRequest {
  username: string;
  newPlanId: string;
  currentSubscriptionId: string;
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders,
  });
}

export async function POST(request: NextRequest) {
  try {
    const { username, newPlanId, currentSubscriptionId }: UpgradeRequest = await request.json();

    console.log('Upgrade subscription request:', { username, newPlanId, currentSubscriptionId });

    if (!username || !newPlanId || !currentSubscriptionId) {
      return NextResponse.json(
        { error: 'username, newPlanId, and currentSubscriptionId are required' },
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
    if (!currentTier || currentTier.billing?.razorpaySubscriptionId !== currentSubscriptionId) {
      return NextResponse.json(
        { error: 'Current subscription not found or mismatch' },
        { status: 404, headers: corsHeaders }
      );
    }

    // Check if it's actually an upgrade
    const currentTierType = currentTier.tier;
    const newTierType = newPlanDetails.tier;
    if (currentTierType === newTierType) {
      return NextResponse.json(
        { error: 'User is already on this tier' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Initialize Razorpay
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_ID!,
      key_secret: process.env.RAZORPAY_SECRET!,
    });

    const paymentMethod = currentTier.billing?.payment_method;
    const billingEndDate = currentTier.billing?.currentPeriodEnd || currentTier.billing?.subscriptionEndDate || null;

    // Check if user has UPI payment method - use different flow for UPI
    if (paymentMethod === 'upi') {
      return await handleUPIUpgrade(
        username,
        currentSubscriptionId,
        newPlanId,
        newPlanDetails,
        currentTier,
        razorpay,
        billingEndDate,
        corsHeaders
      );
    }

    // For card/other payment methods: Use immediate plan update
    console.log('Processing card/non-UPI upgrade with immediate plan update');

    try {
      // Update subscription immediately to new plan
      const updatedSubscription = await razorpay.subscriptions.update(currentSubscriptionId, {
        plan_id: newPlanId,
        schedule_change_at: "now", // change immediately
        customer_notify: 1
      });

      console.log('Subscription updated immediately:', updatedSubscription.id);

      // Update user tier with new plan details
      await updateUserTier(username, {
        tier: newPlanDetails.tier,
        'billing.renewalPeriod': newPlanDetails.renewalPeriod,
        'billing.targetPlanId': null,
        'billing.upgradeInProgress': false,
        'billing.transitionAt': new Date().toISOString(),
        'billing.lastPaymentStatus': 'PAID',
        'billing.lastPaymentAt': new Date().toISOString(),
      });

      console.log('Immediate upgrade completed for user:', username);

      return NextResponse.json({
        success: true,
        message: 'Subscription upgraded successfully! Your new plan is now active.',
        upgradeType: 'immediate',
        subscription: {
          id: updatedSubscription.id,
          status: updatedSubscription.status,
          planId: newPlanId,
          tier: newPlanDetails.tier,
          amount: newPlanDetails.amount,
        },
      }, {
        status: 200,
        headers: corsHeaders,
      });

    } catch (error) {
      console.error('Failed to update subscription immediately:', error);
      return NextResponse.json(
        {
          error: 'Failed to upgrade subscription',
          details: error instanceof Error ? error.message : 'Unknown error'
        },
        { status: 500, headers: corsHeaders }
      );
    }

  } catch (error) {
    console.error('Error processing upgrade:', error);
    return NextResponse.json(
      {
        error: 'Failed to process upgrade',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500, headers: corsHeaders }
    );
  }
}


// Helper function to create new subscription
async function createRazorpaySubscription({
  planId,
  planDetails,
  username,
  razorpayKeyId,
  razorpayKeySecret,
  isUpgrade = false,
  oldSubscriptionId,
  startAt,
}: {
  planId: string;
  planDetails: { tier: string; renewalPeriod: string; amount: number };
  username: string;
  razorpayKeyId: string;
  razorpayKeySecret: string;
  isUpgrade?: boolean;
  oldSubscriptionId?: string;
  startAt?: number;
}): Promise<any> {
  const totalCount = planDetails.renewalPeriod === 'MONTHLY' ? 12 : 5;

  const subscriptionData: any = {
    plan_id: planId,
    total_count: totalCount,
    quantity: 1,
    customer_notify: true,
    notes: {
      userId: `USER#${username}`,
      tier: planDetails.tier,
      renewalPeriod: planDetails.renewalPeriod,
      planId: planId,
      isUpgrade: isUpgrade ? 'true' : 'false',
      oldSubscriptionId: oldSubscriptionId || '',
    },
  };

  // If startAt is provided, schedule the subscription to start at that time
  if (startAt) {
    subscriptionData.start_at = startAt;
  }

  // Note: Addons are added separately after subscription creation
  // because Razorpay doesn't allow negative amounts during creation

  const postData = JSON.stringify(subscriptionData);
  const auth = Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64');

  const https = await import('https');

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
          resolve(subscription);
        } else {
          reject(new Error(`Razorpay API error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

// Create custom invoice for subscription with discounted first payment
async function createCustomInvoiceForSubscription({
  subscriptionId,
  amount,
  description,
  razorpayKeyId,
  razorpayKeySecret,
}: {
  subscriptionId: string;
  amount: number;
  description: string;
  razorpayKeyId: string;
  razorpayKeySecret: string;
}): Promise<any> {

  const invoiceData = {
    amount: amount, // discounted first payment in paise
    currency: "INR",
    description: description,
    notes: {
      subscription_id: subscriptionId,
      invoice_type: "upgrade_discount_payment",
    },
    customer: {
      email: "user@example.com",
      contact: "9876543210"
    }
  };

  const postData = JSON.stringify(invoiceData);
  const auth = Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64');
  const https = await import('https');

  const options = {
    hostname: 'api.razorpay.com',
    port: 443,
    path: '/v1/invoices',
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
        console.log('Invoice creation response:', res.statusCode, data);
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          const invoice = JSON.parse(data);
          resolve(invoice);
        } else {
          reject(new Error(`Razorpay Invoice API error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

// Create subscription with upfront discount for first payment
async function createRazorpaySubscriptionWithUpfrontDiscount({
  planId,
  planDetails,
  username,
  razorpayKeyId,
  razorpayKeySecret,
  isUpgrade = false,
  oldSubscriptionId,
  discountAmount,
}: {
  planId: string;
  planDetails: { tier: string; renewalPeriod: string; amount: number };
  username: string;
  razorpayKeyId: string;
  razorpayKeySecret: string;
  isUpgrade?: boolean;
  oldSubscriptionId?: string;
  discountAmount: number;
}): Promise<any> {

  // If no discount, use regular subscription creation
  if (discountAmount <= 0) {
    return createRazorpaySubscription({
      planId,
      planDetails,
      username,
      razorpayKeyId,
      razorpayKeySecret,
      isUpgrade,
      oldSubscriptionId,
    });
  }

  const totalCount = planDetails.renewalPeriod === 'MONTHLY' ? 12 : 5;
  const firstPaymentAmount = Math.max(0, planDetails.amount - discountAmount);

  console.log('Creating subscription with upfront discount:', {
    originalAmount: planDetails.amount,
    discountAmount,
    firstPaymentAmount,
  });

  // Create subscription with addons array containing upgrade credit
  const subscriptionData: any = {
    plan_id: planId,
    total_count: totalCount,
    quantity: 1,
    customer_notify: true,
    notes: {
      userId: `USER#${username}`,
      tier: planDetails.tier,
      renewalPeriod: planDetails.renewalPeriod,
      planId: planId,
      isUpgrade: isUpgrade ? 'true' : 'false',
      oldSubscriptionId: oldSubscriptionId || '',
      hasUpfrontDiscount: 'true',
      discountAmount: discountAmount.toString(),
    },
    // Try using offer_id or coupon approach instead of addons
    addons: [
      {
        item: {
          name: "Upgrade Credit",
          amount: discountAmount, // Positive amount that will be credited
          currency: "INR"
        },
        quantity: 1
      }
    ]
  };

  const postData = JSON.stringify(subscriptionData);
  const auth = Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64');
  const https = await import('https');

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
        console.log('Subscription creation response:', res.statusCode, data);
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          const subscription = JSON.parse(data);
          resolve(subscription);
        } else {
          reject(new Error(`Razorpay API error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

// Handle UPI upgrades - cancel current subscription and create new with prorated addon
async function handleUPIUpgrade(
  username: string,
  currentSubscriptionId: string,
  newPlanId: string,
  newPlanDetails: { tier: string; renewalPeriod: string; amount: number },
  currentTier: any,
  razorpay: any,
  billingEndDate: string | null,
  corsHeaders: any
) {
  try {
    console.log('=== Starting UPI upgrade with cancel and recreate flow ===');
    console.log('Current subscription:', currentSubscriptionId);
    console.log('Target plan:', newPlanId);
    console.log('User:', username);

    // Step 1: Calculate prorated amount for unused period
    let proratedAmount = 0;
    if (billingEndDate) {
      const subscriptionEndDate = new Date(billingEndDate);
      const daysRemaining = getDaysRemainingInCycle(subscriptionEndDate);
      const totalDays = getTotalDaysInCycle(currentTier.billing.renewalPeriod || "MONTHLY");
      
      // Get current plan amount based on tier
      const currentPlanDetails = getPlanDetails(getCurrentPlanId(currentTier.tier, currentTier.billing.renewalPeriod || "MONTHLY"));
      const currentPlanAmount = currentPlanDetails?.amount || 0;
      
      // Calculate unused amount that can be credited
      const dailyRate = currentPlanAmount / totalDays;
      proratedAmount = Math.round(dailyRate * daysRemaining);

      console.log('=== UPI Prorated calculation ===');
      console.log({
        currentPlanAmount,
        newPlanAmount: newPlanDetails.amount,
        daysRemaining,
        totalDays,
        dailyRate,
        proratedAmount,
        billingEndDate,
        subscriptionEndDate: subscriptionEndDate.toISOString(),
      });
    } else {
      console.log('No billing end date found, skipping prorated calculation');
    }

    // Step 2: Create new subscription (without cancelling old one yet)
    // We'll cancel the old subscription after the new one is authenticated
    console.log('=== Creating new subscription for UPI upgrade ===');
    console.log('Plan details:', {
      planId: newPlanId,
      tier: newPlanDetails.tier,
      renewalPeriod: newPlanDetails.renewalPeriod,
      amount: newPlanDetails.amount,
      proratedDiscount: proratedAmount,
    });

    // Create regular subscription with full plan amount for mandate authentication
    const newSubscription = await createRazorpaySubscription({
      planId: newPlanId,
      planDetails: newPlanDetails,
      username,
      razorpayKeyId: process.env.RAZORPAY_ID!,
      razorpayKeySecret: process.env.RAZORPAY_SECRET!,
      isUpgrade: true,
      oldSubscriptionId: currentSubscriptionId,
    });

    console.log('=== New subscription created successfully ===');
    console.log('Subscription ID:', newSubscription.id);
    console.log('Subscription status:', newSubscription.status);
    console.log('Checkout URL:', newSubscription.short_url || 'None');

    // Step 3: Create custom invoice with discounted first payment (if discount applies)
    let customInvoice = null;
    if (proratedAmount > 0) {
      const discountedFirstPayment = Math.max(0, newPlanDetails.amount - proratedAmount);
      console.log('=== Creating custom invoice with discounted first payment ===');
      console.log('Original amount:', newPlanDetails.amount);
      console.log('Discounted first payment:', discountedFirstPayment);

      try {
        customInvoice = await createCustomInvoiceForSubscription({
          subscriptionId: newSubscription.id,
          amount: discountedFirstPayment,
          description: `${newPlanDetails.tier} Plan - First Month (Upgrade Discount Applied)`,
          razorpayKeyId: process.env.RAZORPAY_ID!,
          razorpayKeySecret: process.env.RAZORPAY_SECRET!,
        });
        
        console.log('Custom invoice created:', customInvoice.id);
        console.log('Invoice amount:', customInvoice.amount / 100);
      } catch (invoiceError) {
        console.error('Failed to create custom invoice:', invoiceError);
        // Continue without custom invoice - user will pay full amount
      }
    }

    // Step 4: Store old subscription ID for deletion after authentication
    // The webhook will handle cancelling the old subscription
    await updateUserTier(username, {
      'billing.razorpaySubscriptionId': newSubscription.id,
      tier: newPlanDetails.tier,
      'billing.renewalPeriod': newPlanDetails.renewalPeriod,
      'billing.targetPlanId': null,
      'billing.upgradeInProgress': false,
      'billing.transitionAt': new Date().toISOString(),
      'billing.status': 'ACTIVE',
      'billing.lastPaymentStatus': 'PAID',
      'billing.lastPaymentAt': new Date().toISOString(),
    });

    console.log('UPI upgrade completed for user:', username);

    // Use custom invoice URL if available, otherwise subscription URL
    let checkoutUrl = null;
    let actualPaymentAmount = newPlanDetails.amount;
    
    if (customInvoice && customInvoice.short_url) {
      checkoutUrl = customInvoice.short_url;
      actualPaymentAmount = customInvoice.amount;
      console.log('Using custom invoice checkout URL:', checkoutUrl);
      console.log('Custom invoice amount:', actualPaymentAmount / 100);
    } else if (newSubscription.short_url) {
      checkoutUrl = newSubscription.short_url;
      console.log('Using subscription checkout URL:', checkoutUrl);
    } else {
      console.log('No checkout URL available');
    }

    const displayPaymentAmount = actualPaymentAmount / 100;
    const regularAmount = newPlanDetails.amount / 100;
    const hasDiscount = customInvoice && proratedAmount > 0;
    
    return NextResponse.json({
      success: true,
      message: hasDiscount
        ? `Pay ₹${displayPaymentAmount} now (upgrade discount applied). Autopay set for ₹${regularAmount}/month.`
        : `Complete UPI mandate setup for ₹${regularAmount}/month plan.`,
      upgradeType: 'upi_custom_first_invoice',
      subscription: {
        id: newSubscription.id,
        status: newSubscription.status,
        planId: newPlanId,
        tier: newPlanDetails.tier,
        amount: newPlanDetails.amount,
      },
      invoice: customInvoice ? {
        id: customInvoice.id,
        amount: customInvoice.amount,
        url: customInvoice.short_url,
      } : null,
      firstPaymentAmount: displayPaymentAmount,
      regularAmount: regularAmount,
      requiresAuthentication: true,
      checkoutUrl: checkoutUrl,
    }, {
      status: 200,
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Failed to process UPI upgrade:', error);
    return NextResponse.json(
      {
        error: 'Failed to process UPI upgrade',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500, headers: corsHeaders }
    );
  }
}