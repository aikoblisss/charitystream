import React, { useState, useEffect } from 'react';
import { CreditCard } from 'lucide-react';
import { Page } from '../types';

interface FooterProps {
  onNavigate: (page: Page) => void;
}

interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  is_default: boolean;
}

function getNextMondayDate(): string {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday, 1 = Monday, ...
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + daysUntilMonday);
  return nextMonday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const Footer: React.FC<FooterProps> = ({ onNavigate }) => {
  const [defaultPaymentMethod, setDefaultPaymentMethod] = useState<PaymentMethod | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('advertiserPortalToken');
    if (!token) {
      setIsLoading(false);
      return;
    }

    fetch('/api/advertiser/payment-methods', {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (!data?.paymentMethods) return;
        const def = (data.paymentMethods as PaymentMethod[]).find((pm) => pm.is_default);
        setDefaultPaymentMethod(def ?? data.paymentMethods[0] ?? null);
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  const cardLabel = defaultPaymentMethod
    ? `${defaultPaymentMethod.brand.charAt(0).toUpperCase()}${defaultPaymentMethod.brand.slice(1)} •••• ${defaultPaymentMethod.last4}`
    : 'No payment method';

  return (
    <footer className="mt-1 pt-2 border-t border-border-light dark:border-border-dark">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-text-secondary-light dark:text-text-secondary-dark">
          <CreditCard className="w-5 h-5 flex-shrink-0" />
          {isLoading ? (
            <div className="h-4 w-28 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
          ) : (
            <span>{cardLabel}</span>
          )}
        </div>
        <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark hidden sm:block">
          Next charge {getNextMondayDate()}
        </p>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('billing');
          }}
          className="font-semibold text-sm text-primary/90 hover:text-primary transition-colors"
        >
          Manage Billing
        </a>
      </div>
    </footer>
  );
};

export default Footer;
