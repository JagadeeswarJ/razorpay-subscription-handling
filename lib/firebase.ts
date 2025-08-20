import { initializeApp, getApps, App } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { credential } from 'firebase-admin';

let app: App;

if (getApps().length === 0) {
  app = initializeApp({
    credential: credential.cert({
      projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
      clientEmail: process.env.GOOGLE_CLOUD_CLIENT_EMAIL,
      privateKey: process.env.GOOGLE_CLOUD_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
    projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
  });
} else {
  app = getApps()[0];
}

export const db = getFirestore(app);

export interface UserTierInfo {
  username: string;
  hasSubscription: boolean;

  tierEntity?: {
    tier: "NONE" | "BASIC" | "PRO" | "TRIAL";

    billing?: {
      renewalPeriod: "MONTHLY" | "ANNUAL" | null;

      // Lifecycle dates
      currentPeriodStart: string | null;   // e.g. 2025-08-01
      currentPeriodEnd: string | null;     // e.g. 2025-08-31

      // Razorpay identifiers
      razorpaySubscriptionId?: string;
      razorpayCustomerId?: string;

      // Payment state
      lastPaymentStatus?: "PAID" | "FAILED" | "PENDING";
      lastPaymentAt?: string | null;

      // Cancellation / Halt
      status?: "ACTIVE" | "HALTED" | "CANCELLED";
      statusReason?: string | null;
      statusChangedAt?: string | null;

      // Upgrade/Downgrade
      upgradeInProgress?: boolean;
      targetPlanId?: string | null;
      transitionAt?: string | null;
    };

    createdAt: string;
    updatedAt: string;
  };
}

// Legacy interface for backward compatibility during transition
export interface TierEntity {
  entityType: "Tier";
  userId: string;
  tier: "NONE" | "BASIC" | "PRO" | "TRIAL";
  billing?: {
    renewalPeriod: "MONTHLY" | "ANNUAL" | null;
    currentPeriodStart?: string | null;
    currentPeriodEnd?: string | null;
    razorpaySubscriptionId?: string;
    razorpayCustomerId?: string;
    lastPaymentStatus?: "PAID" | "FAILED" | "PENDING";
    lastPaymentAt?: string | null;
    status?: "ACTIVE" | "HALTED" | "CANCELLED";
    statusReason?: string | null;
    statusChangedAt?: string | null;
    upgradeInProgress?: boolean;
    targetPlanId?: string | null;
    transitionAt?: string | null;
    // Legacy fields for migration
    subscriptionStartDate?: string | null;
    subscriptionEndDate?: string | null;
    isConfirmationSent?: boolean;
    isCancelled?: boolean;
    cancellationReason?: string;
    cancelledAt?: string;
    newPlanId?: string;
    newSubscriptionId?: string;
    proratedAmount?: number;
    proratedOrderId?: string;
    proratedPaid?: boolean;
    proratedPaidAt?: string;
    subscriptionTransitioned?: boolean;
    transitionedAt?: string;
    mandateAuthenticated?: boolean;
    mandateAuthenticatedAt?: string;
    paymentFailed?: boolean;
    paymentFailedAt?: string;
    subscriptionHalted?: boolean;
    haltedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export const createUserTier = async (data: Omit<TierEntity, 'createdAt' | 'updatedAt'>) => {
  const now = new Date().toISOString();
  const tierData: TierEntity = {
    ...data,
    createdAt: now,
    updatedAt: now,
  };

  const docRef = await db.collection('tier').add(tierData);
  console.log('User tier created with ID:', docRef.id);
  return docRef.id;
};

export const updateUserTier = async (
  userId: string, 
  updates: Partial<TierEntity> | Record<string, any>
) => {
  const now = new Date().toISOString();
  const updatedData = {
    ...updates,
    updatedAt: now,
  };

  // Get user tier document (should be only one per user)
  const querySnapshot = await db.collection('tier')
    .where('userId', '==', userId)
    .get();

  if (querySnapshot.empty) {
    console.error('No user tier found for userId:', userId);
    return null;
  }

  const docId = querySnapshot.docs[0].id;
  await db.collection('tier').doc(docId).update(updatedData);
  console.log('User tier updated for docId:', docId);
  return docId;
};

export const getUserTier = async (userId: string) => {
  const querySnapshot = await db.collection('tier')
    .where('userId', '==', userId)
    .get();

  if (querySnapshot.empty) {
    return null;
  }

  // Return the user's tier (should be only one per user)
  return {
    id: querySnapshot.docs[0].id,
    ...querySnapshot.docs[0].data()
  } as TierEntity & { id: string };
};

export const cancelUserSubscription = async (userId: string, reason: string = 'cancelled') => {
  try {
    const querySnapshot = await db.collection('tier')
      .where('userId', '==', userId)
      .get();

    if (!querySnapshot.empty) {
      const docId = querySnapshot.docs[0].id;
      const tierData = querySnapshot.docs[0].data() as TierEntity;
      
      // Update with new structure
      await db.collection('tier').doc(docId).update({
        'billing.status': 'CANCELLED',
        'billing.statusReason': reason,
        'billing.statusChangedAt': new Date().toISOString(),
        // Keep legacy fields for backward compatibility
        'billing.cancellationReason': reason,
        'billing.cancelledAt': new Date().toISOString(),
        'billing.isCancelled': true,
        updatedAt: new Date().toISOString(),
      });
      
      console.log('Marked subscription as cancelled for user:', userId, 'reason:', reason);
      return tierData;
    }
  } catch (error) {
    console.error('Error cancelling user subscription:', error);
  }
  
  return null;
};

// New function to get user tier info in the preferred format
export const getUserBilling = async (userId: string): Promise<UserTierInfo | null> => {
  try {
    const querySnapshot = await db.collection('tier')
      .where('userId', '==', userId)
      .get();

    if (querySnapshot.empty) {
      return {
        username: userId,
        hasSubscription: false,
      };
    }

    const tierDoc = querySnapshot.docs[0];
    const tierData = tierDoc.data() as TierEntity;

    // Transform legacy data to new structure
    const userTierInfo: UserTierInfo = {
      username: userId,
      hasSubscription: Boolean(tierData.billing?.razorpaySubscriptionId),
      tierEntity: {
        tier: tierData.tier,
        billing: tierData.billing ? {
          renewalPeriod: tierData.billing.renewalPeriod,
          
          // Map legacy dates to new structure
          currentPeriodStart: tierData.billing.subscriptionStartDate || tierData.billing.currentPeriodStart || null,
          currentPeriodEnd: tierData.billing.subscriptionEndDate || tierData.billing.currentPeriodEnd || null,
          
          razorpaySubscriptionId: tierData.billing.razorpaySubscriptionId,
          razorpayCustomerId: tierData.billing.razorpayCustomerId,
          
          // Map payment status
          lastPaymentStatus: tierData.billing.paymentFailed 
            ? "FAILED" 
            : tierData.billing.lastPaymentStatus || "PAID",
          lastPaymentAt: tierData.billing.lastPaymentAt || null,
          
          // Map subscription status
          status: tierData.billing.subscriptionHalted 
            ? "HALTED" 
            : tierData.billing.isCancelled 
              ? "CANCELLED" 
              : tierData.billing.status || "ACTIVE",
          statusReason: tierData.billing.statusReason || tierData.billing.cancellationReason || null,
          statusChangedAt: tierData.billing.statusChangedAt || tierData.billing.cancelledAt || tierData.billing.haltedAt || null,
          
          // Upgrade/Downgrade info
          upgradeInProgress: tierData.billing.upgradeInProgress,
          targetPlanId: tierData.billing.newPlanId || tierData.billing.targetPlanId || null,
          transitionAt: tierData.billing.transitionedAt || tierData.billing.transitionAt || null,
        } : undefined,
        createdAt: tierData.createdAt,
        updatedAt: tierData.updatedAt,
      }
    };

    return userTierInfo;
  } catch (error) {
    console.error('Error getting user billing:', error);
    return null;
  }
};

