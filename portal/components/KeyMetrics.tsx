import React from 'react';
import { DashboardData, Recipient } from '../types';

interface KeyMetricsProps {
  dashboardData: DashboardData;
  recipient?: Recipient;
}

const KeyMetrics: React.FC<KeyMetricsProps> = ({ dashboardData, recipient }) => {
  const showWeeklyRecipient =
    (dashboardData.status === 'LIVE' || dashboardData.status === 'CAPPED') &&
    dashboardData.weeklyRecipient;
  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const currencyWithDecimals = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Calculate metrics from dashboard data
  const delivery = dashboardData.totalImpressions ?? 0;
  const totalSpent = dashboardData.totalSpent ?? 0;
  const donationsThisWeek = dashboardData.donationsThisWeek ?? 0;
  
  // Format numbers - show "—" if null
  const formatValue = (value: number | null) => {
    if (value === null) return '—';
    return value.toLocaleString();
  };

  const formatCurrency = (value: number | null) => {
    if (value === null) return '—';
    return currency.format(value);
  };

  // Format spent values with cents (two decimal places)
  const formatSpentCurrency = (value: number | null) => {
    if (value === null) return '—';
    return currencyWithDecimals.format(value);
  };

  const cardBaseClass = "p-3 bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark flex flex-col h-full";
  const titleClass = "text-sm font-medium text-text-secondary-light dark:text-text-secondary-dark mb-1";
  const metricClass = "text-2xl font-bold text-text-primary-light dark:text-text-primary-dark leading-none";
  const captionClass = "text-xs text-text-secondary-light dark:text-text-secondary-dark mt-auto pt-1";

  return (
    <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2 mb-2">
      {/* Delivery */}
      <div className={cardBaseClass}>
        <p className={titleClass}>Delivery</p>
        {dashboardData.clickTracking ? (
          <div className="flex gap-4 mt-auto">
            <div>
              <p className={metricClass}>{formatValue(dashboardData.totalImpressions)}</p>
              <p className={captionClass}>Total Impressions</p>
            </div>
            <div>
              <p className={metricClass}>{formatValue(dashboardData.totalClicks ?? null)}</p>
              <p className={captionClass}>Total Clicks</p>
            </div>
          </div>
        ) : (
          <>
            <p className={metricClass}>
              {formatValue(dashboardData.totalImpressions)}
            </p>
            <p className={captionClass}>
              Total Impressions
            </p>
          </>
        )}
      </div>

      {/* Total Spent */}
      <div className={cardBaseClass}>
        <p className={titleClass}>Total Spent</p>
        <p className={metricClass}>
          {formatSpentCurrency(dashboardData.totalSpent)}
        </p>
        <p className={captionClass}>
          {dashboardData.remainingBudget !== null ? `Remaining this week: ${formatSpentCurrency(dashboardData.remainingBudget)}` : '—'}
        </p>
      </div>

      {/* Donations */}
      <div className={`${cardBaseClass} bg-primary/5 dark:bg-primary/5`}>
        <p className={titleClass}>Your Donations This Week</p>
        <p className="text-2xl font-bold text-text-primary-light dark:text-text-primary-dark leading-none">
          {formatSpentCurrency(dashboardData.donationsThisWeek)}
        </p>
        <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark mt-auto pt-1">
          Based on {formatValue(dashboardData.currentWeekImpressions)} impressions this week
        </p>
      </div>

      {/* Recipient */}
      {recipient ? (
        <div className={cardBaseClass}>
          <p className={titleClass}>This Week's Recipient</p>
          <div className="flex items-center gap-3">
            <img 
              className="size-8 rounded-full object-cover ring-1 ring-border-light dark:ring-border-dark" 
              alt={`${recipient.name} logo`} 
              src={recipient.logoUrl} 
            />
            <p className="text-lg font-bold text-text-primary-light dark:text-text-primary-dark truncate leading-none">
              {recipient.name}
            </p>
          </div>
          <p className={captionClass}>
            {recipient.description}
          </p>
        </div>
      ) : showWeeklyRecipient ? (
        <div className={cardBaseClass}>
          <p className={titleClass}>This Week's Recipient</p>
          <p className="text-lg font-bold text-text-primary-light dark:text-text-primary-dark truncate leading-none">
            {dashboardData.weeklyRecipient}
          </p>
        </div>
      ) : (
        <div className={cardBaseClass}>
          <p className={titleClass}>This Week's Recipient</p>
          <p className="text-lg font-bold text-text-primary-light dark:text-text-primary-dark leading-none">
            To Be Announced
          </p>
          <p className={captionClass}>
            Donations go to the first charity to sign up on Charity Stream
          </p>
        </div>
      )}
    </section>
  );
};

export default KeyMetrics;