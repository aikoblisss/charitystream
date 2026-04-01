import React from 'react';
import { Megaphone, UserCircle, LayoutDashboard, CreditCard } from 'lucide-react';
import { Page } from '../types';

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

const Sidebar: React.FC<SidebarProps> = ({ currentPage, onNavigate }) => {
  const getLinkClass = (page: Page) => {
    const isActive = currentPage === page;
    const baseClass = "flex items-center gap-3 px-3 py-2 rounded-lg transition-colors w-full text-left";
    return isActive 
      ? `${baseClass} bg-primary/10 text-primary` 
      : `${baseClass} text-text-secondary-light dark:text-text-secondary-dark hover:bg-black/5 dark:hover:bg-white/5`;
  };

  return (
    <aside className="w-64 flex-shrink-0 bg-container-light dark:bg-container-dark border-r border-border-light dark:border-border-dark flex flex-col justify-between h-full px-4 pb-4 pt-6 md:pt-8">
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3 px-2">
          <h1 className="text-base font-semibold text-text-primary-light dark:text-text-primary-dark">Charity Stream</h1>
        </div>
        <nav className="flex flex-col gap-2">
           <button
            onClick={() => onNavigate('dashboard')}
            className={getLinkClass('dashboard')}
          >
            <LayoutDashboard className="w-5 h-5" />
            <span className="text-sm font-semibold">Overview</span>
          </button>
          
          <button
            onClick={() => onNavigate('campaigns')}
            className={getLinkClass('campaigns')}
          >
            <Megaphone className="w-5 h-5" />
            <span className="text-sm font-medium">Campaigns</span>
          </button>

          <button
            onClick={() => onNavigate('billing')}
            className={getLinkClass('billing')}
          >
            <CreditCard className="w-5 h-5" />
            <span className="text-sm font-medium">Billing</span>
          </button>
          
          <button
            onClick={() => onNavigate('account')}
            className={getLinkClass('account')}
          >
            <UserCircle className="w-5 h-5" />
            <span className="text-sm font-medium">Account</span>
          </button>
        </nav>
      </div>
      
      <div className="flex flex-col gap-2" />
    </aside>
  );
};

export default Sidebar;