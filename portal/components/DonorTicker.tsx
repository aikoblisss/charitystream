import React from 'react';
import { Donor } from '../types';

interface DonorTickerProps {
  donors: Donor[];
}

const DonorTicker: React.FC<DonorTickerProps> = ({ donors }) => {
  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  // Get emoji or rank label for display
  const getRankDisplay = (rank: number, isPlaceholder: boolean) => {
    if (isPlaceholder) return null;
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    if (rank === 4) return '4th';
    return null;
  };

  // Ensure we have exactly 4 slots (fill with placeholders if needed)
  const displayDonors = [...donors];
  while (displayDonors.length < 4) {
    displayDonors.push({
      id: -displayDonors.length,
      name: 'Claim this spot!',
      amount: 0,
      rank: displayDonors.length + 1,
      isOwned: false
    });
  }

  return (
    <section className="flex flex-col bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark overflow-hidden">
      <div className="p-2 py-4 flex flex-col justify-center">
        <h3 className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark mb-1 flex-shrink-0">
          This Week's Top Donors
        </h3>
        
        <div className="flex-1 grid grid-cols-4 gap-1.5 min-h-0">
          {displayDonors.slice(0, 4).map((donor) => {
            const isPlaceholder = donor.amount === 0 && donor.name === 'Claim this spot!';
            const rankDisplay = getRankDisplay(donor.rank, isPlaceholder);
            const isEmoji = rankDisplay && ['🥇', '🥈', '🥉'].includes(rankDisplay);
            const isTextLabel = rankDisplay === '4th';
            
            return (
              <div key={donor.id} className="flex flex-col items-center justify-center p-1 py-3 rounded-lg bg-gray-50/50 dark:bg-white/5 border border-transparent hover:border-primary/20 hover:bg-primary/5 transition-all text-center h-full max-h-full">
                {/* Rank indicator container - always rendered for consistent spacing */}
                <div className="mb-1 flex-shrink-0 h-[1.5rem] flex items-center justify-center">
                  {isEmoji && (
                    <span className="text-lg">{rankDisplay}</span>
                  )}
                  {isTextLabel && (
                    <span className="text-[10px] font-semibold text-text-secondary-light dark:text-text-secondary-dark">
                      {rankDisplay}
                    </span>
                  )}
                </div>
                
                <div className="w-full px-0.5 flex flex-col justify-center overflow-hidden min-h-0">
                  <p className="text-[10px] font-bold text-text-primary-light dark:text-text-primary-dark truncate w-full leading-tight" title={donor.name}>
                    {donor.name}
                    {donor.isOwned && !isPlaceholder && (
                      <span className="ml-1 text-[9px] text-primary font-medium">(You)</span>
                    )}
                  </p>
                  {!isPlaceholder && (
                    <p className="text-[9px] text-primary font-medium mt-0 truncate leading-tight">
                      {currency.format(donor.amount)}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default DonorTicker;