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

export interface BillingInfo {
  renewalPeriod: "MONTHLY" | "ANNUAL" | null;
  trialStartDate: string | null; // UTC ISO - when 7-day trial started
  trialEndDate: string | null; // UTC ISO - when 7-day trial ends
  subscriptionStartDate: string | null; // UTC ISO - when paid subscription started
  subscriptionEndDate: string | null; // UTC ISO - when subscription expires
  razorpaySubscriptionId?: string | null; // Razorpay subscription ID for management
  razorpayCustomerId?: string; // Razorpay customer ID
  paymentMethod?: string; // Payment method used (upi, card, netbanking, wallet, etc.)
  isConfirmationSent?: boolean; // Track if subscription confirmation message was sent
  // Simple cancellation support
  isCancelled?: boolean; // Whether subscription is cancelled but still active
  cancellationDate?: string | null; // When subscription was cancelled
}

export interface TierEntity {
  PK: string; // USER#{userId}
  SK: string; // TIER
  entityType: "Tier";
  userId: string;
  tier: "NONE" | "BASIC" | "PRO" | "TRIAL";
  expiryTTL?: number; // Unix timestamp for DynamoDB TTL (only for TRIAL)
  billing?: BillingInfo;
  createdAt: string; // UTC ISO
  updatedAt: string; // UTC ISO
}

export interface UserTierInfo {
  username: string;
  hasSubscription: boolean;
  tierEntity?: {
    tier: "NONE" | "BASIC" | "PRO" | "TRIAL";
    billing?: BillingInfo;
    updatedAt: string;
  };
}

export const createUserTier = async (data: Omit<TierEntity, 'updatedAt' | 'createdAt'>) => {
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

// Update user tier - matches webhook pattern
export const updateUserTier = async (
  userId: string, 
  tier: "NONE" | "BASIC" | "PRO" | "TRIAL",
  billing?: BillingInfo
) => {
  const now = new Date().toISOString();

  // Get user tier document (should be only one per user)
  const querySnapshot = await db.collection('tier')
    .where('PK', '==', `USER#${userId}`)
    .where('SK', '==', 'TIER')
    .get();

  if (querySnapshot.empty) {
    console.error('No user tier found for userId:', userId);
    return null;
  }

  const docId = querySnapshot.docs[0].id;
  const updatedData: Partial<TierEntity> = {
    tier,
    ...(billing && { billing }),
    updatedAt: now,
  };

  await db.collection('tier').doc(docId).update(updatedData);
  console.log('User tier updated for docId:', docId);
  return docId;
};

// Generic update function for backward compatibility
export const updateUserTierGeneric = async (
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
    .where('PK', '==', `USER#${userId}`)
    .where('SK', '==', 'TIER')
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
    .where('PK', '==', `USER#${userId}`)
    .where('SK', '==', 'TIER')
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

// Alias for webhook compatibility  
export const getTierById = async (userId: string) => {
  return await getUserTier(userId);
};

export const cancelUserSubscription = async (userId: string, reason: string = 'cancelled') => {
  try {
    const querySnapshot = await db.collection('tier')
      .where('PK', '==', `USER#${userId}`)
      .where('SK', '==', 'TIER')
      .get();

    if (!querySnapshot.empty) {
      const docId = querySnapshot.docs[0].id;
      const tierData = querySnapshot.docs[0].data() as TierEntity;
      
      // Update with simplified structure
      await db.collection('tier').doc(docId).update({
        'billing.isCancelled': true,
        'billing.cancellationDate': new Date().toISOString(),
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

// Get user tier info in the simplified format
export const getUserBilling = async (userId: string): Promise<UserTierInfo | null> => {
  try {
    const querySnapshot = await db.collection('tier')
      .where('PK', '==', `USER#${userId}`)
      .where('SK', '==', 'TIER')
      .get();

    if (querySnapshot.empty) {
      return {
        username: userId,
        hasSubscription: false,
      };
    }

    const tierDoc = querySnapshot.docs[0];
    const tierData = tierDoc.data() as TierEntity;

    // Determine if user has active subscription
    const hasActiveSubscription = Boolean(
      tierData.billing && 
      tierData.billing.razorpaySubscriptionId &&
      !tierData.billing.isCancelled &&
      (tierData.tier === 'BASIC' || tierData.tier === 'PRO')
    );

    const userTierInfo: UserTierInfo = {
      username: userId,
      hasSubscription: hasActiveSubscription,
      tierEntity: {
        tier: tierData.tier,
        billing: tierData.billing ? {
          cancellationDate: tierData.billing.cancellationDate,
          isCancelled: tierData.billing.isCancelled,
          isConfirmationSent: tierData.billing.isConfirmationSent,
          paymentMethod: tierData.billing.paymentMethod,
          razorpayCustomerId: tierData.billing.razorpayCustomerId,
          razorpaySubscriptionId: tierData.billing.razorpaySubscriptionId,
          renewalPeriod: tierData.billing.renewalPeriod,
          subscriptionEndDate: tierData.billing.subscriptionEndDate,
          subscriptionStartDate: tierData.billing.subscriptionStartDate,
          trialEndDate: tierData.billing.trialEndDate,
          trialStartDate: tierData.billing.trialStartDate,
        } : undefined,
        updatedAt: tierData.updatedAt,
      }
    };

    return userTierInfo;
  } catch (error) {
    console.error('Error getting user billing:', error);
    return null;
  }
};

