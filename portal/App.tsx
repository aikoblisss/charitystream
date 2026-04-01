import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import DashboardPage from './components/DashboardPage';
import CampaignsPage from './components/CampaignsPage';
import AccountPage from './components/AccountPage';
import BillingPage from './components/BillingPage';
import IncreaseBudgetModal from './components/IncreaseBudgetModal';
import VideoPlayerModal from './components/VideoPlayerModal';
import CreatePasswordPage from './components/CreatePasswordPage';
import ResetPasswordPage from './components/ResetPasswordPage';
import RequestPasswordResetPage from './components/RequestPasswordResetPage';
import LoginPage from './components/LoginPage';
import ProtectedRoute from './components/ProtectedRoute';
import { DashboardData, Page, CampaignData } from './types';

// Main Dashboard Layout Component (protected routes)
const DashboardLayout: React.FC = () => {
  const navigate = useNavigate();
  const [currentPage, setCurrentPage] = useState<Page>(() => {
    const saved = localStorage.getItem('currentPage');
    return (saved as Page) || 'dashboard';
  });
  
  useEffect(() => {
    localStorage.setItem('currentPage', currentPage);
  }, [currentPage]);
  
  const [isBudgetModalOpen, setIsBudgetModalOpen] = useState(false);
  const [showCreativeModal, setShowCreativeModal] = useState(false);
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [selectedCampaign, setSelectedCampaign] = useState<CampaignData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeCampaignId, setActiveCampaignId] = useState<number | null>(() => {
    const saved = localStorage.getItem('selectedCampaignId');
    return saved ? parseInt(saved, 10) : null;
  });

  const refreshDashboard = React.useCallback(
    async (campaignId: number | null = null) => {
      // CRITICAL: Only use advertiserPortalToken - never check viewer tokens
      const token = localStorage.getItem('advertiserPortalToken');
      if (!token) {
        navigate('/login', { replace: true });
        return;
      }

      try {
        setLoading(true);

        const campaignIdToFetch = campaignId ?? activeCampaignId;
        const url = campaignIdToFetch 
          ? `/api/advertiser/dashboard?campaignId=${campaignIdToFetch}`
          : `/api/advertiser/dashboard`;

        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (!response.ok) {
          throw new Error('Failed to fetch dashboard data');
        }

        const data = await response.json();
        setDashboardData(data);
        
        // Always use the backend's resolved campaignId (handles fallback correctly)
        // The backend returns activeCampaignId which is either:
        // - The requested campaignId if it exists and belongs to the user
        // - The fallback campaignId if the requested one doesn't exist
        // This ensures we use the actual loaded campaign, not a stale requested ID
        if (data.activeCampaignId) {
          setActiveCampaignId(data.activeCampaignId);
          localStorage.setItem('selectedCampaignId', String(data.activeCampaignId));
        } else {
          setActiveCampaignId(null);
          localStorage.removeItem('selectedCampaignId');
        }
        
        setError(null);
      } catch (err) {
        console.error('Error fetching dashboard data:', err);
        setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      } finally {
        setLoading(false);
      }
    },
    [activeCampaignId, navigate]
  );

  // CRITICAL: Only fetch dashboard data when this component is actually mounted
  // This component should ONLY render when on /dashboard route (protected by ProtectedRoute)
  useEffect(() => {
    // Always fetch dashboard data when DashboardLayout mounts
    // This is safe because DashboardLayout only renders on /dashboard route
    refreshDashboard(activeCampaignId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch dashboard when currentPage changes to dashboard
  useEffect(() => {
    if (currentPage === 'dashboard') {
      refreshDashboard(activeCampaignId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage]);

  const handleCampaignSelect = (campaign: CampaignData) => {
    setActiveCampaignId(campaign.id);
    setSelectedCampaign(campaign);
    setCurrentPage('dashboard');
  };

  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-text-secondary-light dark:text-text-secondary-dark">Loading...</p>
        </div>
      );
    }

    if (error || !dashboardData) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-text-secondary-light dark:text-text-secondary-dark">Error: {error || 'Failed to load dashboard'}</p>
        </div>
      );
    }

    switch (currentPage) {
      case 'dashboard':
        return <DashboardPage 
          onOpenBudgetModal={() => setIsBudgetModalOpen(true)} 
          dashboardData={dashboardData} 
          onNavigate={setCurrentPage}
          onViewCreative={() => setShowCreativeModal(true)}
          selectedCampaign={selectedCampaign}
          activeCampaignId={activeCampaignId}
          onRefreshDashboard={refreshDashboard}
        />;
      case 'campaigns':
        return <CampaignsPage 
          campaigns={dashboardData.campaigns} 
          onSelectCampaign={handleCampaignSelect} 
          onNavigate={setCurrentPage} 
          activeCampaignId={activeCampaignId}
          onSetActiveCampaignId={setActiveCampaignId}
        />;
      case 'billing':
        return <BillingPage onNavigate={setCurrentPage} />;
      case 'account':
        return <AccountPage onNavigate={setCurrentPage} />;
      default:
        return <DashboardPage 
          onOpenBudgetModal={() => setIsBudgetModalOpen(true)} 
          dashboardData={dashboardData} 
          onNavigate={setCurrentPage}
          onViewCreative={() => setShowCreativeModal(true)}
          selectedCampaign={selectedCampaign}
          activeCampaignId={activeCampaignId}
          onRefreshDashboard={refreshDashboard}
        />;
    }
  };

  return (
    <div className="flex h-screen w-full bg-background-light dark:bg-background-dark overflow-hidden font-display relative">
      <div className="hidden md:block h-full flex-shrink-0">
        <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />
      </div>

      <main className="flex-1 flex flex-col h-full overflow-hidden relative z-0">
        {renderContent()}
      </main>

      {isBudgetModalOpen && dashboardData && (
        <IncreaseBudgetModal 
          onClose={() => setIsBudgetModalOpen(false)} 
          campaignName={dashboardData.campaignTitle}
          currentBudget={dashboardData.weeklyBudgetCap}
          campaignId={activeCampaignId}
          onSuccess={() => {
            refreshDashboard(activeCampaignId);
          }}
        />
      )}
      {showCreativeModal && (
        <VideoPlayerModal
          isOpen={showCreativeModal}
          videoUrl={dashboardData?.creativeUrl || null}
          onClose={() => setShowCreativeModal(false)}
          adFormat={dashboardData?.adFormat}
        />
      )}
    </div>
  );
};

// Root redirect component - checks auth and redirects accordingly
const RootRedirect: React.FC = () => {
  const token = localStorage.getItem('advertiserPortalToken');
  return <Navigate to={token ? '/dashboard' : '/login'} replace />;
};

const App: React.FC = () => {
  return (
    <Routes>
      {/* Public routes - NO authentication required, NO redirects, NO dashboard fetches */}
      {/* These routes must be defined FIRST to match before wildcard */}
      <Route path="/request-password-reset" element={<RequestPasswordResetPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/create-password" element={<CreatePasswordPage />} />
      <Route path="/login" element={<LoginPage />} />
      
      {/* Protected routes - require advertiser_portal JWT */}
      {/* DashboardLayout ONLY renders here, so dashboard fetch is safe */}
      <Route 
        path="/dashboard" 
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        } 
      />
      
      {/* Default redirects - must be LAST */}
      <Route path="/" element={<RootRedirect />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
};

export default App;
