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
    // Get current subscription end date from simplified schema
    const currentEndDate = currentTier?.billing?.subscriptionEndDate;
    
    if (!currentEndDate) {
      console.log('No subscription end date found, using default remaining_count');
      // Fallback to default values if no end date available
      return newPlanDetails.renewalPeriod === 'MONTHLY' ? 12 : 5;
    }

    const endDate = new Date(currentEndDate);
    const now = new Date();
    
    // Calculate days remaining in current billing cycle
    const daysRemaining = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    
    console.log('Remaining count calculation:', {
      subscriptionEndDate: currentEndDate,
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

interface PlanChangeRequest {
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
    const { username, targetTier, targetRenewalPeriod }: PlanChangeRequest = await request.json();

    console.log('Plan change request:', { username, targetTier, targetRenewalPeriod });

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

    // Check if user has an active subscription
    const hasActiveSubscription = Boolean(
      currentTier.billing && 
      currentTier.billing.razorpaySubscriptionId &&
      !currentTier.billing.isCancelled &&
      (currentTier.tier === 'BASIC' || currentTier.tier === 'PRO')
    );

    if (!hasActiveSubscription) {
      return NextResponse.json(
        { error: 'No active subscription found to change' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Check if it's actually a change
    const currentTierType = currentTier.tier;
    const currentRenewalPeriod = currentTier.billing?.renewalPeriod;
    
    if (currentTierType === targetTier && currentRenewalPeriod === targetRenewalPeriod) {
      return NextResponse.json(
        { error: 'User is already on this plan' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Define all valid plan changes
    const VALID_PLAN_CHANGES = [
      // Upgrades
      { from: { tier: "BASIC", renewalPeriod: "MONTHLY" }, to: { tier: "PRO", renewalPeriod: "MONTHLY" } },
      { from: { tier: "BASIC", renewalPeriod: "MONTHLY" }, to: { tier: "PRO", renewalPeriod: "ANNUAL" } },
      { from: { tier: "BASIC", renewalPeriod: "ANNUAL" }, to: { tier: "PRO", renewalPeriod: "MONTHLY" } },
      { from: { tier: "BASIC", renewalPeriod: "ANNUAL" }, to: { tier: "PRO", renewalPeriod: "ANNUAL" } },
      // Period changes (same tier, different period)
      { from: { tier: "BASIC", renewalPeriod: "MONTHLY" }, to: { tier: "BASIC", renewalPeriod: "ANNUAL" } },
      { from: { tier: "PRO", renewalPeriod: "MONTHLY" }, to: { tier: "PRO", renewalPeriod: "ANNUAL" } },
      // Downgrades
      { from: { tier: "PRO", renewalPeriod: "MONTHLY" }, to: { tier: "BASIC", renewalPeriod: "MONTHLY" } },
      { from: { tier: "PRO", renewalPeriod: "MONTHLY" }, to: { tier: "BASIC", renewalPeriod: "ANNUAL" } },
      { from: { tier: "PRO", renewalPeriod: "ANNUAL" }, to: { tier: "BASIC", renewalPeriod: "MONTHLY" } },
      { from: { tier: "PRO", renewalPeriod: "ANNUAL" }, to: { tier: "BASIC", renewalPeriod: "ANNUAL" } },
      // Period downgrades
      { from: { tier: "BASIC", renewalPeriod: "ANNUAL" }, to: { tier: "BASIC", renewalPeriod: "MONTHLY" } },
      { from: { tier: "PRO", renewalPeriod: "ANNUAL" }, to: { tier: "PRO", renewalPeriod: "MONTHLY" } }
    ];

    // Check if the requested plan change is valid
    const isValidChange = VALID_PLAN_CHANGES.some(change =>
      change.from.tier === currentTierType &&
      change.from.renewalPeriod === currentRenewalPeriod &&
      change.to.tier === targetTier &&
      change.to.renewalPeriod === targetRenewalPeriod
    );

    if (!isValidChange) {
      // Generate available changes for this user
      const availableChanges = VALID_PLAN_CHANGES
        .filter(change => 
          change.from.tier === currentTierType && 
          change.from.renewalPeriod === currentRenewalPeriod
        )
        .map(change => change.to);

      return NextResponse.json({ 
        error: 'Invalid plan change',
        currentPlan: { tier: currentTierType, renewalPeriod: currentRenewalPeriod },
        targetPlan: { tier: targetTier, renewalPeriod: targetRenewalPeriod },
        availableChanges
      }, { status: 400, headers: corsHeaders });
    }

    // Initialize Razorpay
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_ID!,
      key_secret: process.env.RAZORPAY_SECRET!,
    });

    const paymentMethod = currentTier.billing?.paymentMethod;
    const billingEndDate = currentTier.billing?.subscriptionEndDate || null;

    // Determine change type for better UX messaging
    const changeType = determineChangeType(currentTierType, targetTier, currentRenewalPeriod || null, targetRenewalPeriod);

    // Check payment method and route to appropriate flow
    if (paymentMethod === 'upi') {
      return await handleUPIPlanChange(
        username,
        currentSubscriptionId || '',
        newPlanId,
        newPlanDetails,
        currentTier,
        razorpay,
        billingEndDate,
        changeType,
        corsHeaders
      );
    }

    // Handle users without razorpaySubscriptionId (create new subscription)
    if (!currentSubscriptionId) {
      return await handleNoSubscriptionIdChange(
        username,
        newPlanId,
        newPlanDetails,
        targetTier,
        targetRenewalPeriod,
        currentTierType,
        currentRenewalPeriod || null,
        changeType,
        corsHeaders
      );
    }

    // For card/other payment methods: Use unified plan change flow
    console.log('Processing non-UPI plan change with immediate update');

    return await handleCardPlanChange(
      username,
      currentSubscriptionId,
      newPlanId,
      newPlanDetails,
      currentTier,
      targetTier,
      targetRenewalPeriod,
      currentTierType,
      currentRenewalPeriod || null,
      paymentMethod as string,
      billingEndDate,
      changeType,
      corsHeaders
    );

  } catch (error) {
    console.error('Error processing plan change:', error);
    return NextResponse.json(
      {
        error: 'Failed to process plan change',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Determine the type of change for better UX messaging
function determineChangeType(
  currentTier: string,
  targetTier: string,
  currentPeriod: string | null,
  targetPeriod: string
): 'upgrade' | 'downgrade' | 'period_change' {
  if (currentTier !== targetTier) {
    return currentTier === 'BASIC' && targetTier === 'PRO' ? 'upgrade' : 'downgrade';
  }
  return 'period_change';
}

// Handle card-based plan changes (unified for upgrades/downgrades/period changes)
async function handleCardPlanChange(
  username: string,
  currentSubscriptionId: string,
  newPlanId: string,
  newPlanDetails: any,
  currentTier: any,
  targetTier: string,
  targetRenewalPeriod: string,
  currentTierType: string,
  currentRenewalPeriod: string | null,
  paymentMethod: string,
  billingEndDate: string | null,
  changeType: 'upgrade' | 'downgrade' | 'period_change',
  corsHeaders: any
): Promise<NextResponse> {
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
      const proratedChangeCost = calculateProratedUpgradeCost(
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
        proratedChangeCost,
        billingEndDate,
      };

      console.log('Card plan change prorated calculation:', proratedInfo);
    }

    // Update subscription immediately - Razorpay handles prorating automatically
    const updatedSubscription = await updateRazorpaySubscription(
      currentSubscriptionId,
      newPlanId,
      paymentMethod,
      { renewalPeriod: targetRenewalPeriod, tier: targetTier },
      currentTier
    );

    console.log('Card subscription updated with prorating:', {
      subscriptionId: updatedSubscription.id,
      status: updatedSubscription.status,
      planId: newPlanId,
      changeType,
      proratedInfo
    });

    // Update user tier in database immediately - webhook will handle full update
    console.log('Card plan change completed, webhook will update database with subscription details');

    console.log(`Card ${changeType} completed for user:`, username);

    const changeMessages = {
      upgrade: 'Plan upgrade completed successfully',
      downgrade: 'Plan downgrade completed successfully', 
      period_change: 'Billing period change completed successfully'
    };

    return NextResponse.json({
      success: true,
      message: changeMessages[changeType],
      data: {
        changeInitiated: new Date().toISOString(),
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
        changeType,
        immediateChange: true,
        note: 'Plan change completed. Prorated billing applies.'
      },
    }, {
      status: 200,
      headers: corsHeaders,
    });

  } catch (error) {
    console.error(`Failed to process card ${changeType}:`, error);
    return NextResponse.json(
      {
        error: `Failed to process plan ${changeType}`,
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Simplified UPI plan changes - create new subscription immediately
async function handleUPIPlanChange(
  username: string,
  currentSubscriptionId: string,
  newPlanId: string,
  newPlanDetails: any,
  currentTier: any,
  razorpay: any,
  billingEndDate: string | null,
  changeType: 'upgrade' | 'downgrade' | 'period_change',
  corsHeaders: any
): Promise<NextResponse> {
  try {
    console.log(`Starting simplified UPI ${changeType}`);
    
    // For UPI payments, create new subscription immediately
    const newSubscription = await createRazorpaySubscription({
      planId: newPlanId,
      planDetails: newPlanDetails,
      username,
      razorpayKeyId: process.env.RAZORPAY_ID!,
      razorpayKeySecret: process.env.RAZORPAY_SECRET!,
    });

    console.log('New UPI subscription created:', {
      subscriptionId: newSubscription.id,
      status: newSubscription.status
    });

    // Cancel old subscription
    if (currentSubscriptionId) {
      await razorpay.subscriptions.cancel(currentSubscriptionId);
      console.log('Old subscription cancelled:', currentSubscriptionId);
    }

    const changeMessages = {
      upgrade: `Plan upgrade initiated! Please complete payment setup to activate your ${newPlanDetails.tier} ${newPlanDetails.renewalPeriod.toLowerCase()} plan.`,
      downgrade: `Plan change initiated! Please complete payment setup to activate your ${newPlanDetails.tier} ${newPlanDetails.renewalPeriod.toLowerCase()} plan.`,
      period_change: `Billing period change initiated! Please complete payment setup to activate ${newPlanDetails.renewalPeriod.toLowerCase()} billing.`
    };

    return NextResponse.json({
      success: true,
      message: changeMessages[changeType],
      data: {
        subscriptionId: newSubscription.id,
        status: newSubscription.status,
        planId: newPlanId,
        tier: newPlanDetails.tier,
        renewalPeriod: newPlanDetails.renewalPeriod,
        paymentUrl: newSubscription.short_url,
        paymentMethod: 'upi',
        changeType,
        requiresAuthentication: true
      }
    }, {
      status: 200,
      headers: corsHeaders,
    });

  } catch (error) {
    console.error(`Failed to process UPI ${changeType}:`, error);
    return NextResponse.json(
      {
        error: `Failed to process UPI plan ${changeType}`,
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Handle plan changes for users without razorpaySubscriptionId - create new subscription
async function handleNoSubscriptionIdChange(
  username: string,
  newPlanId: string,
  newPlanDetails: any,
  targetTier: string,
  targetRenewalPeriod: string,
  currentTierType: string,
  currentRenewalPeriod: string | null,
  changeType: 'upgrade' | 'downgrade' | 'period_change',
  corsHeaders: any
): Promise<NextResponse> {
  try {
    console.log('Creating new subscription for user without razorpaySubscriptionId:', {
      username,
      targetTier,
      targetRenewalPeriod,
      newPlanId,
      changeType
    });

    // Create new subscription
    const newSubscription = await createRazorpaySubscription({
      planId: newPlanId,
      planDetails: newPlanDetails,
      username,
      razorpayKeyId: process.env.RAZORPAY_ID!,
      razorpayKeySecret: process.env.RAZORPAY_SECRET!,
    });

    // Don't update database here - let webhook handle it when subscription is activated
    console.log('New subscription created, webhook will update database when activated');

    console.log('New subscription created for plan change:', newSubscription.id);

    const changeMessages = {
      upgrade: 'New subscription created successfully for upgrade',
      downgrade: 'New subscription created successfully for downgrade',
      period_change: 'New subscription created successfully for billing period change'
    };

    return NextResponse.json({
      success: true,
      message: changeMessages[changeType],
      data: {
        changeInitiated: new Date().toISOString(),
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
        changeType,
        immediateChange: true,
        paymentAuthRequired: true,
        paymentUrl: newSubscription.short_url,
        note: 'New subscription created. Please complete payment setup.'
      },
    }, {
      status: 200,
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Failed to create new subscription for plan change:', error);
    return NextResponse.json({
      error: 'Failed to create new subscription for plan change',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500, headers: corsHeaders });
  }
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
    // UPI subscriptions handled by separate flow
    if (currentPaymentMethod === 'upi') {
      throw new Error('UPI subscriptions should create new subscription instead of updating existing');
    }

    // Create basic auth header
    const auth = Buffer.from(`${process.env.RAZORPAY_ID!}:${process.env.RAZORPAY_SECRET!}`).toString('base64');
    
    // Update subscription data - only use parameters Razorpay accepts
    const updateData: any = {
      plan_id: newPlanId,           // New plan (target tier)
      schedule_change_at: "now",    // Critical: immediate effect
      customer_notify: 1            // Send email to customer
    };

    // Add remaining_count for plans with different billing periods
    if (newPlanDetails && currentTier) {
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
            console.error('Razorpay plan change API error', {
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
        console.error('Razorpay plan change request error', { error, subscriptionId, newPlanId });
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

// Helper function to create new subscription
async function createRazorpaySubscription({
  planId,
  planDetails,
  username,
  razorpayKeyId,
  razorpayKeySecret,
  isUpgrade = false,
  oldSubscriptionId,
}: {
  planId: string;
  planDetails: { tier: string; renewalPeriod: string; amount: number };
  username: string;
  razorpayKeyId: string;
  razorpayKeySecret: string;
  isUpgrade?: boolean;
  oldSubscriptionId?: string;
}): Promise<any> {
  const totalCount = planDetails.renewalPeriod === 'MONTHLY' ? 12 : 5;

  const subscriptionData: any = {
    plan_id: planId,
    total_count: totalCount,
    quantity: 1,
    customer_notify: true,
    notes: {
      userId: username,
      tier: planDetails.tier,
      renewalPeriod: planDetails.renewalPeriod,
    },
  };

  // Simplified - no scheduled starts, immediate subscriptions only
  // startAt parameter removed for simplicity

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