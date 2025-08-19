import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createUserTier, updateUserTier, cancelUserSubscription } from '@/lib/firebase';
import { getPlanDetails } from '@/lib/billing-config';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';

const logWebhookEvent = (eventData: any) => {
  const logDir = path.join(process.cwd(), 'logs');
  const logFile = path.join(logDir, 'webhook-events.log');

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    event: eventData.event,
    entity: eventData.payload?.payment?.entity || eventData.payload?.subscription?.entity,
    data: eventData,
  };

  const logString = JSON.stringify(logEntry) + '\n';
  fs.appendFileSync(logFile, logString);
};

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

    const event = JSON.parse(body);

    console.log('Webhook received:', {
      event: event.event,
      created_at: event.created_at,
    });

    logWebhookEvent(event);

    // Handle different webhook events and store to Firebase
    switch (event.event) {
      case 'payment.captured':
        await handlePaymentCaptured(event.payload.payment.entity);
        break;

      case 'payment.failed':
        console.log('Payment failed:', event.payload.payment.entity);
        break;

      case 'subscription.activated':
        await handleSubscriptionActivated(event.payload.subscription.entity);
        break;
        
      case 'subscription.updated':
        await handleSubscriptionUpdated(event.payload.subscription.entity);
        break;

      case 'subscription.charged':
        await handleSubscriptionCharged(event.payload.subscription.entity);
        break;

      case 'subscription.cancelled':
        await handleSubscriptionCancelled(event.payload.subscription.entity);
        break;

      case 'subscription.completed':
        await handleSubscriptionCompleted(event.payload.subscription.entity);
        break;

      default:
        console.log('Unhandled webhook event:', event.event);
    }

    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// Handler functions for different webhook events
async function handlePaymentCaptured(payment: any) {
  console.log('Payment captured:', payment);

  // Update user tier with payment details
  if (payment.notes && payment.notes.userId && payment.notes.subscription_id) {
    const userId = payment.notes.userId.replace('USER#', '');
    await updateUserTier(userId, payment.notes.subscription_id, {
      paymentId: payment.id,
      status: 'ACTIVE',
    });
  }
}

async function handleSubscriptionActivated(subscription: any) {
  console.log('Subscription activated:', subscription);

  if (subscription.notes && subscription.notes.userId && subscription.notes.planId) {
    const userId = subscription.notes.userId.replace('USER#', '');
    const planDetails = getPlanDetails(subscription.notes.planId);
    const isUpgrade = subscription.notes.isUpgrade === 'true';

    if (planDetails) {
      // For upgrades, we might want different logic
      if (isUpgrade) {
        console.log('Processing upgrade subscription activation for:', userId);
        
        // Ensure old subscription is marked as cancelled
        await cancelUserSubscription(userId, 'upgrade_completed');
      }
      
      // Calculate next billing date (monthly)
      const nextBillingDate = new Date();
      nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);

      await createUserTier({
        userId,
        tier: planDetails.tier,
        subscriptionId: subscription.id,
        status: 'ACTIVE',
        renewalPeriod: planDetails.renewalPeriod,
        amount: planDetails.amount,
        planId: subscription.notes.planId,
        nextBillingDate: Timestamp.fromDate(nextBillingDate),
      });
      
      console.log(`${isUpgrade ? 'Upgrade' : 'New'} subscription activated for user:`, userId);
    }
  }
}

async function handleSubscriptionCharged(subscription: any) {
  console.log('Subscription charged:', subscription);

  if (subscription.notes && subscription.notes.userId) {
    const userId = subscription.notes.userId.replace('USER#', '');

    // Update next billing date
    const nextBillingDate = new Date();
    nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);

    await updateUserTier(userId, subscription.id, {
      status: 'ACTIVE',
      nextBillingDate: Timestamp.fromDate(nextBillingDate),
    });
  }
}

async function handleSubscriptionCancelled(subscription: any) {
  console.log('Subscription cancelled:', subscription);

  if (subscription.notes && subscription.notes.userId) {
    const userId = subscription.notes.userId.replace('USER#', '');
    await updateUserTier(userId, subscription.id, {
      status: 'CANCELLED',
    });
  }
}

async function handleSubscriptionUpdated(subscription: any) {
  console.log('Subscription updated:', subscription);
  
  if (subscription.notes && subscription.notes.userId && subscription.notes.planId) {
    const userId = subscription.notes.userId.replace('USER#', '');
    const planDetails = getPlanDetails(subscription.notes.planId);
    
    if (planDetails) {
      console.log('Processing subscription update for:', userId);
      
      // Update Firebase with new plan details and clear any pending changes
      await updateUserTier(userId, subscription.id, {
        tier: planDetails.tier,
        planId: subscription.notes.planId,
        amount: planDetails.amount,
        status: 'ACTIVE',
        // Clear pending change fields if they exist
        pendingPlanChange: FieldValue.delete(),
        pendingTier: FieldValue.delete(),
        pendingAmount: FieldValue.delete(),
      });
      
      console.log('Subscription update processed for user:', userId, 'new tier:', planDetails.tier);
    }
  }
}

async function handleSubscriptionCompleted(subscription: any) {
  console.log('Subscription completed:', subscription);

  if (subscription.notes && subscription.notes.userId) {
    const userId = subscription.notes.userId.replace('USER#', '');
    await updateUserTier(userId, subscription.id, {
      status: 'EXPIRED',
    });
  }
}