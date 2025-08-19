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

export interface UserTier {
  userId: string;
  tier: 'BASIC' | 'PRO';
  subscriptionId: string;
  status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
  renewalPeriod: 'MONTHLY';
  amount: number;
  planId: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  nextBillingDate?: Timestamp;
  paymentId?: string;
  paymentSignature?: string;
  // For pending downgrades
  pendingPlanChange?: string | null;
  pendingTier?: 'BASIC' | 'PRO' | null;
  pendingAmount?: number | null;
}

export const createUserTier = async (data: Omit<UserTier, 'createdAt' | 'updatedAt'>) => {
  const now = new Date();
  const tierData: UserTier = {
    ...data,
    createdAt: Timestamp.fromDate(now),
    updatedAt: Timestamp.fromDate(now),
  };

  const docRef = await db.collection('tier').add(tierData);
  console.log('User tier created with ID:', docRef.id);
  return docRef.id;
};

export const updateUserTier = async (
  userId: string, 
  subscriptionId: string,
  updates: Partial<UserTier> | Record<string, any>
) => {
  const now = new Date();
  const updatedData = {
    ...updates,
    updatedAt: Timestamp.fromDate(now),
  };

  // First get all user documents, then filter in memory
  const querySnapshot = await db.collection('tier')
    .where('userId', '==', userId)
    .get();

  if (querySnapshot.empty) {
    console.error('No user tier found for userId:', userId);
    return null;
  }

  // Find the document with matching subscriptionId in memory
  const matchingDoc = querySnapshot.docs.find(doc => doc.data().subscriptionId === subscriptionId);
  
  if (!matchingDoc) {
    console.error('No user tier found for subscriptionId:', subscriptionId);
    return null;
  }

  const docId = matchingDoc.id;
  await db.collection('tier').doc(docId).update(updatedData);
  console.log('User tier updated for docId:', docId);
  return docId;
};

export const getUserTier = async (userId: string) => {
  // First get all user subscriptions
  const querySnapshot = await db.collection('tier')
    .where('userId', '==', userId)
    .get();

  if (querySnapshot.empty) {
    return null;
  }

  // Filter and sort in memory to avoid composite index requirement
  const userTiers = querySnapshot.docs
    .map(doc => ({
      id: doc.id,
      ...doc.data()
    }))
    .filter((tier: any) => ['ACTIVE', 'CANCELLED'].includes(tier.status))
    .sort((a: any, b: any) => {
      // Sort by createdAt descending (most recent first)
      const aTime = a.createdAt._seconds || 0;
      const bTime = b.createdAt._seconds || 0;
      return bTime - aTime;
    });

  if (userTiers.length === 0) {
    return null;
  }

  return userTiers[0] as UserTier & { id: string };
};

export const cancelUserSubscription = async (userId: string, reason: string = 'upgrade') => {
  // Get all user subscriptions and filter in memory
  const querySnapshot = await db.collection('tier')
    .where('userId', '==', userId)
    .get();

  if (!querySnapshot.empty) {
    // Find active subscription in memory
    const activeDoc = querySnapshot.docs.find(doc => doc.data().status === 'ACTIVE');
    
    if (activeDoc) {
      const docId = activeDoc.id;
      const now = new Date();
      
      await db.collection('tier').doc(docId).update({
        status: 'CANCELLED',
        updatedAt: Timestamp.fromDate(now),
        cancellationReason: reason,
        cancelledAt: Timestamp.fromDate(now),
      });
      
      console.log('Cancelled subscription for user:', userId, 'reason:', reason);
      return activeDoc.data() as UserTier;
    }
  }
  
  return null;
};