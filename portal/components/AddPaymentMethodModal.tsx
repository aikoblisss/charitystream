import React, { useEffect, useState, useRef } from 'react';
import { X, Lock } from 'lucide-react';

// Declare Stripe on window for TypeScript
declare global {
  interface Window {
    Stripe: any;
  }
}

interface AddPaymentMethodModalProps {
  onClose: () => void;
  onSuccess: () => void;
  clientSecret: string;
}

const AddPaymentMethodModal: React.FC<AddPaymentMethodModalProps> = ({ onClose, onSuccess, clientSecret }) => {
  const [stripe, setStripe] = useState<any>(null);
  const [elements, setElements] = useState<any>(null);
  const [paymentElement, setPaymentElement] = useState<any>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const paymentElementRef = useRef<HTMLDivElement>(null);

  // Effect A: Initialize Stripe and Elements
  useEffect(() => {
    const initializeStripe = async () => {
      if (!window.Stripe) {
        setError('Stripe.js failed to load. Please refresh the page.');
        setIsLoading(false);
        return;
      }

      try {
        // Fetch publishable key from backend
        const token = localStorage.getItem('advertiserPortalToken');
        const response = await fetch('/api/advertiser/stripe-config', {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });

        if (!response.ok) {
          throw new Error('Failed to get Stripe configuration');
        }

        const { publishableKey } = await response.json();
        
        if (!publishableKey) {
          throw new Error('Stripe publishable key not configured');
        }

        // Initialize Stripe
        const stripeInstance = window.Stripe(publishableKey);
        setStripe(stripeInstance);

        // Create Elements instance
        const elementsInstance = stripeInstance.elements({
          clientSecret: clientSecret,
          appearance: {
            theme: 'stripe',
          }
        });
        setElements(elementsInstance);
        
        setIsLoading(false);
      } catch (err: any) {
        console.error('Error initializing Stripe:', err);
        setError(err.message || 'Failed to initialize payment form');
        setIsLoading(false);
      }
    };

    initializeStripe();
  }, [clientSecret]);

  // Effect B: Mount PaymentElement when elements exists AND ref is mounted
  useEffect(() => {
    if (!elements || !paymentElementRef.current) {
      return;
    }

    // Create and mount Payment Element with Link disabled and cards only
    const paymentElementInstance = elements.create('payment', {
      wallets: {
        link: 'never'
      },
      paymentMethodTypes: ['card']
    });
    paymentElementInstance.mount(paymentElementRef.current);
    setPaymentElement(paymentElementInstance);

    // Cleanup: unmount when component unmounts or dependencies change
    return () => {
      if (paymentElementInstance) {
        try {
          paymentElementInstance.unmount();
        } catch (err) {
          // Ignore unmount errors (element may already be unmounted)
          console.warn('Error unmounting payment element:', err);
        }
      }
    };
  }, [elements]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!stripe || !elements) {
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      // Confirm the SetupIntent
      const { error: confirmError } = await stripe.confirmSetup({
        elements,
        confirmParams: {
          return_url: window.location.href, // Not used for SetupIntent, but required
        },
        redirect: 'if_required' // Only redirect if 3D Secure is required
      });

      if (confirmError) {
        setError(confirmError.message || 'Failed to add payment method');
        setIsProcessing(false);
      } else {
        // Success - payment method added
        onSuccess();
        onClose();
      }
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred');
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" 
        onClick={onClose}
      ></div>

      {/* Modal Content */}
      <div className="relative bg-container-light dark:bg-container-dark rounded-2xl border border-border-light dark:border-border-dark shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col transform transition-all scale-100">
        
        {/* Header Section */}
        <div className="flex items-start justify-between px-6 pt-6 pb-2 flex-shrink-0">
          <div>
            <h3 className="text-xl font-bold text-text-primary-light dark:text-text-primary-dark">Add New Card</h3>
            <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark mt-1.5">
              Securely add a payment method using Stripe.
            </p>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 -mr-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-text-secondary-light dark:text-text-secondary-dark transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body Section - Scrollable */}
        <div className="px-6 pb-6 pt-6 overflow-y-auto flex-1 min-h-0">
          {isLoading ? (
            <div className="flex items-center justify-center p-8">
              <p className="text-text-secondary-light dark:text-text-secondary-dark">Loading payment form...</p>
            </div>
          ) : (
            <form id="payment-form" onSubmit={handleSubmit}>
              {/* Container div always rendered - ref ensures it exists before mounting */}
              <div ref={paymentElementRef} className="mb-4">
                {/* Stripe Elements will mount here */}
              </div>
            
            {error && (
              <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">
                {error}
              </div>
            )}

              <div className="flex items-center gap-2 text-xs text-text-secondary-light dark:text-text-secondary-dark mb-4">
                <Lock className="w-3 h-3" />
                <span>Your payment information is secure and encrypted</span>
              </div>
            </form>
          )}
        </div>

        {/* Footer Section */}
        <div className="p-6 border-t border-border-light dark:border-border-dark bg-gray-50/50 dark:bg-white/5 flex gap-3 flex-shrink-0">
          <button 
            onClick={onClose}
            disabled={isProcessing}
            className="flex-1 px-4 py-2.5 rounded-lg border border-border-light dark:border-border-dark font-semibold text-text-primary-light dark:text-text-primary-dark hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button 
            type="submit"
            form="payment-form"
            disabled={isProcessing || !stripe || !elements}
            className="flex-1 px-4 py-2.5 rounded-lg bg-primary hover:bg-primary/90 text-white font-semibold shadow-sm transition-colors disabled:opacity-50"
          >
            {isProcessing ? 'Processing...' : 'Add Card'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddPaymentMethodModal;
