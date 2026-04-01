export interface Donor {
  id: number;
  name: string;
  amount: number;
  avatarUrl?: string; // Optional since we're removing images
  rank: number;
  isOwned?: boolean; // Whether this campaign belongs to the logged-in advertiser
}

export interface Recipient {
  name: string;
  description: string;
  logoUrl: string;
}

export interface CampaignStats {
  views: number;
  spent: number;
  totalBudget: number;
  cpm: number;
  weeklyDonations: number;
  weeklyGoal: number;
  lastUpdated: string;
}

export interface Campaign {
  id: string;
  name: string;
  type: string;
  status: 'LIVE' | 'PAUSED' | 'ENDED' | 'IN REVIEW' | 'REJECTED' | 'REVOKED' | 'CAPPED';
  startDate: string;
  stats: CampaignStats;
  recipient: Recipient;
  creative: {
    imageUrl: string;
  };
}

export type Page = 'dashboard' | 'campaigns' | 'billing' | 'account';

export interface DashboardData {
  activeCampaignId?: number;
  status: 'IN REVIEW' | 'LIVE' | 'PAUSED' | 'ENDED' | 'REJECTED' | 'REVOKED' | 'CAPPED';
  campaignTitle: string;
  campaignName: string | null;
  companyName: string | null;
  totalImpressions: number | null;
  currentWeekImpressions: number | null;
  cpmRate: number;
  weeklyBudgetCap: number;
  totalSpent: number | null;
  donationsThisWeek: number | null;
  remainingBudget: number | null;
  creativeUrl: string | null;
  recurringWeekly: boolean;
  billingFailed?: boolean;
  adFormat?: string; // 'video' or 'image'/'static_image'
  clickTracking?: boolean;
  totalClicks?: number | null;
  campaigns: CampaignData[];
  weeklyRecipient?: string | null;
}

export interface CampaignData {
  id: number;
  campaignName: string | null;
  startDate: string | null;
  status: 'LIVE' | 'PAUSED' | 'ENDED' | 'IN REVIEW' | 'REJECTED' | 'REVOKED' | 'CAPPED';
  budget: number;
  spent: number;
  recipients: string[];
}