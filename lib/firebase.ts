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

export interface TierEntity {
  entityType: "Tier";
  userId: string;
  tier: "NONE" | "BASIC" | "PRO" | "TRIAL";
  billing?: {
    renewalPeriod: "MONTHLY" | "ANNUAL" | null;
    trialStartDate: string | null;
    trialEndDate: string | null;
    subscriptionStartDate: string | null;
    subscriptionEndDate: string | null;
    razorpaySubscriptionId?: string;
    razorpayCustomerId?: string;
    isConfirmationSent?: boolean;
    isCancelled?: boolean;
    cancellationReason?: string;
    cancelledAt?: string;
    upgradeInProgress?: boolean;
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
  createdAt: string; // UTC ISO
  updatedAt: string; // UTC ISO
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
      
      // Mark as cancelled but keep subscription end date so user can use until expiry
      await db.collection('tier').doc(docId).update({
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

