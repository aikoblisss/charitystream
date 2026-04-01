import React, { useState } from 'react';
import { X, DollarSign } from 'lucide-react';

interface IncreaseBudgetModalProps {
  onClose: () => void;
  campaignName: string;
  currentBudget: number;
  campaignId?: number;
  onSuccess?: () => void;
}

const IncreaseBudgetModal: React.FC<IncreaseBudgetModalProps> = ({ onClose, campaignName, currentBudget, campaignId, onSuccess }) => {
  const [amountToAdd, setAmountToAdd] = useState<string>('500');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Calculate final total (live-updating)
  const finalTotal = currentBudget + Number(amountToAdd || 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" 
        onClick={onClose}
      ></div>

      {/* Modal Content */}
      <div className="relative bg-container-light dark:bg-container-dark rounded-2xl border border-border-light dark:border-border-dark shadow-2xl w-full max-w-md overflow-hidden transform transition-all scale-100">
        
        {/* Header Section */}
        <div className="flex items-start justify-between px-6 pt-6 pb-2">
          <div>
            <h3 className="text-xl font-bold text-text-primary-light dark:text-text-primary-dark">Increase Budget</h3>
            <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark mt-1.5">
              Add funds to <span className="font-semibold text-text-primary-light dark:text-text-primary-dark">{campaignName}</span> to extend reach.
            </p>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 -mr-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-text-secondary-light dark:text-text-secondary-dark transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body Section */}
        <div className="px-6 pb-6 pt-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary-light dark:text-text-secondary-dark mb-2">
                Amount to Add
              </label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary-light dark:text-text-secondary-dark" />
                <input 
                  type="number" 
                  value={amountToAdd}
                  onChange={(e) => setAmountToAdd(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 rounded-lg bg-background-light dark:bg-background-dark border border-border-light dark:border-border-dark text-text-primary-light dark:text-text-primary-dark font-semibold text-lg focus:ring-2 focus:ring-primary/50 outline-none transition-all"
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                />
              </div>
              
              {/* Final Total Display */}
              <div className="flex justify-between text-sm mt-2">
                <span className="text-text-secondary-light dark:text-text-secondary-dark">
                  Final Total:
                </span>
                <span className="font-semibold text-text-primary-light dark:text-text-primary-dark">
                  ${finalTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>

            {error && (
              <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg">
                {error}
              </div>
            )}

            <div className="grid grid-cols-4 gap-2">
              {['100', '500', '1000', '5000'].map((val) => (
                <button
                  key={val}
                  onClick={() => setAmountToAdd(val)}
                  className={`py-2 rounded-lg text-sm font-medium border transition-all ${
                    amountToAdd === val 
                      ? 'bg-primary/10 border-primary text-primary shadow-sm' 
                      : 'border-border-light dark:border-border-dark text-text-secondary-light dark:text-text-secondary-dark hover:bg-gray-50 dark:hover:bg-white/5 hover:border-primary/30'
                  }`}
                >
                  +${val}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer Section */}
        <div className="p-6 border-t border-border-light dark:border-border-dark bg-gray-50/50 dark:bg-white/5 flex gap-3">
          <button 
            onClick={onClose}
            className="flex-1 px-4 py-2.5 rounded-lg border border-border-light dark:border-border-dark font-semibold text-text-primary-light dark:text-text-primary-dark hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button 
            onClick={async () => {
              if (!campaignId) {
                setError('Campaign ID is required');
                return;
              }

              const amount = Number(amountToAdd);
              if (isNaN(amount) || amount <= 0) {
                setError('Please enter a valid amount');
                return;
              }

              try {
                setIsSubmitting(true);
                setError(null);

                const token = localStorage.getItem('advertiserPortalToken');
                if (!token) {
                  throw new Error('Not authenticated');
                }

                const response = await fetch('/api/advertiser/increase-budget', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                  },
                  body: JSON.stringify({
                    campaignId: campaignId,
                    amountToAdd: amount
                  })
                });

                if (!response.ok) {
                  const errorData = await response.json();
                  throw new Error(errorData.error || 'Failed to increase budget');
                }

                // Success - close modal and refresh dashboard
                onClose();
                if (onSuccess) {
                  onSuccess();
                }
              } catch (err) {
                console.error('Error increasing budget:', err);
                setError(err instanceof Error ? err.message : 'Failed to increase budget');
              } finally {
                setIsSubmitting(false);
              }
            }}
            className="flex-1 px-4 py-2.5 rounded-lg bg-primary hover:bg-primary/90 text-white font-semibold shadow-sm transition-colors disabled:opacity-70 disabled:cursor-not-allowed"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Processing...' : 'Confirm Payment'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default IncreaseBudgetModal;