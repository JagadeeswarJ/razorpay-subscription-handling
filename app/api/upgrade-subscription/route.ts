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

// Calculate remaining billing cycles for subscription updates
function calculateRemainingCount(currentTier: any, newPlanDetails: { renewalPeriod: string; tier: string }): number {
  try {
    // Get current subscription end date (try both new and legacy field names)
    const currentEndDate = currentTier?.billing?.currentPeriodEnd || 
                          currentTier?.billing?.subscriptionEndDate;
    
    if (!currentEndDate) {
      console.log('No current end date found, using default remaining_count');
      // Fallback to default values if no end date available
      return newPlanDetails.renewalPeriod === 'MONTHLY' ? 12 : 5;
    }

    const endDate = new Date(currentEndDate);
    const now = new Date();
    
    // Calculate days remaining in current billing cycle
    const daysRemaining = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    
    console.log('Remaining count calculation:', {
      currentEndDate,
      daysRemaining,
      targetPeriod: newPlanDetails.renewalPeriod
    });

    if (daysRemaining <= 0) {
      // Subscription has already expired or expires today
      return newPlanDetails.renewalPeriod === 'MONTHLY' ? 1 : 1;
    }

    if (newPlanDetails.renewalPeriod === 'MONTHLY') {
      // For monthly plans: convert remaining days to months
      // Use 30 days as average month, minimum 1 month, maximum reasonable limit
      const monthsRemaining = Math.ceil(daysRemaining / 30);
      const calculatedCount = Math.max(1, Math.min(36, monthsRemaining)); // 1-36 months range
      
      console.log('Monthly plan remaining_count:', {
        daysRemaining,
        monthsRemaining,
        calculatedCount
      });
      
      return calculatedCount;
    } else {
      // For annual plans: convert remaining days to years
      // Use 365 days per year, minimum 1 year, maximum reasonable limit
      const yearsRemaining = Math.ceil(daysRemaining / 365);
      const calculatedCount = Math.max(1, Math.min(10, yearsRemaining)); // 1-10 years range
      
      console.log('Annual plan remaining_count:', {
        daysRemaining,
        yearsRemaining,
        calculatedCount
      });
      
      return calculatedCount;
    }
    
  } catch (error) {
    console.error('Error calculating remaining_count:', error);
    // Fallback to safe default values on any error
    return newPlanDetails.renewalPeriod === 'MONTHLY' ? 12 : 5;
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

interface UpgradeRequest {
  username: string;
  targetTier: "BASIC" | "PRO";
  targetRenewalPeriod: "MONTHLY" | "ANNUAL";
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders,
  });
}

