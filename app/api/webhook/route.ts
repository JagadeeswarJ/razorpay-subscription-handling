import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createUserTier, updateUserTier, cancelUserSubscription, getUserTier } from '@/lib/firebase';
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
        
      case 'refund.created':
        await handleRefundCreated(event.payload.refund.entity);
        break;
        
      case 'refund.processed':
        await handleRefundProcessed(event.payload.refund.entity);
        break;

      case 'subscription.activated':
        await handleSubscriptionActivated(event.payload.subscription.entity);
        break;

      case 'subscription.authenticated':
        await handleSubscriptionAuthenticated(event.payload.subscription.entity);
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

  // Check if this is a prorated upgrade payment
  if (payment.notes && payment.notes.type === 'prorated_upgrade' && payment.notes.username) {
    const username = payment.notes.username;
    const orderId = payment.notes.orderId;
    
    console.log('Prorated upgrade payment captured for user:', username);
    
    // Get current user tier to process the upgrade
    const currentTier = await getUserTier(username);
    if (currentTier?.billing?.upgradeInProgress && currentTier.billing?.proratedOrderId === orderId) {
      await processImmediateUpgrade(username, currentTier);
    }
    return;
  }

  // Handle regular subscription payments
  if (payment.notes && payment.notes.userId && payment.notes.subscription_id) {
    const userId = payment.notes.userId.replace('USER#', '');
    await updateUserTier(userId, {
      'billing.razorpaySubscriptionId': payment.notes.subscription_id,
      tier: 'BASIC' // Will be updated by subscription.activated event
    });
  }
}

