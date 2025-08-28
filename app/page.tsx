"use client";

import { useState, useEffect } from "react";
import { RAZORPAY_PLAN_IDS } from "@/lib/billing-config";

interface SubscriptionPlan {
  id: string;
  razorpayPlanId: string;
  name: string;
  price: number;
  duration: string;
  features: string[];
}

interface UserTierInfo {
  username: string;
  hasSubscription: boolean;

  tierEntity?: {
    tier: "NONE" | "BASIC" | "PRO" | "TRIAL";

    billing?: {
      renewalPeriod: "MONTHLY" | "ANNUAL" | null;

      // Lifecycle dates
      currentPeriodStart: string | null;
      currentPeriodEnd: string | null;

      // Razorpay identifiers
      razorpaySubscriptionId?: string;
      razorpayCustomerId?: string;

      // Payment method from subscription authenticated event
      payment_method?: 'upi' | 'card' | 'netbanking' | 'wallet' | null;

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

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [username, setUsername] = useState("919700550849");
  const [userBilling, setUserBilling] = useState<UserTierInfo | null>(null);
  const [fetchingBilling, setFetchingBilling] = useState(false);
  const [upgradeStatus, setUpgradeStatus] = useState<{
    show: boolean;
    message: string;
    type: 'success' | 'error' | 'info';
    proratedAmount?: number;
    paymentOrderId?: string;
    checkoutUrl?: string;
  } | null>(null);

  const subscriptionPlans: SubscriptionPlan[] = [
    {
      id: "basic_monthly",
      razorpayPlanId: RAZORPAY_PLAN_IDS.BASIC_MONTHLY,
      name: "Basic Plan",
      price: 89,
      duration: "monthly",
      features: ["feature1", "feature2", "feature3"]
    },
    {
      id: "pro_monthly",
      razorpayPlanId: RAZORPAY_PLAN_IDS.PRO_MONTHLY,
      name: "Pro Plan",
      price: 129,
      duration: "monthly",
      features: ["feature1", "feature2", "feature3", "feature4", "feature5"]
    },
    {
      id: "basic_yearly",
      razorpayPlanId: RAZORPAY_PLAN_IDS.BASIC_YEARLY,
      name: "Basic Plan",
      price: 749,
      duration: "yearly",
      features: ["feature1", "feature2", "feature3"]
    },
    {
      id: "pro_yearly",
      razorpayPlanId: RAZORPAY_PLAN_IDS.PRO_YEARLY,
      name: "Pro Plan",
      price: 1089,
      duration: "yearly",
      features: ["feature1", "feature2", "feature3", "feature4", "feature5"]
    }
  ];

  const fetchUserBilling = async (usernameToFetch: string) => {
    if (!usernameToFetch.trim()) return;

    setFetchingBilling(true);
    try {
      const response = await fetch(`/api/user-billing?username=${encodeURIComponent(usernameToFetch)}`);
      const data: UserTierInfo = await response.json();

      console.log('User billing data:', data);
      setUserBilling(data);
    } catch (error) {
      console.error('Error fetching user billing:', error);
      setUserBilling({
        hasSubscription: false,
        username: usernameToFetch,
      });
    } finally {
      setFetchingBilling(false);
    }
  };

  const handleUsernameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchUserBilling(username);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      fetchUserBilling(username);
    }
  };

  useEffect(() => {
    fetchUserBilling(username);
  }, [username]);

