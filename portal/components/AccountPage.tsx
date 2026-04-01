import React, { useState, useEffect } from 'react';
import { User, Eye, EyeOff } from 'lucide-react';
import Footer from './Footer';
import { Page } from '../types';

interface AccountPageProps {
  onNavigate: (page: Page) => void;
}

interface AccountData {
  companyName: string | null;
  email: string | null;
  phoneNumber: string | null;
}

const AccountPage: React.FC<AccountPageProps> = ({ onNavigate }) => {
  const [accountData, setAccountData] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [isEditingPhone, setIsEditingPhone] = useState(false);
  const [isSavingPhone, setIsSavingPhone] = useState(false);

  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  const getAuthHeaders = () => {
    const token = localStorage.getItem('advertiserPortalToken');
    return token
      ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
  };

  useEffect(() => {
    const fetchAccountData = async () => {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch('/api/advertiser/account', {
          headers: getAuthHeaders()
        });

        if (!response.ok) {
          throw new Error('Failed to fetch account data');
        }

        const data = await response.json();
        setAccountData(data);
        setPhoneNumber(data.phoneNumber || '');
      } catch (err) {
        console.error('Error fetching account data:', err);
        setError(err instanceof Error ? err.message : 'Failed to load account information');
      } finally {
        setLoading(false);
      }
    };

    fetchAccountData();
  }, []);

  const handlePhoneNumberBlur = async () => {
    if (!isEditingPhone) return;

    setIsEditingPhone(false);
    
    // Only save if the value has changed
    const currentValue = phoneNumber.trim() || null;
    const originalValue = accountData?.phoneNumber || null;
    
    if (currentValue === originalValue) {
      return;
    }

    try {
      setIsSavingPhone(true);

      const response = await fetch('/api/advertiser/account', {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          phoneNumber: currentValue
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update phone number');
      }

      const data = await response.json();
      
      // Update local state
      setAccountData(prev => prev ? { ...prev, phoneNumber: data.phoneNumber } : null);
      setPhoneNumber(data.phoneNumber || '');
    } catch (err) {
      console.error('Error updating phone number:', err);
      // Revert to original value on error
      setPhoneNumber(accountData?.phoneNumber || '');
      alert(err instanceof Error ? err.message : 'Failed to update phone number');
    } finally {
      setIsSavingPhone(false);
    }
  };

  const handlePhoneNumberFocus = () => {
    setIsEditingPhone(true);
  };

  const handlePhoneNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPhoneNumber(e.target.value);
  };

  const openPasswordModal = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordError(null);
    setPasswordSuccess(false);
    setShowCurrent(false);
    setShowNew(false);
    setShowConfirm(false);
    setShowPasswordModal(true);
  };

  const handlePasswordSubmit = async () => {
    setPasswordError(null);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('All fields are required.');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.');
      return;
    }

    try {
      setIsSavingPassword(true);
      const response = await fetch('/api/advertiser/change-password', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ currentPassword, newPassword })
      });

      const data = await response.json();

      if (!response.ok) {
        setPasswordError(data.error || 'Failed to update password.');
        return;
      }

      setPasswordSuccess(true);
      setTimeout(() => setShowPasswordModal(false), 1500);
    } catch (err) {
      setPasswordError('An unexpected error occurred. Please try again.');
    } finally {
      setIsSavingPassword(false);
    }
  };

  if (loading) {
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
              Account
            </span>
          </div>
        </header>
        <div className="flex items-center justify-center p-8">
          <p className="text-text-secondary-light dark:text-text-secondary-dark">Loading account information...</p>
        </div>
      </div>
    );
  }

  if (error) {
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
              Account
            </span>
          </div>
        </header>
        <div className="flex items-center justify-center p-8">
          <p className="text-red-600 dark:text-red-400">{error}</p>
        </div>
      </div>
    );
  }

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
            Account
          </span>
        </div>
      </header>

      <div className="space-y-6 flex-1">
        {/* Profile Section */}
        <section className="bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2 text-text-primary-light dark:text-text-primary-dark">
            <User className="w-5 h-5 text-primary" />
            Profile Information
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary-light dark:text-text-secondary-dark mb-1">Company Name</label>
              <input 
                type="text" 
                value={accountData?.companyName || ''} 
                readOnly
                className="w-full px-3 py-2 rounded-lg bg-background-light dark:bg-background-dark border border-border-light dark:border-border-dark text-text-primary-light dark:text-text-primary-dark outline-none cursor-default" 
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary-light dark:text-text-secondary-dark mb-1">Contact Email</label>
              <input 
                type="email" 
                value={accountData?.email || ''} 
                readOnly
                className="w-full px-3 py-2 rounded-lg bg-background-light dark:bg-background-dark border border-border-light dark:border-border-dark text-text-primary-light dark:text-text-primary-dark outline-none cursor-default" 
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary-light dark:text-text-secondary-dark mb-1">Phone Number</label>
              <input 
                type="tel" 
                value={phoneNumber}
                placeholder={phoneNumber ? undefined : "Add a phone number"}
                onChange={handlePhoneNumberChange}
                onFocus={handlePhoneNumberFocus}
                onBlur={handlePhoneNumberBlur}
                disabled={isSavingPhone}
                className={`w-full px-3 py-2 rounded-lg bg-background-light dark:bg-background-dark border border-border-light dark:border-border-dark text-text-primary-light dark:text-text-primary-dark outline-none transition-colors ${
                  isEditingPhone 
                    ? 'focus:ring-2 focus:ring-primary/50 cursor-text' 
                    : 'cursor-text'
                } ${isSavingPhone ? 'opacity-50 cursor-not-allowed' : ''}`}
              />
              {isSavingPhone && (
                <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark mt-1">Saving...</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary-light dark:text-text-secondary-dark mb-1">Password</label>
              <button
                type="button"
                onClick={openPasswordModal}
                className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-text-primary-light dark:text-text-primary-dark border border-border-light dark:border-border-dark font-medium transition-colors"
              >
                Reset Password
              </button>
            </div>
          </div>
        </section>
      </div>

      <div className="mt-8">
        <Footer onNavigate={onNavigate} />
      </div>

      {showPasswordModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold text-text-primary-light dark:text-text-primary-dark mb-4">
              Reset Password
            </h3>

            <div className="space-y-3">
              {/* Current password */}
              <div>
                <label className="block text-sm font-medium text-text-secondary-light dark:text-text-secondary-dark mb-1">Current Password</label>
                <div className="relative">
                  <input
                    type={showCurrent ? 'text' : 'password'}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full px-3 py-2 pr-10 rounded-lg bg-background-light dark:bg-background-dark border border-border-light dark:border-border-dark text-text-primary-light dark:text-text-primary-dark outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="Enter current password"
                  />
                  <button type="button" onClick={() => setShowCurrent(v => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-secondary-light dark:text-text-secondary-dark">
                    {showCurrent ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* New password */}
              <div>
                <label className="block text-sm font-medium text-text-secondary-light dark:text-text-secondary-dark mb-1">New Password</label>
                <div className="relative">
                  <input
                    type={showNew ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-3 py-2 pr-10 rounded-lg bg-background-light dark:bg-background-dark border border-border-light dark:border-border-dark text-text-primary-light dark:text-text-primary-dark outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="At least 8 characters"
                  />
                  <button type="button" onClick={() => setShowNew(v => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-secondary-light dark:text-text-secondary-dark">
                    {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Confirm new password */}
              <div>
                <label className="block text-sm font-medium text-text-secondary-light dark:text-text-secondary-dark mb-1">Confirm New Password</label>
                <div className="relative">
                  <input
                    type={showConfirm ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full px-3 py-2 pr-10 rounded-lg bg-background-light dark:bg-background-dark border border-border-light dark:border-border-dark text-text-primary-light dark:text-text-primary-dark outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="Repeat new password"
                  />
                  <button type="button" onClick={() => setShowConfirm(v => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-secondary-light dark:text-text-secondary-dark">
                    {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            {passwordError && (
              <p className="mt-3 text-sm text-red-600 dark:text-red-400">{passwordError}</p>
            )}
            {passwordSuccess && (
              <p className="mt-3 text-sm text-green-600 dark:text-green-400">Password updated successfully!</p>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setShowPasswordModal(false)}
                disabled={isSavingPassword}
                className="px-3 py-2 rounded-lg text-sm font-medium text-text-primary-light dark:text-text-primary-dark bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handlePasswordSubmit}
                disabled={isSavingPassword || passwordSuccess}
                className="px-3 py-2 rounded-lg text-sm font-semibold bg-primary hover:bg-primary/90 text-white disabled:opacity-50"
              >
                {isSavingPassword ? 'Saving...' : 'Update Password'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AccountPage;