export async function POST(request: NextRequest) {
  try {
    const { username, targetTier, targetRenewalPeriod }: UpgradeRequest = await request.json();

    console.log('Upgrade subscription request:', { username, targetTier, targetRenewalPeriod });

    if (!username || !targetTier || !targetRenewalPeriod) {
      return NextResponse.json(
        { error: 'username, targetTier, and targetRenewalPeriod are required' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Determine new plan ID from target tier and renewal period
    let newPlanId: string;
    if (targetTier === 'BASIC') {
      newPlanId = targetRenewalPeriod === 'ANNUAL' ? RAZORPAY_PLAN_IDS.BASIC_YEARLY : RAZORPAY_PLAN_IDS.BASIC_MONTHLY;
    } else if (targetTier === 'PRO') {
      newPlanId = targetRenewalPeriod === 'ANNUAL' ? RAZORPAY_PLAN_IDS.PRO_YEARLY : RAZORPAY_PLAN_IDS.PRO_MONTHLY;
    } else {
      return NextResponse.json(
        { error: 'Invalid targetTier. Must be BASIC or PRO' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Get new plan details
    const newPlanDetails = getPlanDetails(newPlanId);
    if (!newPlanDetails) {
      return NextResponse.json(
        { error: 'Invalid target plan configuration' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Get current user tier to verify subscription
    const currentTier = await getUserTier(username);
    if (!currentTier) {
      return NextResponse.json(
        { error: 'User tier not found' },
        { status: 404, headers: corsHeaders }
      );
    }

    // Get current subscription ID from database
    const currentSubscriptionId = currentTier.billing?.razorpaySubscriptionId;

    // Check if user has an active subscription (even without razorpaySubscriptionId)
    const hasActiveSubscription = Boolean(
      currentTier.billing && (
        currentTier.billing.razorpaySubscriptionId ||
        (
          (currentTier.tier === 'BASIC' || currentTier.tier === 'PRO') &&
          (currentTier.billing.status === 'ACTIVE' || !currentTier.billing.status) &&
          !currentTier.billing.isCancelled &&
          !currentTier.billing.subscriptionHalted
        )
      )
    );

    if (!hasActiveSubscription) {
      return NextResponse.json(
        { error: 'No active subscription found to upgrade' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Check if it's actually an upgrade
    const currentTierType = currentTier.tier;
    const currentRenewalPeriod = currentTier.billing?.renewalPeriod;
    
    if (currentTierType === targetTier && currentRenewalPeriod === targetRenewalPeriod) {
      return NextResponse.json(
        { error: 'User is already on this plan' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Define all valid upgrade paths
    const VALID_UPGRADES = [
      // BASIC to PRO upgrades (any billing period combination)
      { from: { tier: "BASIC", renewalPeriod: "MONTHLY" }, to: { tier: "PRO", renewalPeriod: "MONTHLY" } },
      { from: { tier: "BASIC", renewalPeriod: "MONTHLY" }, to: { tier: "PRO", renewalPeriod: "ANNUAL" } },
      { from: { tier: "BASIC", renewalPeriod: "ANNUAL" }, to: { tier: "PRO", renewalPeriod: "MONTHLY" } },
      { from: { tier: "BASIC", renewalPeriod: "ANNUAL" }, to: { tier: "PRO", renewalPeriod: "ANNUAL" } },
      // Plan period changes (same tier, different period)
      { from: { tier: "BASIC", renewalPeriod: "MONTHLY" }, to: { tier: "BASIC", renewalPeriod: "ANNUAL" } },
      { from: { tier: "PRO", renewalPeriod: "MONTHLY" }, to: { tier: "PRO", renewalPeriod: "ANNUAL" } }
    ];

    // Check if the requested upgrade is in the valid upgrades list
    const isValidUpgrade = VALID_UPGRADES.some(upgrade =>
      upgrade.from.tier === currentTierType &&
      upgrade.from.renewalPeriod === currentRenewalPeriod &&
      upgrade.to.tier === targetTier &&
      upgrade.to.renewalPeriod === targetRenewalPeriod
    );

    if (!isValidUpgrade) {
      // Generate available upgrades for this user
      const availableUpgrades = VALID_UPGRADES
        .filter(upgrade => 
          upgrade.from.tier === currentTierType && 
          upgrade.from.renewalPeriod === currentRenewalPeriod
        )
        .map(upgrade => upgrade.to);

      return NextResponse.json({ 
        error: 'Invalid upgrade path',
        currentPlan: { tier: currentTierType, renewalPeriod: currentRenewalPeriod },
        targetPlan: { tier: targetTier, renewalPeriod: targetRenewalPeriod },
        availableUpgrades
      }, { status: 400, headers: corsHeaders });
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
        currentSubscriptionId || '',
        newPlanId,
        newPlanDetails,
        currentTier,
        razorpay,
        billingEndDate,
        corsHeaders
      );
    }

    // Handle users without razorpaySubscriptionId (create new subscription)
    if (!currentSubscriptionId) {
      return await handleNoSubscriptionIdUpgrade(
        username,
        newPlanId,
        newPlanDetails,
        targetTier,
        targetRenewalPeriod,
        currentTierType,
        currentRenewalPeriod || null,
        corsHeaders
      );
    }

    // For card/other payment methods: Use immediate plan update with Razorpay's prorating
    console.log('Processing card/non-UPI upgrade with Razorpay prorating');

    try {
      // Calculate prorated information for logging
      let proratedInfo = null;
      if (billingEndDate) {
        const subscriptionEndDate = new Date(billingEndDate);
        const daysRemaining = getDaysRemainingInCycle(subscriptionEndDate);
        const totalDays = getTotalDaysInCycle(currentTier.billing?.renewalPeriod || "MONTHLY");
        
        // Get current plan amount for comparison
        const currentPlanId = getCurrentPlanId(currentTier.tier, currentTier.billing?.renewalPeriod || "MONTHLY");
        const currentPlanDetails = getPlanDetails(currentPlanId);
        const currentPlanAmount = currentPlanDetails?.amount || 0;
        
        // Calculate what the user would be charged/credited
        const proratedUpgradeCost = calculateProratedUpgradeCost(
          currentPlanAmount,
          newPlanDetails.amount,
          daysRemaining,
          totalDays
        );
        
        proratedInfo = {
          currentPlanAmount,
          newPlanAmount: newPlanDetails.amount,
          daysRemaining,
          totalDays,
          proratedUpgradeCost,
          billingEndDate,
        };

        console.log('Card upgrade prorated calculation:', proratedInfo);
      }

      // Update subscription immediately to new plan - Razorpay will handle prorating automatically
      // Using direct HTTP API instead of SDK for better control and logging
      const updatedSubscription = await updateRazorpaySubscription(
        currentSubscriptionId,
        newPlanId,
        paymentMethod as string,
        { renewalPeriod: targetRenewalPeriod, tier: targetTier },
        currentTier
      );

      console.log('Card subscription updated with prorating:', {
        subscriptionId: updatedSubscription.id,
        status: updatedSubscription.status,
        planId: newPlanId,
        proratedInfo
      });

      // Update user tier in database - webhook will handle final confirmation
      await updateUserTier(username, {
        tier: targetTier,
        'billing.renewalPeriod': targetRenewalPeriod,
        'billing.razorpaySubscriptionId': updatedSubscription.id,
        'billing.upgradeInProgress': false,
        'billing.transitionAt': new Date().toISOString(),
        'billing.lastPaymentStatus': 'PAID',
        'billing.lastPaymentAt': new Date().toISOString(),
        'billing.upgradeMethod': 'card_prorated',
        'billing.proratedInfo': proratedInfo ? JSON.stringify(proratedInfo) : null,
      });

      console.log('Card upgrade completed for user:', username);

      return NextResponse.json({
        success: true,
        message: 'Card subscription upgrade initiated successfully',
        data: {
          upgradeInitiated: new Date().toISOString(),
          fromPlan: { 
            tier: currentTierType, 
            renewalPeriod: currentRenewalPeriod || 'UNKNOWN' 
          },
          toPlan: { 
            tier: targetTier, 
            renewalPeriod: targetRenewalPeriod 
          },
          subscriptionId: updatedSubscription.id,
          razorpayStatus: updatedSubscription.status,
          paymentMethod: paymentMethod || 'card',
          immediateUpgrade: false,
          note: 'Upgrade will be confirmed via webhook. Prorated billing applies.'
        },
      }, {
        status: 200,
        headers: corsHeaders,
      });

    } catch (error) {
      console.error('Failed to upgrade card subscription:', error);
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

// Razorpay subscription update via API (for card-based payments)
const updateRazorpaySubscription = async (
  subscriptionId: string,
  newPlanId: string,
  currentPaymentMethod: string,
  newPlanDetails?: { renewalPeriod: string; tier: string },
  currentTier?: any
): Promise<any> => {
  try {
    // Only allow card-based subscription updates via PATCH API
    if (currentPaymentMethod === 'upi') {
      throw new Error('UPI subscriptions should use createFutureUpiSubscription method');
    }

    // Create basic auth header
    const auth = Buffer.from(`${process.env.RAZORPAY_ID!}:${process.env.RAZORPAY_SECRET!}`).toString('base64');
    
    // Update subscription data - only use parameters Razorpay accepts
    const updateData: any = {
      plan_id: newPlanId,           // New plan (higher tier)
      schedule_change_at: "now",    // Critical: immediate effect
      customer_notify: 1            // Send email to customer
    };

    // Add remaining_count for plans with different billing periods
    if (newPlanDetails) {
      const remainingCount = calculateRemainingCount(currentTier, newPlanDetails);
      updateData.remaining_count = remainingCount;
      
      console.log('Calculated remaining_count for subscription update:', {
        subscriptionId,
        currentTier: currentTier?.tier,
        currentPeriod: currentTier?.billing?.renewalPeriod,
        targetTier: newPlanDetails.tier,
        targetPeriod: newPlanDetails.renewalPeriod,
        remainingCount,
        currentEndDate: currentTier?.billing?.currentPeriodEnd || currentTier?.billing?.subscriptionEndDate
      });
    }

    console.log('Updating Razorpay subscription', { 
      subscriptionId, 
      newPlanId,
      currentPaymentMethod,
      updateData 
    });

    const https = await import('https');
    const postData = JSON.stringify(updateData);

    const options = {
      hostname: 'api.razorpay.com',
      port: 443,
      path: `/v1/subscriptions/${subscriptionId}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': `Basic ${auth}`,
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
            const updatedSubscription = JSON.parse(data);
            console.log('Razorpay subscription updated successfully', {
              statusCode: res.statusCode,
              subscriptionId: updatedSubscription.id,
              newPlanId: updatedSubscription.plan_id,
              status: updatedSubscription.status,
              response: data.substring(0, 500),
            });
            resolve(updatedSubscription);
          } else {
            console.error('Razorpay upgrade API error', {
              statusCode: res.statusCode,
              response: data,
              subscriptionId,
              newPlanId
            });
            reject(new Error(`Razorpay API error: ${res.statusCode} - ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        console.error('Razorpay upgrade request error', { error, subscriptionId, newPlanId });
        reject(error);
      });

      req.write(postData);
      req.end();
    });

  } catch (error) {
    console.error('Error updating Razorpay subscription', { error, subscriptionId, newPlanId });
    throw error;
  }
};

// Handle upgrade for users without razorpaySubscriptionId - create new subscription
async function handleNoSubscriptionIdUpgrade(
  username: string,
  newPlanId: string,
  newPlanDetails: { tier: string; renewalPeriod: string; amount: number },
  targetTier: "BASIC" | "PRO",
  targetRenewalPeriod: "MONTHLY" | "ANNUAL",
  currentTierType: string,
  currentRenewalPeriod: string | null,
  corsHeaders: any
) {
  try {
    console.log('Creating new subscription for user without razorpaySubscriptionId:', {
      username,
      targetTier,
      targetRenewalPeriod,
      newPlanId
    });

    // Create new subscription
    const newSubscription = await createRazorpaySubscription({
      planId: newPlanId,
      planDetails: newPlanDetails,
      username,
      razorpayKeyId: process.env.RAZORPAY_ID!,
      razorpayKeySecret: process.env.RAZORPAY_SECRET!,
      isUpgrade: true,
    });

    // Update user tier with new subscription details
    await updateUserTier(username, {
      tier: targetTier,
      'billing.renewalPeriod': targetRenewalPeriod,
      'billing.razorpaySubscriptionId': newSubscription.id,
      'billing.upgradeInProgress': false,
      'billing.transitionAt': new Date().toISOString(),
      'billing.status': 'ACTIVE',
      'billing.lastPaymentStatus': 'PAID',
      'billing.lastPaymentAt': new Date().toISOString(),
    });

    console.log('New subscription created for upgrade:', newSubscription.id);

    return NextResponse.json({
      success: true,
      message: 'New subscription created successfully for upgrade',
      data: {
        upgradeInitiated: new Date().toISOString(),
        fromPlan: { 
          tier: currentTierType, 
          renewalPeriod: currentRenewalPeriod || 'UNKNOWN' 
        },
        toPlan: { 
          tier: targetTier, 
          renewalPeriod: targetRenewalPeriod 
        },
        subscriptionId: newSubscription.id,
        razorpayStatus: newSubscription.status,
        paymentMethod: 'card',
        immediateUpgrade: true,
        mandateAuthRequired: true,
        mandateUrl: newSubscription.short_url,
        note: 'New subscription created. Please complete payment setup.'
      },
    }, {
      status: 200,
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Failed to create new subscription for upgrade:', error);
    return NextResponse.json({
      error: 'Failed to create new subscription for upgrade',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500, headers: corsHeaders });
  }
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