async function handleSubscriptionAuthenticated(subscription: any) {
  console.log('Subscription authenticated (UPI mandate created):', subscription);
  
  // This event is fired when UPI mandate is successfully created
  // We can use this to track when the mandate is ready for billing
  if (subscription.notes && subscription.notes.userId) {
    const userId = subscription.notes.userId.replace('USER#', '');
    console.log('UPI mandate authenticated for user:', userId);
    
    // Optionally update user tier with mandate status
    await updateUserTier(userId, {
      'billing.mandateAuthenticated': true,
      'billing.mandateAuthenticatedAt': new Date().toISOString(),
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
      // For upgrades, handle the transition differently
      if (isUpgrade) {
        console.log('Processing upgrade subscription activation for:', userId);
        
        // Get current user tier to update existing record
        const currentTier = await getUserTier(userId);
        if (currentTier && currentTier.billing?.newSubscriptionId === subscription.id) {
          // This is the new subscription being activated - update existing tier record
          const nextBillingDate = new Date();
          if (planDetails.renewalPeriod === 'ANNUAL') {
            nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
          } else {
            nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
          }

          // Cancel old subscription first
          if (currentTier.billing?.razorpaySubscriptionId && 
              currentTier.billing.razorpaySubscriptionId !== subscription.id) {
            try {
              const razorpay = new (await import('razorpay')).default({
                key_id: process.env.RAZORPAY_ID!,
                key_secret: process.env.RAZORPAY_SECRET!,
              });
              await razorpay.subscriptions.cancel(currentTier.billing.razorpaySubscriptionId, true);
              console.log('Old subscription cancelled:', currentTier.billing.razorpaySubscriptionId);
            } catch (error) {
              console.error('Failed to cancel old subscription:', error);
            }
          }

          // Update existing tier with new subscription details
          await updateUserTier(userId, {
            tier: planDetails.tier,
            'billing.razorpaySubscriptionId': subscription.id,
            'billing.subscriptionStartDate': new Date().toISOString(),
            'billing.subscriptionEndDate': nextBillingDate.toISOString(),
            'billing.renewalPeriod': planDetails.renewalPeriod,
            'billing.upgradeInProgress': false,
            'billing.newSubscriptionId': null,
            'billing.newPlanId': null,
            'billing.subscriptionTransitioned': true,
            'billing.transitionedAt': new Date().toISOString(),
          });
          
          console.log(`Upgrade subscription activated and transitioned for user:`, userId);
          return;
        }
      }
      
      // Handle new subscription (not upgrade)
      const nextBillingDate = new Date();
      if (planDetails.renewalPeriod === 'ANNUAL') {
        nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
      } else {
        nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
      }

      await createUserTier({
        entityType: "Tier",
        userId,
        tier: planDetails.tier,
        billing: {
          renewalPeriod: planDetails.renewalPeriod,
          trialStartDate: null,
          trialEndDate: null,
          subscriptionStartDate: new Date().toISOString(),
          subscriptionEndDate: nextBillingDate.toISOString(),
          razorpaySubscriptionId: subscription.id,
        },
      });
      
      console.log(`New subscription activated for user:`, userId);
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

    await updateUserTier(userId, {
      'billing.subscriptionEndDate': nextBillingDate.toISOString(),
    });
  }
}

async function handleSubscriptionCancelled(subscription: any) {
  console.log('Subscription cancelled:', subscription);

  if (subscription.notes && subscription.notes.userId) {
    const userId = subscription.notes.userId.replace('USER#', '');
    await updateUserTier(userId, {
      'billing.razorpaySubscriptionId': FieldValue.delete(),
      'billing.subscriptionEndDate': FieldValue.delete(),
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
      await updateUserTier(userId, {
        tier: planDetails.tier,
        'billing.renewalPeriod': planDetails.renewalPeriod,
      });
      
      console.log('Subscription update processed for user:', userId, 'new tier:', planDetails.tier);
    }
  }
}

async function handleRefundCreated(refund: any) {
  console.log('Refund created:', refund);
  
  // Log refund creation for audit trail
  if (refund.notes && refund.notes.subscription_id) {
    console.log('Refund created for subscription plan change:', {
      refundId: refund.id,
      amount: refund.amount,
      reason: refund.notes.reason,
      subscriptionId: refund.notes.subscription_id,
      status: refund.status,
    });
  }
}

async function handleRefundProcessed(refund: any) {
  console.log('Refund processed successfully:', refund);
  
  // Update any relevant records if needed
  if (refund.notes && refund.notes.subscription_id) {
    console.log('Refund processed for subscription plan change:', {
      refundId: refund.id,
      amount: refund.amount,
      status: refund.status,
      processedAt: new Date().toISOString(),
    });
  }
}

async function handleSubscriptionCompleted(subscription: any) {
  console.log('Subscription completed:', subscription);

  if (subscription.notes && subscription.notes.userId) {
    const userId = subscription.notes.userId.replace('USER#', '');
    await updateUserTier(userId, {
      'billing.razorpaySubscriptionId': FieldValue.delete(),
      'billing.subscriptionEndDate': FieldValue.delete(),
      tier: 'NONE',
    });
  }
}

// Process immediate upgrade after prorated payment
async function processImmediateUpgrade(username: string, currentTier: any) {
  try {
    console.log('Processing immediate upgrade for user:', username);
    
    const newPlanId = currentTier.billing?.newPlanId;
    if (!newPlanId) {
      console.error('No new plan ID found for upgrade');
      return;
    }

    // Get new plan details
    const newPlanDetails = getPlanDetails(newPlanId);
    if (!newPlanDetails) {
      console.error('Invalid new plan ID:', newPlanId);
      return;
    }

    // Update user tier immediately with new plan details
    const updates = {
      tier: newPlanDetails.tier,
      'billing.upgradeInProgress': false,
      'billing.proratedPaid': true,
      'billing.proratedPaidAt': new Date().toISOString(),
      // Keep the current subscription active until next billing cycle
      // The new subscription (newSubscriptionId) will take over then
    };

    await updateUserTier(username, updates);

    console.log(`Immediate upgrade completed for user ${username} to tier ${newPlanDetails.tier}`);

  } catch (error) {
    console.error('Error processing immediate upgrade:', error);
  }
}