  const handleSubscribe = async (plan: SubscriptionPlan) => {
    console.log('Handling subscription for plan:', plan.id);

    // Check if user has active subscription and this is an upgrade
    if (userBilling?.hasSubscription && userBilling.tierEntity) {
      const currentTier = userBilling.tierEntity.tier;
      const currentRenewalPeriod = userBilling.tierEntity.billing?.renewalPeriod;
      const newTier = plan.id.includes('basic') ? 'BASIC' : 'PRO';
      const newRenewalPeriod = plan.duration === 'yearly' ? 'ANNUAL' : 'MONTHLY';
      
      // Check if this is a valid upgrade path
      const isValidUpgrade = (
        // BASIC to PRO upgrades (any billing period combination)
        (currentTier === 'BASIC' && newTier === 'PRO') ||
        // Plan period changes (same tier, MONTHLY to ANNUAL)
        (currentTier === newTier && currentRenewalPeriod === 'MONTHLY' && newRenewalPeriod === 'ANNUAL')
      );
      
      if (isValidUpgrade && (currentTier === 'BASIC' || currentTier === 'PRO')) {
        // This is a valid upgrade - handle via upgrade API
        await handleUpgrade(plan);
        return;
      }
      
      // Handle downgrades if needed (PRO to BASIC - currently disabled)
      if (currentTier === 'PRO' && newTier === 'BASIC') {
        // This is a downgrade - handle via downgrade API
        await handleDowngrade(plan);
        return;
      }
    }

    // Simple buy logic - redirect to payment page
    const paymentUrl = `/payment?username=${encodeURIComponent(username)}&planId=${encodeURIComponent(plan.razorpayPlanId)}`;
    window.location.href = paymentUrl;
  };

