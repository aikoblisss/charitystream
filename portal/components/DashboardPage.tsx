import React, { useState, useEffect } from 'react';
import CampaignHeader from './CampaignHeader';
import KeyMetrics from './KeyMetrics';
import BudgetAndCreative from './BudgetAndCreative';
import DonorTicker from './DonorTicker';
import Footer from './Footer';
import { DashboardData, Page, CampaignData, Donor } from '../types';

interface DashboardPageProps {
  onOpenBudgetModal: () => void;
  dashboardData: DashboardData;
  onNavigate: (page: Page) => void;
  onViewCreative: () => void;
  selectedCampaign?: CampaignData | null;
  activeCampaignId?: number | null;
  onRefreshDashboard: (campaignId: number | null) => Promise<void>;
}

const DashboardPage: React.FC<DashboardPageProps> = ({ onOpenBudgetModal, dashboardData, onNavigate, onViewCreative, selectedCampaign, activeCampaignId, onRefreshDashboard }) => {
  const activeStatus = selectedCampaign?.status ?? dashboardData.status;
  const activeCampaignTitle = selectedCampaign?.campaignName ?? dashboardData.campaignTitle;
  const isUnderReview = activeStatus === 'IN REVIEW';
  const isRejected = activeStatus === 'REJECTED';
  const isEnded = activeStatus === 'ENDED';
  const isRevoked = activeStatus === 'REVOKED';
  const [leaderboardData, setLeaderboardData] = useState<Donor[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);

  // Fetch leaderboard data
  useEffect(() => {
    const fetchLeaderboard = async () => {
      try {
        const token = localStorage.getItem('advertiserPortalToken');
        if (!token) {
          setLeaderboardLoading(false);
          return;
        }

        const response = await fetch('/api/advertiser/leaderboard', {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (!response.ok) {
          console.error('Failed to fetch leaderboard data');
          setLeaderboardLoading(false);
          return;
        }

        const data = await response.json();
        
        // Convert leaderboard data to Donor format
        const donors: Donor[] = data.leaderboard.map((item: any) => ({
          id: item.id,
          name: item.campaignName || 'Unnamed Campaign',
          amount: item.weeklySpend,
          rank: item.rank,
          isOwned: item.isOwned
        }));

        // Fill remaining slots with placeholders if needed
        while (donors.length < 4) {
          donors.push({
            id: -donors.length, // Negative ID for placeholders
            name: 'Claim this spot!',
            amount: 0,
            rank: donors.length + 1,
            isOwned: false
          });
        }

        setLeaderboardData(donors);
      } catch (error) {
        console.error('Error fetching leaderboard:', error);
      } finally {
        setLeaderboardLoading(false);
      }
    };

    if (!isUnderReview && !isRejected && !isRevoked) {
      fetchLeaderboard();
    } else {
      setLeaderboardLoading(false);
    }
  }, [isUnderReview, isRejected, isRevoked]);

  return (
    <div className="flex-1 flex flex-col h-full p-3 md:p-4 max-w-7xl w-full mx-auto min-h-0 pb-4">
      {/* Breadcrumb Header */}
      <header className="flex items-center justify-between mb-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          <button 
            onClick={() => onNavigate('dashboard')}
            className="text-text-secondary-light dark:text-text-secondary-dark text-base md:text-lg font-medium hover:text-text-primary-light dark:hover:text-text-primary-dark transition-colors"
          >
            Advertiser Portal
          </button>
          <span className="text-text-secondary-light dark:text-text-secondary-dark text-base md:text-lg font-medium">/</span>
          <span className="text-text-primary-light dark:text-text-primary-dark text-base md:text-lg font-medium">
            Campaign Dashboard
          </span>
        </div>
      </header>

      {/* Content Container */}
      <div className="flex-1 flex flex-col gap-3 min-h-0">
        <div className="flex-shrink-0">
          <CampaignHeader 
            dashboardData={dashboardData} 
            onIncreaseBudget={onOpenBudgetModal}
            activeStatus={activeStatus}
            activeCampaignTitle={activeCampaignTitle}
            activeCampaignId={activeCampaignId}
            onRefreshDashboard={onRefreshDashboard}
          />
        </div>
        
        {isUnderReview ? (
          /* Under Review Message */
          <div className="flex-1 flex items-center justify-center">
            <p className="text-text-secondary-light dark:text-text-secondary-dark font-medium text-center">
              Your campaign is currently under review.
            </p>
          </div>
        ) : isRejected ? (
          /* Rejected Message */
          <div className="flex-1 flex items-center justify-center">
            <p className="text-text-secondary-light dark:text-text-secondary-dark font-medium text-center">
              This campaign has been rejected.
            </p>
          </div>
        ) : isRevoked ? (
          /* Revoked Campaign - Show nothing below header */
          null
        ) : (
          /* Live Campaign Content */
          <>
            <div className="flex-shrink-0">
              <KeyMetrics dashboardData={dashboardData} />
            </div>
            
            <div className="flex-shrink-0">
              <BudgetAndCreative 
                dashboardData={dashboardData} 
                onViewCreative={onViewCreative}
                activeCampaignId={activeCampaignId}
                onRefreshDashboard={onRefreshDashboard}
              />
            </div>
            
            {/* This Week's Top Donors card */}
            <div className="flex-shrink-0 min-h-[150px]">
              <DonorTicker donors={leaderboardLoading ? [] : leaderboardData} />
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 pt-1">
         <Footer onNavigate={onNavigate} />
      </div>
    </div>
  );
};

export default DashboardPage;