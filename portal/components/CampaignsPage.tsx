import React, { useState, useMemo, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { Plus, Search, Filter, ArrowUpDown, Calendar, DollarSign, Check, ChevronDown } from 'lucide-react';
import Footer from './Footer';
import { CampaignData, Page } from '../types';

interface CampaignsPageProps {
  campaigns: CampaignData[];
  onSelectCampaign: (campaign: CampaignData) => void;
  onNavigate: (page: Page) => void;
  activeCampaignId?: number | null;
  onSetActiveCampaignId: (campaignId: number) => void;
}

type SortOption = 'newest' | 'oldest' | 'budget-high' | 'budget-low';
type StatusFilter = 'ALL' | 'LIVE' | 'PAUSED' | 'ENDED' | 'IN REVIEW' | 'REJECTED' | 'REVOKED';

const RecipientCell: React.FC<{ recipients: string[] }> = ({ recipients }) => {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (recipients.length === 0) {
    return <span className="text-text-secondary-light dark:text-text-secondary-dark">TBA</span>;
  }

  if (recipients.length === 1) {
    return <span className="text-text-primary-light dark:text-text-primary-dark">{recipients[0]}</span>;
  }

  const [latest, ...rest] = recipients;

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setCoords({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen(o => !o);
  };

  const dropdown = open ? ReactDOM.createPortal(
    <div
      ref={dropdownRef}
      onClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', top: coords.top, left: coords.left, zIndex: 9999 }}
      className="bg-container-light dark:bg-container-dark border border-border-light dark:border-border-dark rounded-lg shadow-xl p-2 min-w-max"
    >
      <p className="text-xs font-semibold text-text-secondary-light dark:text-text-secondary-dark uppercase tracking-wide mb-1 px-1">All Recipients</p>
      {recipients.map((name, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-text-primary-light dark:text-text-primary-dark hover:bg-gray-50 dark:hover:bg-white/5">
          {i === 0 && <span className="text-xs text-primary font-semibold shrink-0">Latest</span>}
          <span>{name}</span>
        </div>
      ))}
    </div>,
    document.body
  ) : null;

  return (
    <div className="inline-flex items-center gap-1.5">
      <span className="text-text-primary-light dark:text-text-primary-dark">{latest}</span>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex items-center gap-0.5 text-xs bg-gray-100 dark:bg-white/10 text-text-secondary-light dark:text-text-secondary-dark px-1.5 py-0.5 rounded font-medium hover:bg-primary/10 hover:text-primary transition-colors"
      >
        +{rest.length}
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {dropdown}
    </div>
  );
};

const CampaignsPage: React.FC<CampaignsPageProps> = ({ campaigns, onSelectCampaign, onNavigate, activeCampaignId, onSetActiveCampaignId }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>('newest');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');

  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const currencyWithDecimals = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Filter and Sort Logic
  const filteredCampaigns = useMemo(() => {
    let result = [...campaigns];

    // 1. Filter by Search Query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(c =>
        (c.campaignName || '').toLowerCase().includes(query) ||
        (c.recipients || []).some(r => r.toLowerCase().includes(query))
      );
    }

    // 2. Filter by Status
    if (statusFilter !== 'ALL') {
      result = result.filter(c => c.status === statusFilter);
    }

    // 3. Sort
    result.sort((a, b) => {
      switch (sortBy) {
        case 'newest':
          if (!a.startDate && !b.startDate) return 0;
          if (!a.startDate) return 1;
          if (!b.startDate) return -1;
          return new Date(b.startDate).getTime() - new Date(a.startDate).getTime();
        case 'oldest':
          if (!a.startDate && !b.startDate) return 0;
          if (!a.startDate) return 1;
          if (!b.startDate) return -1;
          return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
        case 'budget-high':
          return b.budget - a.budget;
        case 'budget-low':
          return a.budget - b.budget;
        default:
          return 0;
      }
    });

    return result;
  }, [searchQuery, statusFilter, sortBy]);

  return (
    <div className="flex-1 flex flex-col p-6 md:p-8 max-w-7xl w-full mx-auto min-h-0 overflow-y-auto" onClick={() => isFilterOpen && setIsFilterOpen(false)}>
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
            Campaigns
          </span>
        </div>
        <button
          onClick={() => window.open('/advertiser.html?autoStart=true', '_blank')}
          className="flex items-center gap-2 bg-primary hover:bg-primary/90 text-white px-4 py-2 rounded-lg font-semibold transition-colors"
        >
          <Plus className="w-5 h-5" />
          <span>New Campaign</span>
        </button>
      </header>

      {/* Search and Filter Bar */}
      <div className="flex items-center gap-4 mb-6 z-20 relative">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary-light dark:text-text-secondary-dark" />
          <input 
            type="text" 
            placeholder="Search campaigns or recipients..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-lg bg-container-light dark:bg-container-dark border border-border-light dark:border-border-dark focus:outline-none focus:ring-2 focus:ring-primary/50 text-text-primary-light dark:text-text-primary-dark transition-all"
          />
        </div>
        
        <div className="relative">
          <button 
            onClick={(e) => {
              e.stopPropagation();
              setIsFilterOpen(!isFilterOpen);
            }}
            className={`flex items-center gap-2 px-4 py-2 border rounded-lg font-medium transition-colors ${isFilterOpen ? 'bg-primary/10 border-primary text-primary' : 'bg-container-light dark:bg-container-dark border-border-light dark:border-border-dark hover:bg-black/5 dark:hover:bg-white/5'}`}
          >
            <Filter className="w-4 h-4" />
            <span>Filter & Sort</span>
          </button>

          {/* Filter Dropdown Menu */}
          {isFilterOpen && (
            <div 
              onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-full mt-2 w-64 bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark shadow-xl z-50 p-4 animate-in fade-in zoom-in-95 duration-100"
            >
              {/* Sort Section */}
              <div className="mb-4">
                <h3 className="text-xs font-semibold text-text-secondary-light dark:text-text-secondary-dark uppercase mb-2">Sort By</h3>
                <div className="space-y-1">
                  {[
                    { id: 'newest', label: 'Newest First', icon: Calendar },
                    { id: 'oldest', label: 'Oldest First', icon: Calendar },
                    { id: 'budget-high', label: 'Budget: High to Low', icon: DollarSign },
                    { id: 'budget-low', label: 'Budget: Low to High', icon: DollarSign },
                  ].map((option) => (
                    <button
                      key={option.id}
                      onClick={() => setSortBy(option.id as SortOption)}
                      className={`w-full flex items-center justify-between px-2 py-1.5 rounded-md text-sm transition-colors ${sortBy === option.id ? 'bg-primary/10 text-primary font-medium' : 'text-text-primary-light dark:text-text-primary-dark hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                    >
                      <span className="flex items-center gap-2">
                        <option.icon className="w-3.5 h-3.5" />
                        {option.label}
                      </span>
                      {sortBy === option.id && <Check className="w-3.5 h-3.5" />}
                    </button>
                  ))}
                </div>
              </div>

              <hr className="border-border-light dark:border-border-dark mb-4" />

              {/* Status Filter Section */}
              <div>
                <h3 className="text-xs font-semibold text-text-secondary-light dark:text-text-secondary-dark uppercase mb-2">Status</h3>
                <div className="grid grid-cols-2 gap-2">
                  {['ALL', 'LIVE', 'PAUSED', 'ENDED', 'IN REVIEW', 'REJECTED', 'REVOKED'].map((status) => (
                    <button
                      key={status}
                      onClick={() => setStatusFilter(status as StatusFilter)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                        statusFilter === status 
                          ? 'bg-primary text-white border-primary' 
                          : 'bg-transparent border-border-light dark:border-border-dark text-text-secondary-light dark:text-text-secondary-dark hover:border-primary/50'
                      }`}
                    >
                      {status.charAt(0) + status.slice(1).toLowerCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Campaigns Table */}
      <div className="flex-1 bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark overflow-hidden mb-6 flex flex-col">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-gray-50 dark:bg-white/5 border-b border-border-light dark:border-border-dark text-text-secondary-light dark:text-text-secondary-dark text-xs uppercase font-semibold">
              <tr>
                <th className="px-6 py-4">Campaign Name</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4 cursor-pointer hover:text-primary transition-colors group" onClick={() => setSortBy(sortBy === 'budget-high' ? 'budget-low' : 'budget-high')}>
                  <div className="flex items-center gap-1">
                    Budget
                    <ArrowUpDown className="w-3 h-3 opacity-0 group-hover:opacity-100" />
                  </div>
                </th>
                <th className="px-6 py-4">Spent</th>
                <th className="px-6 py-4">Recipient(s)</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-light dark:divide-border-dark">
              {filteredCampaigns.length > 0 ? (
                filteredCampaigns.map((camp) => (
                  <tr 
                    key={camp.id} 
                    className={`hover:bg-gray-50 dark:hover:bg-white/5 transition-colors group cursor-pointer ${
                      camp.id === activeCampaignId ? 'bg-muted/60 dark:bg-muted/60' : ''
                    }`}
                    onClick={() => {
                      onSetActiveCampaignId(camp.id);
                      localStorage.setItem('selectedCampaignId', String(camp.id));
                      onSelectCampaign(camp);
                    }}
                  >
                    <td className="px-6 py-4">
                      <p className="font-semibold text-text-primary-light dark:text-text-primary-dark">{camp.campaignName || 'Untitled Campaign'}</p>
                      {camp.startDate && (
                        <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark">Started {camp.startDate}</p>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                        ${camp.status === 'LIVE' ? 'bg-primary/10 text-primary' : 
                          camp.status === 'APPROVED' ? 'bg-blue-500/10 text-blue-500' :
                          camp.status === 'CAPPED' ? 'bg-orange-500/10 text-orange-600 dark:text-orange-400' :
                          camp.status === 'PAUSED' ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400' :
                          camp.status === 'ENDED' ? 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400' :
                          camp.status === 'REJECTED' ? 'bg-red-500/10 text-red-600 dark:text-red-400' :
                          camp.status === 'REVOKED' ? 'bg-red-500/10 text-red-600 dark:text-red-400' :
                          'bg-purple-500/10 text-purple-600 dark:text-purple-400'}`}>
                        {camp.status === 'APPROVED' && camp.startDate
                          ? `APPROVED — Starting ${camp.startDate}`
                          : camp.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 font-medium text-text-primary-light dark:text-text-primary-dark">
                      {currency.format(camp.budget)}
                    </td>
                    <td className="px-6 py-4 text-text-secondary-light dark:text-text-secondary-dark">
                      {currencyWithDecimals.format(camp.spent)}
                    </td>
                    <td className="px-6 py-4">
                      <RecipientCell recipients={camp.recipients || []} />
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button 
                        onClick={(e) => {
                          e.stopPropagation(); // Prevent double triggering if row has click
                          onSetActiveCampaignId(camp.id);
                          localStorage.setItem('selectedCampaignId', String(camp.id));
                          onSelectCampaign(camp);
                        }}
                        className="text-primary hover:text-primary/80 text-sm font-semibold opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        Manage
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-text-secondary-light dark:text-text-secondary-dark">
                    <p>No campaigns found matching your criteria.</p>
                    <button 
                      onClick={() => { setSearchQuery(''); setStatusFilter('ALL'); }}
                      className="mt-2 text-primary hover:underline text-sm font-medium"
                    >
                      Clear filters
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Footer onNavigate={onNavigate} />
    </div>
  );
};

export default CampaignsPage;