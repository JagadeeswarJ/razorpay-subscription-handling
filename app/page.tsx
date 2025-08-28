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
      trialStartDate: string | null;
      trialEndDate: string | null;
      subscriptionStartDate: string | null;
      subscriptionEndDate: string | null;
      razorpaySubscriptionId?: string | null;
      razorpayCustomerId?: string;
      paymentMethod?: string;
      isConfirmationSent?: boolean;
      isCancelled?: boolean;
      cancellationDate?: string | null;
    };

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

    // Check if user has active subscription - if so, this is a plan change
    if (userBilling?.hasSubscription && userBilling.tierEntity) {
      await handleChangePlan(plan);
      return;
    }

    // New subscription - redirect to payment page
    const paymentUrl = `/payment?username=${encodeURIComponent(username)}&planId=${encodeURIComponent(plan.razorpayPlanId)}`;
    window.location.href = paymentUrl;
  };

  const handleChangePlan = async (plan: SubscriptionPlan) => {
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
      console.log('Processing plan change...');
      
      // Determine target tier and renewal period from plan
      const targetTier = plan.id.includes('basic') ? 'BASIC' : 'PRO';
      const targetRenewalPeriod = plan.duration === 'yearly' ? 'ANNUAL' : 'MONTHLY';
      
      const response = await fetch('/api/change-plan', {
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
        setUpgradeStatus({
          show: true,
          message: result.message || 'Plan changed successfully!',
          type: 'success'
        });
        await fetchUserBilling(username);
      } else {
        setUpgradeStatus({
          show: true,
          message: result.error || 'Failed to change plan',
          type: 'error'
        });
      }
    } catch (error) {
      console.error('Plan change error:', error);
      setUpgradeStatus({
        show: true,
        message: 'Failed to change plan. Please try again.',
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

    const endDate = userBilling.tierEntity.billing?.subscriptionEndDate 
      ? new Date(userBilling.tierEntity.billing.subscriptionEndDate).toLocaleDateString()
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
    
    // Check if user has an active subscription based on hasSubscription flag and cancellation status
    const isActiveSubscription = Boolean(userBilling?.hasSubscription && 
                                         !userBilling?.tierEntity?.billing?.isCancelled);
    
    if (!isActiveSubscription) return "Subscribe Now";
    
    // Check if same tier and period
    if (currentTier === newTier && 
        ((currentRenewal === 'MONTHLY' && !isYearly) || (currentRenewal === 'ANNUAL' && isYearly))) {
      return "Current Plan";
    }
    
    // All other cases are plan changes
    return "Change Plan";
  };

  const isButtonDisabled = (plan: SubscriptionPlan): boolean => {
    if (fetchingBilling || loading || !username.trim()) return true;
    
    if (!userBilling?.hasSubscription) return false;
    
    const currentTier = userBilling.tierEntity?.tier;
    const newTier = plan.id.includes('basic') ? 'BASIC' : 'PRO';
    const isYearly = plan.duration === 'yearly';
    const currentRenewal = userBilling.tierEntity?.billing?.renewalPeriod;
    
    // Check if user has an active subscription based on hasSubscription flag and cancellation status
    const isActiveSubscription = Boolean(userBilling?.hasSubscription && 
                                         !userBilling?.tierEntity?.billing?.isCancelled);
    
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
            
            {userBilling?.hasSubscription && (
              <>
                <div className="w-px h-6 bg-gray-300"></div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-600">Status:</span>
                  <span className={`px-3 py-1 rounded-full text-sm font-semibold ${
                    userBilling?.hasSubscription && !userBilling?.tierEntity?.billing?.isCancelled
                      ? 'bg-green-100 text-green-800' 
                      : userBilling?.tierEntity?.billing?.isCancelled
                        ? 'bg-red-100 text-red-800'
                        : 'bg-gray-100 text-gray-800'
                  }`}>
                    {userBilling?.hasSubscription && !userBilling?.tierEntity?.billing?.isCancelled
                      ? 'ACTIVE'
                      : userBilling?.tierEntity?.billing?.isCancelled
                        ? 'CANCELLED'
                        : 'INACTIVE'}
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
            
            {userBilling?.tierEntity?.billing?.paymentMethod && (
              <>
                <div className="w-px h-6 bg-gray-300"></div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-600">Payment:</span>
                  <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                    userBilling?.tierEntity?.billing?.paymentMethod === 'upi' 
                      ? 'bg-orange-100 text-orange-700' 
                      : userBilling?.tierEntity?.billing?.paymentMethod === 'card'
                        ? 'bg-blue-100 text-blue-700'
                        : userBilling?.tierEntity?.billing?.paymentMethod === 'netbanking'
                          ? 'bg-green-100 text-green-700'
                          : userBilling?.tierEntity?.billing?.paymentMethod === 'wallet'
                            ? 'bg-purple-100 text-purple-700'
                            : 'bg-gray-100 text-gray-700'
                  }`}>
                    {userBilling?.tierEntity?.billing?.paymentMethod?.toUpperCase()}
                  </span>
                </div>
              </>
            )}
          </div>
          
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
                        userBilling?.hasSubscription && !userBilling?.tierEntity?.billing?.isCancelled
                          ? 'text-green-600'
                          : userBilling?.tierEntity?.billing?.isCancelled
                            ? 'text-red-600'
                            : 'text-gray-600'
                      }`}>
                        {userBilling?.hasSubscription && !userBilling?.tierEntity?.billing?.isCancelled
                          ? 'ACTIVE'
                          : userBilling?.tierEntity?.billing?.isCancelled
                            ? 'CANCELLED'
                            : 'INACTIVE'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Next Billing:</span>
                      <span className="font-semibold text-gray-900">
                        {userBilling?.tierEntity?.billing?.subscriptionEndDate 
                          ? new Date(userBilling.tierEntity.billing.subscriptionEndDate).toLocaleDateString()
                          : 'N/A'}
                      </span>
                    </div>
                    
                    {userBilling?.tierEntity?.billing?.paymentMethod && (
                      <div className="flex justify-between">
                        <span className="text-gray-600">Payment Method:</span>
                        <span className={`font-semibold ${
                          userBilling?.tierEntity?.billing?.paymentMethod === 'upi' 
                            ? 'text-orange-600' 
                            : userBilling?.tierEntity?.billing?.paymentMethod === 'card'
                              ? 'text-blue-600'
                              : userBilling?.tierEntity?.billing?.paymentMethod === 'netbanking'
                                ? 'text-green-600'
                                : userBilling?.tierEntity?.billing?.paymentMethod === 'wallet'
                                  ? 'text-purple-600'
                                  : 'text-gray-600'
                        }`}>
                          {userBilling?.tierEntity?.billing?.paymentMethod?.toUpperCase()}
                        </span>
                      </div>
                    )}
                    
                    {/* Cancellation Button */}
                    {userBilling?.hasSubscription && !userBilling?.tierEntity?.billing?.isCancelled && (
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
                            return "📋 Available plan change";
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
                          : getButtonText(plan) === 'Change Plan'
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