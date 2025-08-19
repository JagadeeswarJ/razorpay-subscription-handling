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
  hasSubscription: boolean;
  username: string;
  tierEntity?: {
    tier: "NONE" | "BASIC" | "PRO" | "TRIAL";
    billing?: {
      renewalPeriod: "MONTHLY" | "ANNUAL" | null;
      subscriptionStartDate: string | null;
      subscriptionEndDate: string | null;
      razorpaySubscriptionId?: string;
      razorpayCustomerId?: string;
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

  const subscriptionPlans: SubscriptionPlan[] = [
    {
      id: "basic_monthly",
      razorpayPlanId: RAZORPAY_PLAN_IDS.BASIC_MONTHLY,
      name: "Basic Plan",
      price: 999,
      duration: "monthly",
      features: ["feature1", "feature2", "feature3"]
    },
    {
      id: "pro_monthly",
      razorpayPlanId: RAZORPAY_PLAN_IDS.PRO_MONTHLY,
      name: "Pro Plan",
      price: 2999,
      duration: "monthly",
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

  useEffect(() => {
    fetchUserBilling(username);
  }, [username]);

  const handleSubscribe = async (plan: SubscriptionPlan) => {
    console.log('Handling subscription for plan:', plan.id);
    
    // For upgrades, use the upgrade API directly (no payment page needed)
    if (userBilling?.hasSubscription && userBilling.tierEntity?.billing?.razorpaySubscriptionId) {
      const currentTier = userBilling.tierEntity.tier;
      const newTier = plan.id.includes('basic') ? 'BASIC' : 'PRO';
      
      if (currentTier !== newTier && (currentTier === 'BASIC' || currentTier === 'PRO')) {
        // This is a plan change (upgrade/downgrade) - handle directly with Razorpay API
        setLoading(true);
        
        const isUpgrade = currentTier === 'BASIC' && newTier === 'PRO';
        const isDowngrade = currentTier === 'PRO' && newTier === 'BASIC';
        const changeType = isUpgrade ? 'upgrade' : 'downgrade';
        
        try {
          console.log(`Processing ${changeType}...`);
          
          const response = await fetch('/api/upgrade-subscription', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              username: username,
              newPlanId: plan.razorpayPlanId,
              currentSubscriptionId: userBilling.tierEntity.billing.razorpaySubscriptionId,
              changeType: changeType, // 'upgrade' or 'downgrade'
            }),
          });

          const result = await response.json();
          
          if (response.ok && result.success) {
            if (result.paymentLink) {
              // New flow: Redirect to payment link for new subscription
              const message = isUpgrade 
                ? `🎉 Current subscription cancelled! ${result.refundAmount > 0 ? `₹${result.refundAmount} will be refunded.` : ''} Redirecting to complete payment for new plan...`
                : `✅ Current subscription cancelled! Redirecting to complete payment for new plan...`;
              
              alert(message);
              
              // Redirect to payment link
              window.location.href = result.paymentLink;
            } else {
              // Fallback message
              alert(result.message || `${changeType} initiated successfully`);
              await fetchUserBilling(username);
            }
          } else {
            alert(`Error: ${result.error || `Failed to ${changeType} subscription`}`);
          }
        } catch (error) {
          console.error(`${changeType} error:`, error);
          alert(`Failed to ${changeType} subscription. Please try again.`);
        } finally {
          setLoading(false);
        }
        return;
      }
    }
    
    // Regular new subscription - redirect to payment page
    const paymentUrl = `/payment?username=${encodeURIComponent(username)}&planId=${encodeURIComponent(plan.razorpayPlanId)}`;
    window.location.href = paymentUrl;
  };

  const getButtonText = (plan: SubscriptionPlan): string => {
    if (!userBilling?.hasSubscription) return "Subscribe Now";
    
    const currentTier = userBilling.tierEntity?.tier;
    const newTier = plan.id.includes('basic') ? 'BASIC' : 'PRO';
    
    if (!userBilling.tierEntity?.billing?.razorpaySubscriptionId) return "Subscribe Now";
    
    if (currentTier === newTier) return "Current Plan";
    
    if (currentTier === 'BASIC' && newTier === 'PRO') return "Upgrade";
    if (currentTier === 'PRO' && newTier === 'BASIC') return "Downgrade";
    
    return "Subscribe Now";
  };

  const isButtonDisabled = (plan: SubscriptionPlan): boolean => {
    if (fetchingBilling || loading || !username.trim()) return true;
    
    if (!userBilling?.hasSubscription) return false;
    
    const currentTier = userBilling.tierEntity?.tier;
    const newTier = plan.id.includes('basic') ? 'BASIC' : 'PRO';
    
    return !!userBilling.tierEntity?.billing?.razorpaySubscriptionId && currentTier === newTier;
  };

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-gray-900 mb-8">
            Choose Your Subscription Plan
          </h1>
          <p className="text-lg text-gray-600 mb-12">
            Select the perfect plan for your needs
          </p>
        </div>

        {/* Username Input */}
        <div className="mb-8 max-w-md mx-auto">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Username
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 text-black rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="Enter your username"
          />
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {subscriptionPlans.map((plan) => (
            <div
              key={plan.id}
              className="bg-white rounded-lg shadow-lg p-8 border border-gray-200 hover:border-blue-500 transition-colors"
            >
              <div className="text-center mb-6">
                <h3 className="text-2xl font-bold text-gray-900 mb-2">
                  {plan.name}
                </h3>
                <div className="text-4xl font-bold text-blue-600 mb-2">
                  ₹{plan.price}
                  <span className="text-lg text-gray-500">/{plan.duration}</span>
                </div>
              </div>

              <ul className="space-y-4 mb-8">
                {plan.features.map((feature, index) => (
                  <li key={index} className="flex items-center text-gray-700">
                    <svg
                      className="h-5 w-5 text-green-500 mr-3"
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
                className={`w-full py-3 px-6 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  getButtonText(plan) === 'Current Plan'
                    ? 'bg-gray-600 text-white'
                    : getButtonText(plan) === 'Upgrade'
                    ? 'bg-green-600 text-white hover:bg-green-700'
                    : getButtonText(plan) === 'Downgrade'
                    ? 'bg-orange-600 text-white hover:bg-orange-700'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                {loading || fetchingBilling ? "Processing..." : getButtonText(plan)}
              </button>
            </div>
          ))}
        </div>

        <div className="mt-16 bg-white rounded-lg shadow-lg p-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">
            Current Subscription Status
          </h2>
          <div className="bg-gray-50 rounded-lg p-6">
            {fetchingBilling ? (
              <div className="text-center py-4">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto mb-2"></div>
                <p className="text-gray-600">Loading subscription status...</p>
              </div>
            ) : userBilling?.hasSubscription && userBilling.tierEntity ? (
              <>
                <p className="text-gray-700">
                  <strong>Status:</strong> {userBilling.tierEntity.billing?.razorpaySubscriptionId ? 'ACTIVE' : 'INACTIVE'}
                </p>
                <p className="text-gray-700 mt-2">
                  <strong>Current Plan:</strong> {userBilling.tierEntity.tier} {userBilling.tierEntity.tier === 'BASIC' ? '(₹999/month)' : userBilling.tierEntity.tier === 'PRO' ? '(₹2999/month)' : ''}
                </p>
                <p className="text-gray-700 mt-2">
                  <strong>Renewal Period:</strong> {userBilling.tierEntity.billing?.renewalPeriod || 'N/A'}
                </p>
                {userBilling.tierEntity.billing?.subscriptionEndDate && (
                  <p className="text-gray-700 mt-2">
                    <strong>Next Billing:</strong> {new Date(userBilling.tierEntity.billing.subscriptionEndDate).toLocaleDateString()}
                  </p>
                )}
                {userBilling.tierEntity.billing?.razorpaySubscriptionId && (
                  <p className="text-gray-700 mt-2">
                    <strong>Subscription ID:</strong> {userBilling.tierEntity.billing.razorpaySubscriptionId}
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="text-gray-700">
                  <strong>Status:</strong> No active subscription
                </p>
                <p className="text-gray-700 mt-2">
                  <strong>Plan:</strong> None
                </p>
                <p className="text-gray-700 mt-2">
                  <strong>Next Billing:</strong> N/A
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}