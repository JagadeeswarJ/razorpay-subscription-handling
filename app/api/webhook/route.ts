import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { updateUserTier, getTierById } from '@/lib/firebase';
import { getPlanDetails } from '@/lib/billing-config';
import { BillingInfo } from '@/lib/firebase';

interface RazorpayWebhookEvent {
  entity: string;
  account_id: string;
  event: string;
  contains: string[];
  payload: {
    subscription: {
      entity: {
        id: string;
        entity: string;
        plan_id: string;
        customer_id?: string;
        status: string;
        current_start: number;
        current_end: number;
        ended_at?: number;
        quantity: number;
        notes: {
          userId?: string;
          tier?: string;
          renewalPeriod?: string;
        };
        charge_at: number;
        start_at: number;
        end_at?: number;
        auth_attempts: number;
        total_count: number;
        paid_count: number;
        customer_notify: boolean;
        created_at: number;
        expire_by?: number;
        short_url: string;
        has_scheduled_changes: boolean;
        change_scheduled_at?: number;
        remaining_count: number;
        payment_method?: string; // Payment method used (upi, card, netbanking, wallet, etc.)
      };
    };
  };
  created_at: number;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const signature = request.headers.get('x-razorpay-signature');

    if (!signature) {
      return NextResponse.json(
        { error: 'Missing signature' },
        { status: 400 }
      );
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!)
      .update(body)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.error('Webhook signature verification failed');
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 400 }
      );
    }

    if (!body) {
      console.error('No body in webhook request');
      return NextResponse.json({ 
        status: 'ignored', 
        message: 'No body provided' 
      });
    }

    // Parse webhook payload with error handling
    let webhookData: RazorpayWebhookEvent;
    try {
      webhookData = JSON.parse(body);
    } catch (parseError) {
      console.error('Failed to parse webhook JSON payload', { 
        error: parseError instanceof Error ? parseError.message : 'Unknown parse error',
        bodyPreview: body?.substring(0, 200)
      });
      return NextResponse.json({ 
        status: 'ignored', 
        message: 'Invalid JSON payload' 
      });
    }

    const { event: eventType, payload } = webhookData;
    
    // Validate payload structure
    if (!payload?.subscription?.entity) {
      console.error('Invalid webhook payload structure - missing subscription entity', { 
        eventType,
        hasPayload: !!payload,
        hasSubscription: !!payload?.subscription,
        hasEntity: !!payload?.subscription?.entity
      });
      return NextResponse.json({ 
        status: 'ignored', 
        message: 'Invalid payload structure' 
      });
    }
    
    const subscription = payload.subscription.entity;

    console.log('Processing Razorpay event', {
      eventType,
      subscriptionId: subscription.id,
      planId: subscription.plan_id,
      status: subscription.status
    });

    // Extract user ID from subscription notes
    let userId = subscription.notes?.userId;
    if (!userId) {
      console.error('No userId found in subscription notes', { subscriptionId: subscription.id });
      return NextResponse.json({ 
        status: 'success', 
        message: 'No userId in subscription notes' 
      });
    }
    
    // Remove USER# prefix if it exists in the notes (clean the userId)
    if (userId.startsWith('USER#')) {
      userId = userId.replace('USER#', '');
    }
    
    console.log('Cleaned userId for processing', { originalUserId: subscription.notes?.userId, cleanedUserId: userId });

    // Get plan details
    const planDetails = getPlanDetails(subscription.plan_id);
    if (!planDetails) {
      console.error('Unknown plan ID', { planId: subscription.plan_id });
      return NextResponse.json({ 
        status: 'success', 
        message: 'Unknown plan ID' 
      });
    }

    // Handle different subscription events
    switch (eventType) {
      case 'subscription.activated':
        // Subscription activated - send confirmation message (first event when subscription starts)
        await handleSubscriptionActivated(userId, subscription, planDetails);
        break;
        
      case 'subscription.completed':
      case 'subscription.charged':
      case 'subscription.authenticated':
      case 'subscription.resumed':
        // Subscription status updated but don't send confirmation message
        await handleSubscriptionActivatedSilent(userId, subscription, planDetails);
        break;
        
      case 'subscription.cancelled':
        // Subscription cancelled
        await handleSubscriptionCancelled(userId, subscription);
        break;
        
      case 'subscription.updated':
        // Subscription updated (plan change, etc.)
        await handleSubscriptionUpdated(userId, subscription, planDetails);
        break;
        
      case 'subscription.pending':
        // Payment pending - don't change user status yet
        console.log('Subscription payment pending', { userId, subscriptionId: subscription.id });
        break;
        
      default:
        console.log('Unhandled webhook event', { eventType });
    }

    return NextResponse.json({ 
      status: 'success',
      message: 'Webhook processed successfully'
    });

  } catch (error) {
    console.error('Error processing Razorpay webhook', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return NextResponse.json({ 
      status: 'error',
      message: 'Webhook processing failed but acknowledged',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
}

// Handle subscription activation/payment success with confirmation message
const handleSubscriptionActivated = async (
  userId: string, 
  subscription: any, 
  planDetails: { tier: "BASIC" | "PRO", renewalPeriod: "MONTHLY" | "ANNUAL" }
) => {
  // Check if confirmation was already sent BEFORE updating subscription status
  const existingTier = await getTierById(userId);
  const isConfirmationAlreadySent = existingTier?.billing?.isConfirmationSent === true;
  
  console.log('Subscription activation check', {
    userId,
    subscriptionId: subscription.id,
    isConfirmationAlreadySent
  });
  
  // Update subscription status while preserving confirmation flag
  await updateSubscriptionStatus(userId, subscription, planDetails);

  // Send confirmation message only if not already sent
  if (!isConfirmationAlreadySent) {
    try {
      // Here you would send confirmation message
      console.log('Would send subscription confirmation message', { userId, tier: planDetails.tier });
      
      // Set confirmation flag after successful message delivery
      const existingTierUpdated = await getTierById(userId);
      if (existingTierUpdated) {
        const updatedBilling: BillingInfo = {
          renewalPeriod: existingTierUpdated.billing?.renewalPeriod || null,
          trialStartDate: existingTierUpdated.billing?.trialStartDate || null,
          trialEndDate: existingTierUpdated.billing?.trialEndDate || null,
          subscriptionStartDate: existingTierUpdated.billing?.subscriptionStartDate || null,
          subscriptionEndDate: existingTierUpdated.billing?.subscriptionEndDate || null,
          razorpaySubscriptionId: existingTierUpdated.billing?.razorpaySubscriptionId,
          razorpayCustomerId: existingTierUpdated.billing?.razorpayCustomerId,
          paymentMethod: existingTierUpdated.billing?.paymentMethod,
          isCancelled: existingTierUpdated.billing?.isCancelled,
          cancellationDate: existingTierUpdated.billing?.cancellationDate,
          isConfirmationSent: true
        };
        await updateUserTier(userId, existingTierUpdated.tier, updatedBilling);
      }
      
      console.log('Subscription confirmation message sent and flag updated', { userId, tier: planDetails.tier });
    } catch (notificationError) {
      console.error('Failed to send confirmation message but continuing processing', {
        error: notificationError instanceof Error ? notificationError.message : 'Unknown notification error',
        userId,
        tier: planDetails.tier
      });
      // Don't throw - continue with subscription activation
    }
  } else {
    console.log('Confirmation message already sent, skipping duplicate', { userId, tier: planDetails.tier });
  }

  console.log('User subscription activated successfully', { userId, tier: planDetails.tier });
};

// Handle subscription updates without sending confirmation message
const handleSubscriptionActivatedSilent = async (
  userId: string, 
  subscription: any, 
  planDetails: { tier: "BASIC" | "PRO", renewalPeriod: "MONTHLY" | "ANNUAL" }
) => {
  await updateSubscriptionStatus(userId, subscription, planDetails);
  console.log('User subscription status updated silently', { userId, tier: planDetails.tier, subscriptionId: subscription.id });
};

// Common subscription status update logic
const updateSubscriptionStatus = async (
  userId: string, 
  subscription: any, 
  planDetails: { tier: "BASIC" | "PRO", renewalPeriod: "MONTHLY" | "ANNUAL" }
) => {
  const subscriptionStartDate = new Date(subscription.current_start * 1000).toISOString();
  const subscriptionEndDate = new Date(subscription.current_end * 1000).toISOString();

  console.log('Updating subscription status', {
    userId,
    tier: planDetails.tier,
    renewalPeriod: planDetails.renewalPeriod,
    subscriptionId: subscription.id,
    startDate: subscriptionStartDate,
    endDate: subscriptionEndDate,
    paymentMethod: subscription.payment_method
  });
  
  // Always preserve existing isConfirmationSent flag
  const existingTier = await getTierById(userId);
  const existingIsConfirmationSent = existingTier?.billing?.isConfirmationSent;
  
  const billing: BillingInfo = {
    renewalPeriod: planDetails.renewalPeriod,
    subscriptionStartDate,
    subscriptionEndDate,
    razorpaySubscriptionId: subscription.id,
    razorpayCustomerId: subscription.customer_id,
    paymentMethod: subscription.payment_method, // Store payment method from Razorpay
    // Clear trial dates since user is now on paid plan
    trialStartDate: null,
    trialEndDate: null,
    // Clear cancellation fields since user is resubscribing
    isCancelled: false,
    cancellationDate: undefined,
    // Always preserve existing isConfirmationSent flag
    ...(existingIsConfirmationSent !== undefined && { isConfirmationSent: existingIsConfirmationSent })
  };

  await updateUserTier(userId, planDetails.tier, billing);
};

// Handle subscription cancellation - Simple version
const handleSubscriptionCancelled = async (userId: string, subscription: any) => {
  console.log('Processing subscription cancellation', { userId, subscriptionId: subscription.id });
  
  // Get existing tier to preserve subscription end date
  const existingTier = await getTierById(userId);
  if (!existingTier) {
    console.error('No existing tier found for cancelled subscription', { userId, subscriptionId: subscription.id });
    // Don't throw error - just log and continue to prevent webhook failure
    return;
  }

  const currentTimestamp = new Date().toISOString();
  
  // Check if subscription has actually ended (immediate) or just cancelled (grace period)
  const hasEnded = subscription.ended_at && subscription.ended_at <= Math.floor(Date.now() / 1000);
  
  if (hasEnded) {
    // Subscription ended - user loses access now
    console.log('Subscription ended - removing access', { userId, subscriptionId: subscription.id });
    
    const billing: BillingInfo = {
      renewalPeriod: null,
      subscriptionStartDate: null,
      subscriptionEndDate: null,
      razorpaySubscriptionId: undefined,
      razorpayCustomerId: existingTier.billing?.razorpayCustomerId,
      paymentMethod: existingTier.billing?.paymentMethod, // Preserve payment method for historical data
      trialStartDate: null,
      trialEndDate: null,
      isConfirmationSent: false,
      isCancelled: true,
      cancellationDate: currentTimestamp,
    };

    await updateUserTier(userId, 'NONE', billing);
    
  } else {
    // Subscription cancelled but still active - keep access until end date
    console.log('Subscription cancelled - keeping access until billing period ends', { 
      userId, 
      subscriptionId: subscription.id,
      subscriptionEndDate: existingTier.billing?.subscriptionEndDate 
    });

    const updatedBilling: BillingInfo = {
      renewalPeriod: existingTier.billing?.renewalPeriod || null,
      trialStartDate: existingTier.billing?.trialStartDate || null,
      trialEndDate: existingTier.billing?.trialEndDate || null,
      subscriptionStartDate: existingTier.billing?.subscriptionStartDate || null,
      subscriptionEndDate: existingTier.billing?.subscriptionEndDate || null,
      razorpayCustomerId: existingTier.billing?.razorpayCustomerId,
      paymentMethod: existingTier.billing?.paymentMethod,
      isConfirmationSent: existingTier.billing?.isConfirmationSent,
      isCancelled: true,
      cancellationDate: currentTimestamp,
      razorpaySubscriptionId: undefined, // Clear since it's cancelled
    };

    // Keep current tier until subscription end date
    await updateUserTier(userId, existingTier.tier, updatedBilling);
  }

  console.log('Subscription cancellation processed successfully', { userId });
};

// Handle subscription updates (plan changes)
const handleSubscriptionUpdated = async (
  userId: string, 
  subscription: any, 
  planDetails: { tier: "BASIC" | "PRO", renewalPeriod: "MONTHLY" | "ANNUAL" }
) => {
  console.log('Updating subscription', {
    userId,
    subscriptionId: subscription.id,
    newTier: planDetails.tier,
    newRenewalPeriod: planDetails.renewalPeriod
  });

  await updateSubscriptionStatus(userId, subscription, planDetails);

  console.log('User subscription updated successfully', { userId, newTier: planDetails.tier });
};