  const handleUpgrade = async (plan: SubscriptionPlan) => {
    if (!userBilling?.hasSubscription || !userBilling?.tierEntity) {
      setUpgradeStatus({
        show: true,
        message: 'No active subscription found',
        type: 'error'
      });
      return;
    }

    setLoading(true);
    setUpgradeStatus(null);
    
    try {
      console.log('Processing upgrade...');
      
      // Determine target tier and renewal period from plan
      const targetTier = plan.id.includes('basic') ? 'BASIC' : 'PRO';
      const targetRenewalPeriod = plan.duration === 'yearly' ? 'ANNUAL' : 'MONTHLY';
      
      const response = await fetch('/api/upgrade-subscription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: username,
          targetTier: targetTier as 'BASIC' | 'PRO',
          targetRenewalPeriod: targetRenewalPeriod as 'MONTHLY' | 'ANNUAL',
        }),
      });

      const result = await response.json();
      
      if (response.ok && result.success) {
        if (result.proratedPayment && result.proratedAmount > 0) {
          setUpgradeStatus({
            show: true,
            message: `Upgrade requires prorated payment of ₹${result.proratedAmount}`,
            type: 'info',
            proratedAmount: result.proratedAmount,
            paymentOrderId: result.proratedPayment.orderId
          });
        } else if (result.checkoutUrl && result.requiresAuthentication) {
          // UPI upgrade with checkout URL for mandate authentication
          setUpgradeStatus({
            show: true,
            message: result.message || 'UPI upgrade initiated! Click below to complete mandate setup.',
            type: 'info',
            checkoutUrl: result.checkoutUrl
          });
        } else {
          setUpgradeStatus({
            show: true,
            message: result.message || 'Upgrade completed successfully!',
            type: 'success'
          });
        }
        await fetchUserBilling(username);
      } else {
        setUpgradeStatus({
          show: true,
          message: result.error || 'Failed to upgrade subscription',
          type: 'error'
        });
      }
    } catch (error) {
      console.error('Upgrade error:', error);
      setUpgradeStatus({
        show: true,
        message: 'Failed to upgrade subscription. Please try again.',
        type: 'error'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDowngrade = async (plan: SubscriptionPlan) => {
    if (!userBilling?.tierEntity?.billing?.razorpaySubscriptionId) {
      setUpgradeStatus({
        show: true,
        message: 'No active subscription found',
        type: 'error'
      });
      return;
    }

    setLoading(true);
    setUpgradeStatus(null);
    
    try {
      console.log('Processing downgrade...');
      
      const response = await fetch('/api/downgrade-subscription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: username,
          newPlanId: plan.razorpayPlanId,
          currentSubscriptionId: userBilling.tierEntity.billing.razorpaySubscriptionId,
        }),
      });

      const result = await response.json();
      
      if (response.ok && result.success) {
        setUpgradeStatus({
          show: true,
          message: result.message || 'Downgrade processed successfully!',
          type: 'success'
        });
        await fetchUserBilling(username);
      } else {
        setUpgradeStatus({
          show: true,
          message: result.error || 'Failed to downgrade subscription',
          type: 'error'
        });
      }
    } catch (error) {
      console.error('Downgrade error:', error);
      setUpgradeStatus({
        show: true,
        message: 'Failed to downgrade subscription. Please try again.',
        type: 'error'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!userBilling?.tierEntity?.billing?.razorpaySubscriptionId) {
      setUpgradeStatus({
        show: true,
        message: 'No active subscription found',
        type: 'error'
      });
      return;
    }

    const endDate = userBilling.tierEntity.billing?.currentPeriodEnd 
      ? new Date(userBilling.tierEntity.billing.currentPeriodEnd).toLocaleDateString()
      : 'current period end';

    const confirmMessage = `Are you sure you want to cancel your subscription? You can continue using the service until ${endDate}, then it will stop automatically. No further charges will be made.`;

    if (!confirm(confirmMessage)) {
      return;
    }

    setLoading(true);
    setUpgradeStatus(null);
    
    try {
      console.log('Processing subscription cancellation...');
      
      const response = await fetch('/api/cancel-subscription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: username,
          subscriptionId: userBilling.tierEntity.billing.razorpaySubscriptionId,
        }),
      });

      const result = await response.json();
      
      if (response.ok && result.success) {
        setUpgradeStatus({
          show: true,
          message: result.message,
          type: 'success'
        });
        await fetchUserBilling(username);
      } else {
        setUpgradeStatus({
          show: true,
          message: result.error || 'Failed to cancel subscription',
          type: 'error'
        });
      }
    } catch (error) {
      console.error('Cancellation error:', error);
      setUpgradeStatus({
        show: true,
        message: 'Failed to cancel subscription. Please try again.',
        type: 'error'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleProratedPayment = (orderId: string) => {
    // Create proper payment page URL for the prorated amount
    const paymentUrl = `/payment?username=${encodeURIComponent(username)}&orderId=${encodeURIComponent(orderId)}&type=prorated`;
    window.location.href = paymentUrl;
  };

  const handleSetupNewSubscription = async () => {
    setLoading(true);
    setUpgradeStatus(null);
    
    try {
      console.log('Setting up new subscription mandate...');
      
      const response = await fetch('/api/setup-new-subscription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: username,
        }),
      });

      const result = await response.json();
      
      if (response.ok && result.success) {
        if (result.paymentLink) {
          setUpgradeStatus({
            show: true,
            message: 'Redirecting to set up UPI mandate for your new subscription...',
            type: 'info'
          });
          // Redirect after a short delay to show the message
          setTimeout(() => {
            window.location.href = result.paymentLink;
          }, 1000);
        } else {
          setUpgradeStatus({
            show: true,
            message: result.message || 'New subscription setup completed',
            type: 'success'
          });
        }
      } else {
        setUpgradeStatus({
          show: true,
          message: result.error || 'Failed to setup new subscription',
          type: 'error'
        });
      }
    } catch (error) {
      console.error('Setup error:', error);
      setUpgradeStatus({
        show: true,
        message: 'Failed to setup new subscription. Please try again.',
        type: 'error'
      });
    } finally {
      setLoading(false);
    }
  };

  const getButtonText = (plan: SubscriptionPlan): string => {
    if (!userBilling?.hasSubscription) return "Subscribe Now";
    
    const currentTier = userBilling.tierEntity?.tier;
    const newTier = plan.id.includes('basic') ? 'BASIC' : 'PRO';
    const isYearly = plan.duration === 'yearly';
    const currentRenewal = userBilling.tierEntity?.billing?.renewalPeriod;
    
    // Check if user has an active subscription based on hasSubscription flag and status
    const isActiveSubscription = Boolean(userBilling?.hasSubscription && 
                                         userBilling?.tierEntity?.billing?.status === 'ACTIVE');
    
    if (!isActiveSubscription) return "Subscribe Now";
    
    // Check if same tier and period
    if (currentTier === newTier && 
        ((currentRenewal === 'MONTHLY' && !isYearly) || (currentRenewal === 'ANNUAL' && isYearly))) {
      return "Current Plan";
    }
    
    // Check for upgrades
    if (currentTier === 'BASIC' && newTier === 'PRO') return "Upgrade";
    if (currentTier === newTier && currentRenewal === 'MONTHLY' && isYearly) return "Switch to Yearly";
    
    // Check for downgrades
    if (currentTier === 'PRO' && newTier === 'BASIC') return "Downgrade";
    if (currentTier === newTier && currentRenewal === 'ANNUAL' && !isYearly) return "Switch to Monthly";
    
    return "Subscribe Now";
  };

  const isButtonDisabled = (plan: SubscriptionPlan): boolean => {
    if (fetchingBilling || loading || !username.trim()) return true;
    
    if (!userBilling?.hasSubscription) return false;
    
    const currentTier = userBilling.tierEntity?.tier;
    const newTier = plan.id.includes('basic') ? 'BASIC' : 'PRO';
    const isYearly = plan.duration === 'yearly';
    const currentRenewal = userBilling.tierEntity?.billing?.renewalPeriod;
    
    // Check if user has an active subscription based on hasSubscription flag and status
    const isActiveSubscription = Boolean(userBilling?.hasSubscription && 
                                         userBilling?.tierEntity?.billing?.status === 'ACTIVE');
    
    // Disable if it's the current plan or if subscription is not active
    return isActiveSubscription && 
           (currentTier === newTier &&
           ((currentRenewal === 'MONTHLY' && !isYearly) || (currentRenewal === 'ANNUAL' && isYearly)));
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-gray-900">
            Subscription Management
          </h1>
        </div>

        {/* Current Tier and Status Display */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center gap-3 px-6 py-3 bg-white rounded-lg shadow-sm border">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-600">Current Plan:</span>
              <span className={`px-3 py-1 rounded-full text-sm font-semibold ${
                userBilling?.tierEntity?.tier === 'PRO' 
                  ? 'bg-purple-100 text-purple-800' 
                  : userBilling?.tierEntity?.tier === 'BASIC'
                    ? 'bg-blue-100 text-blue-800'
                    : 'bg-gray-100 text-gray-800'
              }`}>
                {userBilling?.tierEntity?.tier || 'NONE'}
              </span>
            </div>
            
            {userBilling?.hasSubscription && userBilling?.tierEntity?.billing?.status && (
              <>
                <div className="w-px h-6 bg-gray-300"></div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-600">Status:</span>
                  <span className={`px-3 py-1 rounded-full text-sm font-semibold ${
                    userBilling?.tierEntity?.billing?.status === 'ACTIVE' 
                      ? 'bg-green-100 text-green-800' 
                      : userBilling?.tierEntity?.billing?.status === 'HALTED'
                        ? 'bg-yellow-100 text-yellow-800'
                        : 'bg-red-100 text-red-800'
                  }`}>
                    {userBilling?.tierEntity?.billing?.status}
                  </span>
                </div>
              </>
            )}
            
            {userBilling?.tierEntity?.billing?.renewalPeriod && (
              <>
                <div className="w-px h-6 bg-gray-300"></div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-600">Billing:</span>
                  <span className="px-3 py-1 rounded-full text-sm font-medium bg-gray-100 text-gray-700">
                    {userBilling?.tierEntity?.billing?.renewalPeriod}
                  </span>
                </div>
              </>
            )}
            
            {userBilling?.tierEntity?.billing?.payment_method && (
              <>
                <div className="w-px h-6 bg-gray-300"></div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-600">Payment:</span>
                  <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                    userBilling?.tierEntity?.billing?.payment_method === 'upi' 
                      ? 'bg-orange-100 text-orange-700' 
                      : userBilling?.tierEntity?.billing?.payment_method === 'card'
                        ? 'bg-blue-100 text-blue-700'
                        : userBilling?.tierEntity?.billing?.payment_method === 'netbanking'
                          ? 'bg-green-100 text-green-700'
                          : userBilling?.tierEntity?.billing?.payment_method === 'wallet'
                            ? 'bg-purple-100 text-purple-700'
                            : 'bg-gray-100 text-gray-700'
                  }`}>
                    {userBilling?.tierEntity?.billing?.payment_method?.toUpperCase()}
                  </span>
                </div>
              </>
            )}
          </div>
          
          {userBilling?.tierEntity?.billing?.upgradeInProgress && (
            <div className="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-orange-100 text-orange-800 rounded-lg">
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span className="text-sm font-medium">Upgrade in progress...</span>
            </div>
          )}
        </div>

        {/* Status Notification */}
        {upgradeStatus?.show && (
          <div className={`mb-6 p-4 rounded-lg border ${
            upgradeStatus.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' :
            upgradeStatus.type === 'error' ? 'bg-red-50 border-red-200 text-red-800' :
            'bg-blue-50 border-blue-200 text-blue-800'
          }`}>
            <div className="flex justify-between items-start">
              <div className="flex-1">
                <p className="font-medium">{upgradeStatus.message}</p>
                {upgradeStatus.proratedAmount && upgradeStatus.paymentOrderId && (
                  <div className="mt-3 space-y-2">
                    <p className="text-sm">
                      Pay ₹{upgradeStatus.proratedAmount} now to upgrade immediately, and your new subscription will start from the next billing cycle.
                    </p>
                    <button
                      onClick={() => handleProratedPayment(upgradeStatus.paymentOrderId!)}
                      className="inline-flex items-center px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
                    >
                      Pay ₹{upgradeStatus.proratedAmount} Now
                    </button>
                  </div>
                )}
                {upgradeStatus.checkoutUrl && (
                  <div className="mt-3 space-y-2">
                    <p className="text-sm">
                      Complete UPI mandate setup to activate your upgraded subscription.
                    </p>
                    <button
                      onClick={() => window.open(upgradeStatus.checkoutUrl, '_blank')}
                      className="inline-flex items-center px-4 py-2 bg-orange-600 text-white text-sm font-medium rounded-lg hover:bg-orange-700 transition-colors"
                    >
                      🔐 Setup UPI Mandate
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={() => setUpgradeStatus(null)}
                className="ml-4 text-gray-400 hover:text-gray-600"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        <div className="grid lg:grid-cols-2 gap-4 max-w-full">
          {/* Left Column - Username Input & Subscription Details */}
          <div className="space-y-4 min-w-0">
            {/* Username Input Section */}
            <div className="bg-white rounded-lg shadow-lg p-4">
              <h2 className="text-lg font-bold text-gray-900 mb-3">User Information</h2>
              <form onSubmit={handleUsernameSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Username
                  </label>
                  <div className="flex space-x-2">
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      onKeyPress={handleKeyPress}
                      className="flex-1 px-4 py-2 border border-gray-300 text-black rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      placeholder="Enter your username"
                    />
                    <button
                      type="submit"
                      disabled={fetchingBilling || !username.trim()}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                    >
                      {fetchingBilling ? 'Loading...' : 'Get Info'}
                    </button>
                  </div>
                </div>
              </form>
            </div>

            {/* Current Subscription Status */}
            <div className="bg-white rounded-lg shadow-lg p-4">
              <h2 className="text-lg font-bold text-gray-900 mb-3">
                Current Subscription Status
              </h2>
              <div className="bg-gray-50 rounded-lg p-4">
                {fetchingBilling ? (
                  <div className="text-center py-4">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto mb-2"></div>
                    <p className="text-gray-600">Loading...</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Username:</span>
                      <span className="font-semibold text-gray-900">{userBilling?.username || username}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Tier:</span>
                      <span className="font-semibold text-gray-900">{userBilling?.tierEntity?.tier || 'NONE'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Status:</span>
                      <span className={`font-semibold ${
                        userBilling?.tierEntity?.billing?.status === 'ACTIVE' 
                          ? 'text-green-600'
                          : userBilling?.tierEntity?.billing?.status === 'CANCELLED'
                            ? 'text-orange-600'
                          : userBilling?.tierEntity?.billing?.status === 'HALTED'
                            ? 'text-red-600'
                            : 'text-gray-600'
                      }`}>
                        {userBilling?.tierEntity?.billing?.status || 'INACTIVE'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Next Billing:</span>
                      <span className="font-semibold text-gray-900">
                        {userBilling?.tierEntity?.billing?.currentPeriodEnd 
                          ? new Date(userBilling.tierEntity.billing.currentPeriodEnd).toLocaleDateString()
                          : 'N/A'}
                      </span>
                    </div>
                    
                    {userBilling?.tierEntity?.billing?.payment_method && (
                      <div className="flex justify-between">
                        <span className="text-gray-600">Payment Method:</span>
                        <span className={`font-semibold ${
                          userBilling?.tierEntity?.billing?.payment_method === 'upi' 
                            ? 'text-orange-600' 
                            : userBilling?.tierEntity?.billing?.payment_method === 'card'
                              ? 'text-blue-600'
                              : userBilling?.tierEntity?.billing?.payment_method === 'netbanking'
                                ? 'text-green-600'
                                : userBilling?.tierEntity?.billing?.payment_method === 'wallet'
                                  ? 'text-purple-600'
                                  : 'text-gray-600'
                        }`}>
                          {userBilling?.tierEntity?.billing?.payment_method?.toUpperCase()}
                        </span>
                      </div>
                    )}
                    
                    {/* Cancellation Button */}
                    {userBilling?.tierEntity?.billing?.status === 'ACTIVE' && (
                      <div className="mt-3 pt-3 border-t border-gray-300">
                        <button
                          onClick={handleCancel}
                          disabled={loading}
                          className="w-full py-2 px-4 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
                        >
                          {loading ? 'Processing...' : 'Cancel Subscription'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Column - Subscription Plans */}
          <div className="min-w-0">
            <div className="bg-white rounded-lg shadow-lg p-4">
              <h2 className="text-lg font-bold text-gray-900 mb-3">Available Plans</h2>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 max-w-full">
                {subscriptionPlans.map((plan) => (
                  <div
                    key={plan.id}
                    className="bg-gray-50 rounded-lg p-4 border border-gray-200 hover:border-blue-500 transition-colors flex flex-col"
                  >
                    <div className="text-center mb-4">
                      <h3 className="text-lg font-bold text-gray-900 mb-1">
                        {plan.name} <span className="text-sm font-normal text-gray-500">({plan.duration})</span>
                      </h3>
                      <div className="text-2xl font-bold text-blue-600 mb-1">
                        ₹{plan.price}
                        <span className="text-sm text-gray-500">/{plan.duration}</span>
                      </div>
                      {userBilling?.hasSubscription && userBilling.tierEntity && (
                        <div className="text-xs text-gray-600 mt-1">
                          {(() => {
                            const currentTier = userBilling.tierEntity?.tier;
                            const newTier = plan.id.includes('basic') ? 'BASIC' : 'PRO';
                            const isYearly = plan.duration === 'yearly';
                            const currentRenewal = userBilling.tierEntity?.billing?.renewalPeriod;
                            
                            if (currentTier === newTier && 
                                ((currentRenewal === 'MONTHLY' && !isYearly) || (currentRenewal === 'ANNUAL' && isYearly))) {
                              return "✓ Your current plan";
                            }
                            if (currentTier === 'BASIC' && newTier === 'PRO') {
                              return "↗ Upgrade available";
                            }
                            if (currentTier === 'PRO' && newTier === 'BASIC') {
                              return "↘ Downgrade option";
                            }
                            if (currentTier === newTier && currentRenewal === 'MONTHLY' && isYearly) {
                              return "📅 Switch to yearly";
                            }
                            if (currentTier === newTier && currentRenewal === 'ANNUAL' && !isYearly) {
                              return "📅 Switch to monthly";
                            }
                            return "";
                          })()}
                        </div>
                      )}
                    </div>

                    <ul className="space-y-2 mb-4 flex-grow">
                      {plan.features.map((feature, index) => (
                        <li key={index} className="flex items-center text-sm text-gray-700">
                          <svg
                            className="h-4 w-4 text-green-500 mr-2 flex-shrink-0"
                            fill="none"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path d="M5 13l4 4L19 7"></path>
                          </svg>
                          {feature}
                        </li>
                      ))}
                    </ul>

                    <button
                      onClick={() => handleSubscribe(plan)}
                      disabled={isButtonDisabled(plan)}
                      className={`w-full py-2 px-4 rounded-lg font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        getButtonText(plan) === 'Current Plan'
                          ? 'bg-gray-600 text-white'
                          : getButtonText(plan) === 'Upgrade' || getButtonText(plan) === 'Switch to Yearly'
                          ? 'bg-green-600 text-white hover:bg-green-700'
                          : getButtonText(plan) === 'Downgrade' || getButtonText(plan) === 'Switch to Monthly'
                          ? 'bg-orange-600 text-white hover:bg-orange-700'
                          : 'bg-blue-600 text-white hover:bg-blue-700'
                      }`}
                    >
                      {loading || fetchingBilling ? "Processing..." : getButtonText(plan)}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}