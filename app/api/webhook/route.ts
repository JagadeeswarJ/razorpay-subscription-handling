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
    entityType: eventData.payload?.payment ? 'payment' : eventData.payload?.subscription ? 'subscription' : 'unknown',
    entityId: eventData.payload?.payment?.entity?.id || eventData.payload?.subscription?.entity?.id,
    userId: extractUserIdFromPayload(eventData.payload),
    fullPayload: eventData, // Log complete webhook data
  };

  const logString = JSON.stringify(logEntry, null, 2) + '\n' + '---\n';
  fs.appendFileSync(logFile, logString);
  
  // Also log to console for real-time monitoring
  console.log('Webhook Event Logged:', {
    timestamp: logEntry.timestamp,
    event: logEntry.event,
    entityType: logEntry.entityType,
    entityId: logEntry.entityId,
    userId: logEntry.userId
  });
};

// Helper function to extract userId from various payload structures
const extractUserIdFromPayload = (payload: any): string | null => {
  try {
    // Check payment entity
    if (payload?.payment?.entity?.notes?.userId) {
      return payload.payment.entity.notes.userId.replace('USER#', '');
    }
    
    // Check subscription entity
    if (payload?.subscription?.entity?.notes?.userId) {
      return payload.subscription.entity.notes.userId.replace('USER#', '');
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting userId from payload:', error);
    return null;
  }
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

    // Enhanced webhook logging
    console.log('Webhook received:', {
      event: event.event,
      created_at: event.created_at,
      account_id: event.account_id,
      entity: event.entity,
      contains: event.contains,
    });

    // Log the complete webhook data
    logWebhookEvent(event);

    // Handle different webhook events and store to Firebase
    switch (event.event) {
      case 'payment.captured':
        await handlePaymentCaptured(event.payload.payment.entity);
        break;

      case 'payment.failed':
        await handlePaymentFailed(event.payload.payment.entity);
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

      case 'subscription.halted':
        await handleSubscriptionHalted(event.payload.subscription.entity);
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
  if (subscription.notes && subscription.notes.userId) {
    const userId = subscription.notes.userId.replace('USER#', '');
    const isUpgrade = subscription.notes.isUpgrade === 'true';
    
    // Extract payment method from subscription object
    const paymentMethod = subscription.payment_method as 'upi' | 'card' | 'netbanking' | 'wallet' | null;
    
    console.log('UPI mandate authenticated for user:', userId, 'isUpgrade:', isUpgrade, 'payment_method:', paymentMethod);
    
    // If this is an upgrade subscription, cancel the old one immediately
    if (isUpgrade) {
      const currentTier = await getUserTier(userId);
      if (currentTier && currentTier.billing?.newSubscriptionId === subscription.id) {
        console.log('Processing upgrade mandate authentication for user:', userId);
        
        // Cancel old subscription immediately
        if (currentTier.billing?.razorpaySubscriptionId && 
            currentTier.billing.razorpaySubscriptionId !== subscription.id) {
          try {
            const razorpay = new (await import('razorpay')).default({
              key_id: process.env.RAZORPAY_ID!,
              key_secret: process.env.RAZORPAY_SECRET!,
            });
            
            await razorpay.subscriptions.cancel(currentTier.billing.razorpaySubscriptionId, false);
            console.log('Old subscription cancelled during mandate setup:', currentTier.billing.razorpaySubscriptionId);
            
            // Update user tier to reflect the transition
            await updateUserTier(userId, {
              'billing.razorpaySubscriptionId': subscription.id,
              'billing.payment_method': paymentMethod,
              'billing.newSubscriptionId': null,
              'billing.newPlanId': null,
              'billing.upgradeInProgress': false,
              'billing.subscriptionTransitioned': true,
              'billing.transitionedAt': new Date().toISOString(),
              'billing.mandateAuthenticated': true,
              'billing.mandateAuthenticatedAt': new Date().toISOString(),
            });
            
            console.log('Subscription transition completed during mandate authentication for user:', userId);
            return;
          } catch (error) {
            console.error('Failed to cancel old subscription during mandate setup:', error);
          }
        }
      }
    }
    
    // Regular mandate authentication - try to find and update user tier
    try {
      const currentTier = await getUserTier(userId);
      if (currentTier) {
        console.log('Found user tier for payment method update:', currentTier.id);
        await updateUserTier(userId, {
          'billing.payment_method': paymentMethod,
          'billing.mandateAuthenticated': true,
          'billing.mandateAuthenticatedAt': new Date().toISOString(),
        });
        console.log('Payment method updated successfully for user:', userId);
      } else {
        console.error('No user tier found for userId:', userId, '- Cannot update payment method');
        // Don't fail the webhook - the subscription.activated event will create the user tier
      }
    } catch (error) {
      console.error('Error updating payment method for user:', userId, error);
      // Don't fail the webhook - continue processing
    }
  } else {
    console.log('No userId found in subscription notes for subscription:', subscription.id);
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

          // Update existing tier with new subscription details using new structure
          await updateUserTier(userId, {
            tier: planDetails.tier,
            'billing.razorpaySubscriptionId': subscription.id,
            'billing.currentPeriodStart': new Date().toISOString(),
            'billing.currentPeriodEnd': nextBillingDate.toISOString(),
            'billing.renewalPeriod': planDetails.renewalPeriod,
            'billing.payment_method': subscription.payment_method,
            'billing.status': 'ACTIVE',
            'billing.lastPaymentStatus': 'PAID',
            'billing.lastPaymentAt': new Date().toISOString(),
            'billing.upgradeInProgress': false,
            'billing.targetPlanId': null,
            'billing.transitionAt': new Date().toISOString(),
            // Keep legacy fields for backward compatibility
            'billing.subscriptionStartDate': new Date().toISOString(),
            'billing.subscriptionEndDate': nextBillingDate.toISOString(),
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
          currentPeriodStart: new Date().toISOString(),
          currentPeriodEnd: nextBillingDate.toISOString(),
          razorpaySubscriptionId: subscription.id,
          payment_method: subscription.payment_method as 'upi' | 'card' | 'netbanking' | 'wallet' | null,
          status: 'ACTIVE',
          lastPaymentStatus: 'PAID',
          lastPaymentAt: new Date().toISOString(),
          // Keep legacy fields for backward compatibility
          subscriptionStartDate: new Date().toISOString(),
          subscriptionEndDate: nextBillingDate.toISOString(),
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
      'billing.currentPeriodEnd': nextBillingDate.toISOString(),
      'billing.lastPaymentStatus': 'PAID',
      'billing.lastPaymentAt': new Date().toISOString(),
      // Keep legacy field for backward compatibility
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
  
  // Log comprehensive subscription update details
  console.log('Subscription update details:', {
    id: subscription.id,
    plan_id: subscription.plan_id,
    status: subscription.status,
    payment_method: subscription.payment_method,
    current_start: subscription.current_start,
    current_end: subscription.current_end,
    has_scheduled_changes: subscription.has_scheduled_changes,
    change_scheduled_at: subscription.change_scheduled_at,
    notes: subscription.notes,
  });
  
  if (subscription.notes && subscription.notes.userId) {
    const userId = subscription.notes.userId.replace('USER#', '');
    
    // Try to get plan details from the subscription plan_id
    let planDetails = getPlanDetails(subscription.plan_id);
    
    // Fallback to notes planId if subscription plan_id doesn't match our mapping
    if (!planDetails && subscription.notes.planId) {
      planDetails = getPlanDetails(subscription.notes.planId);
    }
    
    if (planDetails) {
      console.log('Processing subscription update for:', userId, {
        fromNotes: subscription.notes.planId,
        fromSubscription: subscription.plan_id,
        resolvedTier: planDetails.tier,
        renewalPeriod: planDetails.renewalPeriod,
      });
      
      // Convert Razorpay timestamps to ISO strings
      const currentPeriodStart = subscription.current_start ? new Date(subscription.current_start * 1000).toISOString() : null;
      const currentPeriodEnd = subscription.current_end ? new Date(subscription.current_end * 1000).toISOString() : null;
      
      console.log('Updating billing dates from subscription.updated:', {
        current_start: subscription.current_start,
        current_end: subscription.current_end,
        currentPeriodStart,
        currentPeriodEnd,
      });
      
      // Update Firebase with new plan details and billing dates
      await updateUserTier(userId, {
        tier: planDetails.tier,
        'billing.renewalPeriod': planDetails.renewalPeriod,
        'billing.currentPeriodStart': currentPeriodStart,
        'billing.currentPeriodEnd': currentPeriodEnd,
        'billing.subscriptionUpdated': true,
        'billing.subscriptionUpdatedAt': new Date().toISOString(),
        'billing.lastWebhookEvent': 'subscription.updated',
        'billing.lastWebhookAt': new Date().toISOString(),
        'billing.payment_method': subscription.payment_method,
        // Update legacy fields as well for backward compatibility
        'billing.subscriptionStartDate': currentPeriodStart,
        'billing.subscriptionEndDate': currentPeriodEnd,
      });
      
      console.log('Subscription update processed successfully for user:', userId, 'new tier:', planDetails.tier);
    } else {
      console.error('No plan details found for subscription update:', {
        userId,
        subscriptionPlanId: subscription.plan_id,
        notesPlanId: subscription.notes.planId,
      });
    }
  } else {
    console.log('No userId found in subscription notes for update:', subscription.id);
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

async function handlePaymentFailed(payment: any) {
  console.log('Payment failed:', payment);
  
  if (payment.notes && payment.notes.userId) {
    const userId = payment.notes.userId.replace('USER#', '');
    // Mark as payment failed but keep grace period
    await updateUserTier(userId, {
      'billing.lastPaymentStatus': 'FAILED',
      'billing.lastPaymentAt': new Date().toISOString(),
      // Keep legacy fields for backward compatibility
      'billing.paymentFailed': true,
      'billing.paymentFailedAt': new Date().toISOString(),
    });
    
    console.log('Payment failure recorded for user:', userId);
  }
}

async function handleSubscriptionHalted(subscription: any) {
  console.log('Subscription halted:', subscription);
  
  if (subscription.notes && subscription.notes.userId) {
    const userId = subscription.notes.userId.replace('USER#', '');
    // Downgrade to free tier when subscription is halted
    await updateUserTier(userId, {
      tier: 'NONE',
      'billing.status': 'HALTED',
      'billing.statusReason': 'Subscription halted due to payment failure',
      'billing.statusChangedAt': new Date().toISOString(),
      'billing.lastPaymentStatus': 'FAILED',
      // Keep legacy fields for backward compatibility
      'billing.subscriptionHalted': true,
      'billing.haltedAt': new Date().toISOString(),
    });
    
    console.log('User downgraded to free tier due to subscription halt:', userId);
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