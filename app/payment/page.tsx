'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

interface PaymentResponse {
  success: boolean;
  paymentLink: string;
  subscriptionId: string;
  planDetails: {
    tier: string;
    renewalPeriod: string;
    amount: number;
  };
}

export default function PaymentPage() {
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const createPaymentLink = async () => {
      const username = searchParams.get('username');
      const planId = searchParams.get('planId');
      const planChange = searchParams.get('planChange');
      const currentSubscriptionId = searchParams.get('currentSubscriptionId');

      console.log('Payment page params:', { username, planId, planChange, currentSubscriptionId });

      // If this is a plan change (upgrade/downgrade), redirect back to main page
      // as plan changes should be handled directly, not through payment page
      if (planChange && currentSubscriptionId) {
        console.log('Plan change detected, redirecting to main page...');
        setError('Plan changes are handled directly. Redirecting...');
        setTimeout(() => {
          window.location.href = '/';
        }, 2000);
        setLoading(false);
        return;
      }

      if (!username || !planId) {
        setError('Missing required parameters: username and planId');
        setLoading(false);
        return;
      }

      try {
        console.log('Creating payment link for new subscription...');
        
        const response = await fetch('/api/create-payment-link', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username,
            planId,
          }),
        });

        console.log('Payment link response status:', response.status);

        if (!response.ok) {
          const errorText = await response.text();
          console.error('Payment link error:', errorText);
          throw new Error(errorText || `HTTP error! status: ${response.status}`);
        }

        const data: PaymentResponse = await response.json();
        console.log('Payment link created:', data);

        if (data.success && data.paymentLink) {
          console.log('Redirecting to payment link:', data.paymentLink);
          window.location.href = data.paymentLink;
        } else {
          setError('Failed to create payment link');
        }
      } catch (err) {
        console.error('Payment link creation error:', err);
        setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      } finally {
        setLoading(false);
      }
    };

    createPaymentLink();
  }, [searchParams]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8">
        <div className="w-full max-w-md mx-auto">
          <div className="bg-white rounded-lg shadow-lg p-8">
            <div className="flex flex-col items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-4"></div>
              <h2 className="text-xl font-semibold mb-2 text-center">Processing Payment</h2>
              <p className="text-gray-600 text-center">
                Please wait while we prepare your payment link...
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8">
        <div className="w-full max-w-md mx-auto">
          <div className="bg-white rounded-lg shadow-lg p-8">
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <h3 className="text-red-800 font-semibold mb-2">Payment Error</h3>
              <p className="text-red-700 text-sm">{error}</p>
            </div>
            <button
              onClick={() => window.history.back()}
              className="mt-4 w-full bg-gray-600 text-white py-2 px-4 rounded-lg hover:bg-gray-700 transition-colors"
            >
              Go Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}