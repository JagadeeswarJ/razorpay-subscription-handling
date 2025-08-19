'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

interface MandateSetupResponse {
  success: boolean;
  paymentLink?: string;
  subscriptionId?: string;
  message: string;
}

function MandateSetupContent() {
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<{
    username: string;
    newTier: string;
    proratedAmount: number;
    currentTier?: string;
  } | null>(null);

  useEffect(() => {
    const setupMandate = async () => {
      const username = searchParams.get('username');
      const newTier = searchParams.get('newTier');
      const proratedAmount = searchParams.get('proratedAmount');

      console.log('Mandate setup page params:', { username, newTier, proratedAmount });

      if (!username) {
        setError('Missing username parameter');
        setLoading(false);
        return;
      }

      // Fetch current user billing to get the actual tier
      try {
        const billingResponse = await fetch(`/api/user-billing?username=${encodeURIComponent(username)}`);
        const billingData = await billingResponse.json();
        
        setUserInfo({
          username,
          newTier: billingData.tierEntity?.tier || newTier || 'PRO',
          proratedAmount: parseFloat(proratedAmount || '0'),
          currentTier: billingData.tierEntity?.tier,
        });
      } catch (err) {
        console.error('Failed to fetch billing info:', err);
        setUserInfo({
          username,
          newTier: newTier || 'PRO',
          proratedAmount: parseFloat(proratedAmount || '0'),
        });
      }

      // Don't auto-redirect, let user click the button
      setLoading(false);
    };

    setupMandate();
  }, [searchParams]);

  const handleSetupMandate = async () => {
    if (!userInfo) return;

    setLoading(true);
    setError(null);

    try {
      console.log('Setting up UPI mandate for new subscription...');
      
      const response = await fetch('/api/setup-new-subscription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: userInfo.username,
        }),
      });

      const result: MandateSetupResponse = await response.json();
      
      if (response.ok && result.success && result.paymentLink) {
        console.log('Redirecting to UPI mandate setup:', result.paymentLink);
        window.location.href = result.paymentLink;
      } else {
        setError(result.message || 'Failed to setup UPI mandate');
      }
    } catch (err) {
      console.error('Mandate setup error:', err);
      setError('Failed to setup UPI mandate. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8">
        <div className="w-full max-w-md mx-auto">
          <div className="bg-white rounded-lg shadow-lg p-8">
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <h3 className="text-red-800 font-semibold mb-2">Setup Error</h3>
              <p className="text-red-700 text-sm">{error}</p>
            </div>
            <div className="mt-6 flex space-x-3">
              <button
                onClick={() => window.history.back()}
                className="flex-1 bg-gray-600 text-white py-2 px-4 rounded-lg hover:bg-gray-700 transition-colors"
              >
                Go Back
              </button>
              <button
                onClick={() => window.location.href = '/'}
                className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors"
              >
                Home
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8">
      <div className="w-full max-w-md mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-8">
          {/* Success Header */}
          <div className="text-center mb-6">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Upgrade Successful!</h2>
            <p className="text-gray-600 text-sm">
              You now have access to {userInfo?.newTier} features
            </p>
          </div>

          {/* Payment Summary */}
          {userInfo?.proratedAmount && userInfo.proratedAmount > 0 && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
              <div className="flex items-center justify-between">
                <span className="text-sm text-green-800">Prorated Payment</span>
                <span className="font-semibold text-green-900">₹{userInfo.proratedAmount} ✓</span>
              </div>
              <p className="text-xs text-green-700 mt-1">
                Successfully charged for immediate upgrade access
              </p>
            </div>
          )}

          {/* Next Step */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
            <h3 className="font-semibold text-blue-900 mb-2">Final Step Required</h3>
            <p className="text-sm text-blue-800 mb-3">
              To ensure continuous billing for your {userInfo?.newTier} subscription, please set up the UPI mandate for your new subscription. 
              This will also automatically cancel your old subscription to prevent double billing.
            </p>
            <ul className="text-xs text-blue-700 space-y-1">
              <li>• Sets up UPI auto-pay for new {userInfo?.newTier} subscription</li>
              <li>• Cancels old subscription automatically</li>
              <li>• Prevents double billing</li>
              <li>• Takes 30 seconds to complete</li>
            </ul>
          </div>

          {/* Action Button */}
          <button
            onClick={handleSetupMandate}
            disabled={loading}
            className="w-full bg-blue-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <div className="flex items-center justify-center">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                Setting up...
              </div>
            ) : (
              'Setup UPI Mandate'
            )}
          </button>

          {/* Skip Option */}
          <div className="mt-4 text-center">
            <button
              onClick={() => window.location.href = '/'}
              className="text-sm text-gray-500 hover:text-gray-700 underline"
            >
              Skip for now (you can set this up later from your account)
            </button>
          </div>

          {/* Help Text */}
          <div className="mt-6 text-center">
            <p className="text-xs text-gray-500">
              Need help? This process is secure and handled by Razorpay.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MandateSetupPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8">
        <div className="w-full max-w-md mx-auto">
          <div className="bg-white rounded-lg shadow-lg p-8">
            <div className="flex flex-col items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-4"></div>
              <h2 className="text-xl font-semibold mb-2 text-center">Loading</h2>
              <p className="text-gray-600 text-center">
                Preparing mandate setup...
              </p>
            </div>
          </div>
        </div>
      </div>
    }>
      <MandateSetupContent />
    </Suspense>
  );
}