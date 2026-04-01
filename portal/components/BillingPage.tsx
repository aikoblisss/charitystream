import React, { useState, useEffect } from 'react';
import { CreditCard, Plus } from 'lucide-react';
import Footer from './Footer';
import AddPaymentMethodModal from './AddPaymentMethodModal';
import { Page } from '../types';

interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  exp_month: number | null;
  exp_year: number | null;
  is_default: boolean;
}

interface BillingHistoryItem {
  invoiceId: string;
  date: string;
  campaignName: string;
  amount: number;
  currency: string;
  status: 'paid' | 'open' | 'failed' | 'draft' | 'uncollectible';
}

interface BillingPageProps {
  onNavigate: (page: Page) => void;
}

const BillingPage: React.FC<BillingPageProps> = ({ onNavigate }) => {
  const [isAddCardModalOpen, setIsAddCardModalOpen] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSettingDefault, setIsSettingDefault] = useState<string | null>(null);
  const [setupIntentClientSecret, setSetupIntentClientSecret] = useState<string | null>(null);
  const [isCreatingSetupIntent, setIsCreatingSetupIntent] = useState(false);
  const [billingHistory, setBillingHistory] = useState<BillingHistoryItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);

  const getAuthHeaders = () => {
    const token = localStorage.getItem('advertiserPortalToken');
    return token
      ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
  };

  const fetchPaymentMethods = async () => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/advertiser/payment-methods', {
        headers: getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error('Failed to fetch payment methods');
      }

      const data = await response.json();
      setPaymentMethods(data.paymentMethods || []);
    } catch (err) {
      console.error('Error fetching payment methods:', err);
      setPaymentMethods([]);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchBillingHistory = async () => {
    try {
      setIsLoadingHistory(true);
      const response = await fetch('/api/advertiser/billing-history', {
        headers: getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error('Failed to fetch billing history');
      }

      const data = await response.json();
      setBillingHistory(data.invoices || []);
    } catch (err) {
      console.error('Error fetching billing history:', err);
      setBillingHistory([]);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  useEffect(() => {
    fetchPaymentMethods();
    fetchBillingHistory();
  }, []);

  const handleAddNew = async () => {
    try {
      setIsCreatingSetupIntent(true);
      const response = await fetch('/api/advertiser/create-setup-intent', {
        method: 'POST',
        headers: getAuthHeaders()
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create setup intent');
      }

      const data = await response.json();
      setSetupIntentClientSecret(data.client_secret);
      setIsAddCardModalOpen(true);
    } catch (err) {
      console.error('Error creating setup intent:', err);
      alert(err instanceof Error ? err.message : 'Failed to add payment method');
    } finally {
      setIsCreatingSetupIntent(false);
    }
  };

  const handleSetDefault = async (paymentMethodId: string) => {
    try {
      setIsSettingDefault(paymentMethodId);
      const response = await fetch('/api/advertiser/set-default-payment-method', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ payment_method_id: paymentMethodId })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to set default payment method');
      }

      // Refresh payment methods list
      await fetchPaymentMethods();
    } catch (err) {
      console.error('Error setting default payment method:', err);
      alert(err instanceof Error ? err.message : 'Failed to set default payment method');
    } finally {
      setIsSettingDefault(null);
    }
  };

  const formatExpiry = (month: number | null, year: number | null) => {
    if (!month || !year) return 'N/A';
    const monthStr = String(month).padStart(2, '0');
    const yearStr = String(year).slice(-2);
    return `${monthStr}/${yearStr}`;
  };

  const getBrandDisplayName = (brand: string) => {
    const brandMap: { [key: string]: string } = {
      'visa': 'Visa',
      'mastercard': 'Mastercard',
      'amex': 'American Express',
      'discover': 'Discover',
      'jcb': 'JCB',
      'diners': 'Diners Club',
      'unionpay': 'UnionPay'
    };
    return brandMap[brand.toLowerCase()] || brand.charAt(0).toUpperCase() + brand.slice(1);
  };

  const getBrandBadgeText = (brand: string) => {
    const badgeMap: { [key: string]: string } = {
      'visa': 'VISA',
      'mastercard': 'MC',
      'amex': 'AMEX',
      'discover': 'DISC',
      'jcb': 'JCB',
      'diners': 'DC',
      'unionpay': 'UP'
    };
    return badgeMap[brand.toLowerCase()] || brand.slice(0, 4).toUpperCase();
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
  };

  const formatCurrency = (amount: number, currency: string) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  };

  const StatusPill: React.FC<{ status: string }> = ({ status }) => {
    const statusConfig = {
      paid: { bg: 'bg-green-500/10', text: 'text-green-600 dark:text-green-400', label: 'Paid' },
      open: { bg: 'bg-yellow-500/10', text: 'text-yellow-600 dark:text-yellow-400', label: 'Open' },
      draft: { bg: 'bg-gray-500/10', text: 'text-gray-600 dark:text-gray-400', label: 'Draft' },
      failed: { bg: 'bg-red-500/10', text: 'text-red-600 dark:text-red-400', label: 'Failed' },
      uncollectible: { bg: 'bg-red-500/10', text: 'text-red-600 dark:text-red-400', label: 'Failed' }
    };

    const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.open;

    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
        {config.label}
      </span>
    );
  };

  return (
    <div className="flex-1 flex flex-col p-6 md:p-8 max-w-4xl w-full mx-auto min-h-0 overflow-y-auto">
      <header className="flex items-center justify-between mb-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <button 
            onClick={() => onNavigate('dashboard')}
            className="text-text-secondary-light dark:text-text-secondary-dark text-lg md:text-xl font-medium hover:text-text-primary-light dark:hover:text-text-primary-dark transition-colors"
          >
            Advertiser Portal
          </button>
          <span className="text-text-secondary-light dark:text-text-secondary-dark text-lg md:text-xl font-medium">/</span>
          <span className="text-text-primary-light dark:text-text-primary-dark text-lg md:text-xl font-medium">
            Billing
          </span>
        </div>
      </header>

      <div className="space-y-6 flex-1">
        {/* Payment Methods */}
        <section className="bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold flex items-center gap-2 text-text-primary-light dark:text-text-primary-dark">
              <CreditCard className="w-5 h-5 text-primary" />
              Payment Methods
            </h2>
            <button 
              onClick={handleAddNew}
              disabled={isCreatingSetupIntent}
              className="text-sm font-semibold text-primary hover:text-primary/80 flex items-center gap-1 transition-colors disabled:opacity-50"
            >
              <Plus className="w-4 h-4" /> {isCreatingSetupIntent ? 'Loading...' : 'Add New'}
            </button>
          </div>
          
          {isLoading ? (
            <div className="flex items-center justify-center p-8">
              <p className="text-text-secondary-light dark:text-text-secondary-dark">Loading payment methods...</p>
            </div>
          ) : paymentMethods.length === 0 ? (
            <div className="flex items-center justify-center p-8 border border-border-light dark:border-border-dark rounded-lg">
              <p className="text-text-secondary-light dark:text-text-secondary-dark">No payment methods found</p>
            </div>
          ) : (
            <div className="space-y-3">
              {paymentMethods.map((pm) => (
                <div key={pm.id} className="flex items-center justify-between p-4 border border-border-light dark:border-border-dark rounded-lg">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-8 bg-gray-200 dark:bg-gray-700 rounded flex items-center justify-center font-bold text-xs text-gray-500 dark:text-gray-400">
                      {getBrandBadgeText(pm.brand)}
                    </div>
                    <div>
                      <p className="font-medium text-text-primary-light dark:text-text-primary-dark">
                        {getBrandDisplayName(pm.brand)} ending in {pm.last4}
                      </p>
                      <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark">
                        Expiry {formatExpiry(pm.exp_month, pm.exp_year)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {pm.is_default ? (
                      <span className="px-2 py-1 bg-green-500/10 text-green-600 dark:text-green-400 rounded text-xs font-semibold">
                        Default
                      </span>
                    ) : (
                      <button
                        onClick={() => handleSetDefault(pm.id)}
                        disabled={isSettingDefault === pm.id}
                        className="px-3 py-1 text-xs font-semibold text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                      >
                        {isSettingDefault === pm.id ? 'Setting...' : 'Set as default'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Invoices */}
        <section className="bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark overflow-hidden">
          <div className="p-6 border-b border-border-light dark:border-border-dark">
            <h2 className="text-lg font-semibold text-text-primary-light dark:text-text-primary-dark">Billing History</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-white/5 border-b border-border-light dark:border-border-dark text-text-secondary-light dark:text-text-secondary-dark text-xs uppercase font-semibold">
                <tr>
                  <th className="px-6 py-4 text-left">Date</th>
                  <th className="px-6 py-4 text-left">Campaign Name</th>
                  <th className="px-6 py-4 text-right">Amount</th>
                  <th className="px-6 py-4 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-light dark:divide-border-dark">
                {isLoadingHistory ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-8 text-center text-text-secondary-light dark:text-text-secondary-dark">
                      Loading billing history...
                    </td>
                  </tr>
                ) : billingHistory.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-8 text-center text-text-secondary-light dark:text-text-secondary-dark">
                      No billing history found
                    </td>
                  </tr>
                ) : (
                  billingHistory.map((invoice) => (
                    <tr key={invoice.invoiceId} className="hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                      <td className="px-6 py-4 text-left text-text-secondary-light dark:text-text-secondary-dark">
                        {formatDate(invoice.date)}
                      </td>
                      <td className="px-6 py-4 text-left text-text-primary-light dark:text-text-primary-dark">
                        {invoice.campaignName}
                      </td>
                      <td className="px-6 py-4 text-right font-medium text-text-primary-light dark:text-text-primary-dark">
                        {formatCurrency(invoice.amount, invoice.currency)}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <StatusPill status={invoice.status} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="mt-8">
        <Footer onNavigate={onNavigate} />
      </div>

      {isAddCardModalOpen && setupIntentClientSecret && (
        <AddPaymentMethodModal 
          onClose={() => {
            setIsAddCardModalOpen(false);
            setSetupIntentClientSecret(null);
          }}
          onSuccess={() => {
            fetchPaymentMethods();
            setIsAddCardModalOpen(false);
            setSetupIntentClientSecret(null);
          }}
          clientSecret={setupIntentClientSecret}
        />
      )}
    </div>
  );
};

export default BillingPage;