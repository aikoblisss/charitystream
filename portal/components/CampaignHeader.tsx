import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { DashboardData } from '../types';

interface CampaignHeaderProps {
  dashboardData: DashboardData;
  onIncreaseBudget: () => void;
  activeStatus?: string;
  activeCampaignTitle?: string;
  activeCampaignId?: number | null;
  onRefreshDashboard: (campaignId: number | null) => Promise<void>;
}

const CampaignHeader: React.FC<CampaignHeaderProps> = ({ dashboardData, onIncreaseBudget, activeStatus, activeCampaignTitle, activeCampaignId, onRefreshDashboard }) => {
  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const currencyCpm = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  const status = activeStatus ?? dashboardData.status;
  const campaignTitle = activeCampaignTitle ?? dashboardData.campaignTitle;
  const isUnderReview = status === 'IN REVIEW';
  const isRejected = status === 'REJECTED';
  const isPaused = status === 'PAUSED';
  const isEnded = status === 'ENDED';
  const isRevoked = status === 'REVOKED';
  const isRecurring = dashboardData.recurringWeekly === true;
  const isBillingFailed = dashboardData.billingFailed === true;

  const [showPauseModal, setShowPauseModal] = useState(false);
  const [showUnpauseModal, setShowUnpauseModal] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [showRevokeModal, setShowRevokeModal] = useState(false);
  const [showSwitchToRecurringModal, setShowSwitchToRecurringModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const getAuthHeaders = () => {
    const token = localStorage.getItem('advertiserPortalToken');
    return token
      ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
  };

  const handlePauseConfirm = async () => {
    try {
      setIsSubmitting(true);
      const campaignId = activeCampaignId;
      if (!campaignId) {
        throw new Error('No campaign selected');
      }
      const response = await fetch(`/api/advertiser/pause?campaignId=${campaignId}`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!response.ok) {
        throw new Error('Failed to pause campaign');
      }
      // Refresh dashboard with the same campaignId
      await onRefreshDashboard(campaignId);
    } catch (err) {
      console.error('Error pausing campaign', err);
      alert('Failed to pause campaign. Please try again.');
    } finally {
      setIsSubmitting(false);
      setShowPauseModal(false);
    }
  };

  const handleUnpauseConfirm = async () => {
    try {
      setIsSubmitting(true);
      const campaignId = activeCampaignId;
      if (!campaignId) {
        throw new Error('No campaign selected');
      }
      const response = await fetch(`/api/advertiser/unpause?campaignId=${campaignId}`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!response.ok) {
        throw new Error('Failed to unpause campaign');
      }
      // Refresh dashboard with the same campaignId
      await onRefreshDashboard(campaignId);
    } catch (err) {
      console.error('Error unpausing campaign', err);
      alert('Failed to unpause campaign. Please try again.');
    } finally {
      setIsSubmitting(false);
      setShowUnpauseModal(false);
    }
  };

  const handleEndConfirm = async () => {
    try {
      setIsSubmitting(true);
      const campaignId = activeCampaignId;
      if (!campaignId) {
        throw new Error('No campaign selected');
      }
      const response = await fetch(`/api/advertiser/end?campaignId=${campaignId}`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!response.ok) {
        throw new Error('Failed to end campaign');
      }
      // Refresh dashboard with the same campaignId
      await onRefreshDashboard(campaignId);
    } catch (err) {
      console.error('Error ending campaign', err);
      alert('Failed to end campaign. Please try again.');
    } finally {
      setIsSubmitting(false);
      setShowEndModal(false);
    }
  };

  const handleRevokeConfirm = async () => {
    try {
      setIsSubmitting(true);
      const campaignId = activeCampaignId;
      if (!campaignId) {
        throw new Error('No campaign selected');
      }
      const response = await fetch(`/api/advertiser/revoke?campaignId=${campaignId}`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to revoke campaign');
      }
      // Refresh dashboard with the same campaignId
      await onRefreshDashboard(campaignId);
    } catch (err) {
      console.error('Error revoking campaign', err);
      alert(err instanceof Error ? err.message : 'Failed to revoke campaign. Please try again.');
    } finally {
      setIsSubmitting(false);
      setShowRevokeModal(false);
    }
  };

  const handleSwitchToRecurringConfirm = async () => {
    try {
      setIsSubmitting(true);
      const campaignId = activeCampaignId;
      if (!campaignId) {
        throw new Error('No campaign selected');
      }
      const response = await fetch(`/api/advertiser/switch-to-recurring?campaignId=${campaignId}`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to switch campaign to recurring');
      }
      // Refresh dashboard with the same campaignId
      await onRefreshDashboard(campaignId);
    } catch (err) {
      console.error('Error switching campaign to recurring:', err);
      alert(err instanceof Error ? err.message : 'Failed to switch campaign to recurring. Please try again.');
    } finally {
      setIsSubmitting(false);
      setShowSwitchToRecurringModal(false);
    }
  };

  // Determine status badge
  const getStatusBadge = () => {
    switch (status) {
      case 'LIVE':
        return (
          <span className="flex items-center gap-1.5 bg-primary/10 text-primary text-xs font-semibold px-2 py-1 rounded-full">
            <span className="size-2 bg-primary rounded-full"></span>
            LIVE
          </span>
        );
      case 'CAPPED':
        return (
          <span className="flex items-center gap-1.5 bg-orange-500/10 text-orange-600 dark:text-orange-400 text-xs font-semibold px-2 py-1 rounded-full">
            <span className="size-2 bg-orange-500 rounded-full"></span>
            CAPPED
          </span>
        );
      case 'IN REVIEW':
        return (
          <span className="flex items-center gap-1.5 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 text-xs font-semibold px-2 py-1 rounded-full">
            <span className="size-2 bg-yellow-500 rounded-full"></span>
            UNDER REVIEW
          </span>
        );
      case 'PAUSED':
        return (
          <span className="flex items-center gap-1.5 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 text-xs font-semibold px-2 py-1 rounded-full">
            <span className="size-2 bg-yellow-500 rounded-full"></span>
            PAUSED
          </span>
        );
      case 'ENDED':
        return (
          <span className="flex items-center gap-1.5 bg-gray-500/10 text-gray-600 dark:text-gray-400 text-xs font-semibold px-2 py-1 rounded-full">
            <span className="size-2 bg-gray-500 rounded-full"></span>
            ENDED
          </span>
        );
      case 'REJECTED':
        return (
          <span className="flex items-center gap-1.5 bg-red-500/10 text-red-600 dark:text-red-400 text-xs font-semibold px-2 py-1 rounded-full">
            <span className="size-2 bg-red-500 rounded-full"></span>
            REJECTED
          </span>
        );
      case 'REVOKED':
        return (
          <span className="flex items-center gap-1.5 bg-red-500/10 text-red-600 dark:text-red-400 text-xs font-semibold px-2 py-1 rounded-full">
            <span className="size-2 bg-red-500 rounded-full"></span>
            REVOKED
          </span>
        );
      case 'APPROVED':
        return (
          <span className="flex items-center gap-1.5 bg-blue-500/10 text-blue-500 text-xs font-semibold px-2 py-1 rounded-full">
            <span className="size-2 bg-blue-500 rounded-full"></span>
            APPROVED
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <section className="mb-2 p-4 bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            {getStatusBadge()}
            <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark">
              CPM {currencyCpm.format(dashboardData.cpmRate)} • Budget {currency.format(dashboardData.weeklyBudgetCap).replace('.00', '')}
            </p>
          </div>
          <h2 className="text-xl font-bold text-text-primary-light dark:text-text-primary-dark">{campaignTitle}</h2>
          {dashboardData.companyName && (
            <p className="text-text-secondary-light dark:text-text-secondary-dark mt-0.5">{dashboardData.companyName}</p>
          )}
        </div>

        {isEnded || isRevoked || isRejected ? (
          /* ENDED/REVOKED/REJECTED campaigns - only Start New Campaign button */
          <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
            <button
              onClick={() => {
                window.open('/advertiser.html?autoStart=true', '_blank');
              }}
              className="flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-9 px-3 bg-primary hover:bg-primary/90 text-white gap-1.5 text-sm font-semibold transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span className="truncate">Start New Campaign</span>
            </button>
          </div>
        ) : isUnderReview ? (
          /* Revoke Campaign Button for IN REVIEW */
          <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
            <button
              onClick={() => setShowRevokeModal(true)}
              className="flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-9 px-3 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition-colors"
            >
              Revoke Campaign
            </button>
          </div>
        ) : (
          /* Action Buttons for LIVE/PAUSED campaigns */
          <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
            {/* For PAUSED campaigns: show Unpause (only if not billing failed) and End Campaign */}
            {isPaused ? (
              <>
                {!isBillingFailed && (
                  <button
                    onClick={() => setShowUnpauseModal(true)}
                    className="flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-9 px-3 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-text-primary-light dark:text-text-primary-dark text-sm font-semibold transition-colors"
                  >
                    Unpause
                  </button>
                )}
                <button
                  onClick={() => setShowEndModal(true)}
                  className="flex min-w-[110px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-9 px-3 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition-colors"
                >
                  End Campaign
                </button>
                <button
                  onClick={() => {
                    window.open('/advertiser.html?autoStart=true', '_blank');
                  }}
                  className="flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-9 px-3 bg-primary hover:bg-primary/90 text-white gap-1.5 text-sm font-semibold transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  <span className="truncate">Start New Campaign</span>
                </button>
              </>
            ) : (
              /* For LIVE campaigns: different buttons for recurring vs non-recurring */
              <>
                {isRecurring ? (
                  /* Recurring campaigns: show Pause button */
                  <>
                    <button
                      onClick={() => setShowPauseModal(true)}
                      className="flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-9 px-3 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-text-primary-light dark:text-text-primary-dark text-sm font-semibold transition-colors"
                    >
                      Pause
                    </button>
                    <button 
                      onClick={onIncreaseBudget}
                      className="flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-9 px-3 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-text-primary-light dark:text-text-primary-dark text-sm font-semibold transition-colors"
                    >
                      Increase Budget
                    </button>
                    <button
                      onClick={() => {
                        window.open('/advertiser.html?autoStart=true', '_blank');
                      }}
                      className="flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-9 px-3 bg-primary hover:bg-primary/90 text-white gap-1.5 text-sm font-semibold transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      <span className="truncate">Start New Campaign</span>
                    </button>
                  </>
                ) : (
                  /* Non-recurring campaigns: show End Campaign instead of Pause */
                  <>
                    <button
                      onClick={() => setShowEndModal(true)}
                      className="flex min-w-[110px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-9 px-3 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition-colors"
                    >
                      End Campaign
                    </button>
                    <button 
                      onClick={onIncreaseBudget}
                      className="flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-9 px-3 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-text-primary-light dark:text-text-primary-dark text-sm font-semibold transition-colors"
                    >
                      Increase Budget
                    </button>
                    <button 
                      onClick={() => setShowSwitchToRecurringModal(true)}
                      className="flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-9 px-3 border border-border-light dark:border-border-dark hover:bg-gray-100 dark:hover:bg-gray-800 text-text-primary-light dark:text-text-primary-dark text-sm font-semibold transition-colors"
                    >
                      Switch to Recurring
                    </button>
                    <button
                      onClick={() => {
                        window.open('/advertiser.html?autoStart=true', '_blank');
                      }}
                      className="flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-9 px-3 bg-primary hover:bg-primary/90 text-white gap-1.5 text-sm font-semibold transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      <span className="truncate">Start New Campaign</span>
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Pause Confirmation Modal */}
      {showPauseModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-text-primary-light dark:text-text-primary-dark mb-2">
              Pause Campaign?
            </h3>
            <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark mb-4">
              Pausing your campaign will stop billing and remove your ad from the video loop. You can unpause at any time to resume delivery.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowPauseModal(false)}
                className="px-3 py-2 rounded-lg text-sm font-medium text-text-primary-light dark:text-text-primary-dark bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                onClick={handlePauseConfirm}
                className="px-3 py-2 rounded-lg text-sm font-semibold bg-gray-900 text-white hover:bg-black disabled:opacity-70"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Pausing...' : 'Pause Campaign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unpause Confirmation Modal */}
      {showUnpauseModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-text-primary-light dark:text-text-primary-dark mb-2">
              Unpause Campaign?
            </h3>
            <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark mb-4">
              Unpausing will resume delivery of your ad and billing according to your CPM and weekly budget.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowUnpauseModal(false)}
                className="px-3 py-2 rounded-lg text-sm font-medium text-text-primary-light dark:text-text-primary-dark bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                onClick={handleUnpauseConfirm}
                className="px-3 py-2 rounded-lg text-sm font-semibold bg-primary hover:bg-primary/90 text-white disabled:opacity-70"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Unpausing...' : 'Unpause Campaign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* End Campaign Confirmation Modal */}
      {showEndModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-text-primary-light dark:text-text-primary-dark mb-2">
              End Campaign?
            </h3>
            <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark mb-4">
              Ending your campaign will permanently stop delivery, archive your video, and mark this campaign as ENDED. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowEndModal(false)}
                className="px-3 py-2 rounded-lg text-sm font-medium text-text-primary-light dark:text-text-primary-dark bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                onClick={handleEndConfirm}
                className="px-3 py-2 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-70"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Ending...' : 'End Campaign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Revoke Campaign Confirmation Modal */}
      {showRevokeModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-text-primary-light dark:text-text-primary-dark mb-2">
              Revoke Campaign?
            </h3>
            <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark mb-4">
              Revoking your campaign will permanently cancel it before approval. If your campaign has accrued any impressions, you will be billed for them. You will need to submit a new campaign to continue advertising. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowRevokeModal(false)}
                className="px-3 py-2 rounded-lg text-sm font-medium text-text-primary-light dark:text-text-primary-dark bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                onClick={handleRevokeConfirm}
                className="px-3 py-2 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-70"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Revoking...' : 'Revoke Campaign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Switch to Recurring Confirmation Modal */}
      {showSwitchToRecurringModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-text-primary-light dark:text-text-primary-dark mb-2">
              Switch to Recurring?
            </h3>
            <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark mb-4">
              Are you sure you want to switch this campaign to recurring? This campaign will be billed weekly going forward.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSwitchToRecurringModal(false)}
                className="px-3 py-2 rounded-lg text-sm font-medium text-text-primary-light dark:text-text-primary-dark bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                onClick={handleSwitchToRecurringConfirm}
                className="px-3 py-2 rounded-lg text-sm font-semibold bg-primary hover:bg-primary/90 text-white disabled:opacity-70"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Switching...' : 'Switch to Recurring'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default CampaignHeader;