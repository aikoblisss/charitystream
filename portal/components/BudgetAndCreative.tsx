import React, { useState } from 'react';
import { DashboardData } from '../types';

interface BudgetAndCreativeProps {
  dashboardData: DashboardData;
  onViewCreative: () => void;
  activeCampaignId?: number | null;
  onRefreshDashboard: (campaignId: number | null) => Promise<void>;
}

const BudgetAndCreative: React.FC<BudgetAndCreativeProps> = ({ dashboardData, onViewCreative, activeCampaignId, onRefreshDashboard }) => {
  const [showReplaceModal, setShowReplaceModal] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const currencyCpm = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  const currencyWithDecimals = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Calculate spent this week (same as donations this week)
  const spentThisWeek = dashboardData.donationsThisWeek ?? 0;
  
  // Calculate remaining budget
  const remaining = dashboardData.remainingBudget ?? 0;

  // Check if campaign is ended
  const isEnded = dashboardData.status === 'ENDED';

  const getAuthHeaders = () => {
    const token = localStorage.getItem('advertiserPortalToken');
    return token
      ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const adFormat = dashboardData.adFormat || 'video'; // Default to 'video' for legacy campaigns
      const isVideoCampaign = adFormat === 'video' || adFormat === 'Video';
      const isImageCampaign = adFormat === 'image' || adFormat === 'static_image' || adFormat === 'Image' || adFormat === 'Static Image';
      
      // Validate file type matches campaign format
      if (isVideoCampaign) {
        if (!file.type.startsWith('video/')) {
          alert('Video campaigns require video files. Please select an MP4 video file.');
          e.target.value = ''; // Clear the input
          return;
        }
        if (file.type !== 'video/mp4') {
          alert('Only MP4 video files are supported for video campaigns.');
          e.target.value = ''; // Clear the input
          return;
        }
      } else if (isImageCampaign) {
        if (!file.type.startsWith('image/')) {
          alert('Static image campaigns require image files. Please select a JPG, PNG, GIF, or WEBP image file.');
          e.target.value = ''; // Clear the input
          return;
        }
        const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
        if (!allowedImageTypes.includes(file.type.toLowerCase())) {
          alert('Only JPG, PNG, GIF, and WEBP image files are supported for static image campaigns.');
          e.target.value = ''; // Clear the input
          return;
        }
      }
      
      // Validate file size (max 500MB)
      if (file.size > 500 * 1024 * 1024) {
        alert('File size must be less than 500MB');
        e.target.value = ''; // Clear the input
        return;
      }
      setSelectedFile(file);
    }
  };

  const handleReplaceConfirm = async () => {
    if (!selectedFile) {
      const adFormat = dashboardData.adFormat || 'video';
      const isImageCampaign = adFormat === 'image' || adFormat === 'static_image' || adFormat === 'Image' || adFormat === 'Static Image';
      alert(isImageCampaign ? 'Please select an image file' : 'Please select a video file');
      return;
    }

    try {
      setIsUploading(true);
      setUploadProgress(0);

      if (!activeCampaignId) {
        throw new Error('No campaign selected');
      }

      // Step 1: Get presigned URL
      const presignResponse = await fetch('/api/advertiser/presign-upload', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          fileName: selectedFile.name,
          contentType: selectedFile.type,
          fileSize: selectedFile.size
        })
      });

      if (!presignResponse.ok) {
        throw new Error('Failed to get upload URL');
      }

      const { uploadUrl, key } = await presignResponse.json();
      setUploadProgress(25);

      // Step 2: Upload file to R2
      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        body: selectedFile,
        headers: {
          'Content-Type': selectedFile.type
        }
      });

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload file');
      }

      setUploadProgress(75);

      // Step 3: Call replace-creative endpoint
      const replaceResponse = await fetch(`/api/advertiser/replace-creative?campaignId=${activeCampaignId}`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          newVideoKey: key,
          contentType: selectedFile.type // Include content type for backend validation
        })
      });

      if (!replaceResponse.ok) {
        const errorData = await replaceResponse.json();
        throw new Error(errorData.error || 'Failed to replace creative');
      }

      setUploadProgress(100);

      // Close modal and refresh dashboard with the same campaignId
      setShowReplaceModal(false);
      setSelectedFile(null);
      if (activeCampaignId) {
        await onRefreshDashboard(activeCampaignId);
      }
    } catch (err) {
      console.error('Error replacing creative:', err);
      alert(err instanceof Error ? err.message : 'Failed to replace creative. Please try again.');
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  // Format values - show "—" if null
  const formatCurrency = (value: number | null) => {
    if (value === null) return '—';
    return currency.format(value);
  };

  // Format spent values with cents (two decimal places)
  const formatSpentCurrency = (value: number | null) => {
    if (value === null) return '—';
    return currencyWithDecimals.format(value);
  };

  return (
    <section className="grid grid-cols-1 lg:grid-cols-3 gap-2 mb-2">
      <div className="lg:col-span-2 p-2 px-3 bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark">
        <h3 className="text-base font-semibold mb-2 text-text-primary-light dark:text-text-primary-dark">Budget</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-left">
          <div>
            <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark">Total</p>
            <p className="text-lg font-bold text-text-primary-light dark:text-text-primary-dark">{formatCurrency(dashboardData.weeklyBudgetCap)}</p>
          </div>
          <div>
            <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark">Spent This Week</p>
            <p className="text-lg font-bold text-text-primary-light dark:text-text-primary-dark">{formatSpentCurrency(dashboardData.donationsThisWeek)}</p>
          </div>
          <div>
            <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark">Remaining</p>
            <p className="text-lg font-bold text-text-primary-light dark:text-text-primary-dark">{formatSpentCurrency(dashboardData.remainingBudget)}</p>
          </div>
          <div>
            <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark">CPM</p>
            <p className="text-lg font-bold text-text-primary-light dark:text-text-primary-dark">{currencyCpm.format(dashboardData.cpmRate)}</p>
          </div>
        </div>
      </div>

      <div className="p-2 px-3 bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark">
        <h3 className="text-base font-semibold mb-2 text-text-primary-light dark:text-text-primary-dark">Ad Creative</h3>
        <div className="flex items-center gap-2">
          {dashboardData.creativeUrl ? (() => {
            const adFormat = dashboardData.adFormat || 'video';
            const isVideoCampaign = adFormat === 'video' || adFormat === 'Video';
            const isImageCampaign = adFormat === 'image' || adFormat === 'static_image' || adFormat === 'Image' || adFormat === 'Static Image';
            
            return (
              <div className="w-20 h-20 rounded-lg flex-shrink-0 flex items-center justify-center border border-white/10 relative overflow-hidden bg-black/80">
                {isVideoCampaign ? (
                  <>
                    <video
                      src={dashboardData.creativeUrl}
                      className="w-full h-full object-cover rounded-lg"
                      preload="metadata"
                      onLoadedMetadata={(e) => {
                        e.currentTarget.currentTime = 0.1;
                      }}
                      muted
                    />
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-black/60">
                        <span className="text-white text-sm">▶</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <img
                    src={dashboardData.creativeUrl}
                    alt="Ad Creative"
                    className="w-full h-full object-cover rounded-lg"
                    onError={(e) => {
                      console.error('Failed to load thumbnail image:', dashboardData.creativeUrl);
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                )}
              </div>
            );
          })() : (
            <div className="w-20 h-20 flex items-center justify-center rounded-lg border border-dashed border-border-light dark:border-border-dark bg-gray-50 dark:bg-gray-900 text-text-secondary-light dark:text-text-secondary-dark text-xs text-center p-2 flex-shrink-0">
              No creative
            </div>
          )}
          <div className="flex flex-col gap-1.5 self-center w-full">
            {/* Only show Replace Creative button for recurring campaigns */}
            {dashboardData.recurringWeekly && (
              <button
                onClick={() => {
                  if (!isEnded) {
                    setShowReplaceModal(true);
                  }
                }}
                disabled={isEnded}
                className={`flex w-full items-center justify-center rounded-lg h-9 px-3 text-sm font-semibold transition-colors ${
                  isEnded
                    ? 'bg-gray-100 dark:bg-gray-800 text-text-secondary-light dark:text-text-secondary-dark cursor-not-allowed opacity-50'
                    : 'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-text-primary-light dark:text-text-primary-dark cursor-pointer'
                }`}
              >
                Replace Creative
              </button>
            )}
            <button
              onClick={() => {
                if (dashboardData.creativeUrl) {
                  onViewCreative();
                }
              }}
              disabled={!dashboardData.creativeUrl}
              className={
                dashboardData.recurringWeekly
                  ? `text-sm font-semibold text-center transition-colors ${
                      dashboardData.creativeUrl
                        ? 'text-primary hover:text-primary/80 cursor-pointer'
                        : 'text-text-secondary-light dark:text-text-secondary-dark cursor-not-allowed'
                    }`
                  : `flex w-full items-center justify-center rounded-lg h-9 px-3 text-sm font-semibold transition-colors ${
                      dashboardData.creativeUrl
                        ? 'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-text-primary-light dark:text-text-primary-dark cursor-pointer'
                        : 'bg-gray-100 dark:bg-gray-800 text-text-secondary-light dark:text-text-secondary-dark cursor-not-allowed opacity-50'
                    }`
              }
            >
              View Creative
            </button>
          </div>
        </div>
      </div>

      {/* Replace Creative Modal */}
      {showReplaceModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-container-light dark:bg-container-dark rounded-xl border border-border-light dark:border-border-dark p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-text-primary-light dark:text-text-primary-dark mb-2">
              Replace Creative
            </h3>
            {(() => {
              const adFormat = dashboardData.adFormat || 'video';
              const isVideoCampaign = adFormat === 'video' || adFormat === 'Video';
              const isImageCampaign = adFormat === 'image' || adFormat === 'static_image' || adFormat === 'Image' || adFormat === 'Static Image';
              
              return (
                <>
                  <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark mb-4">
                    {isVideoCampaign 
                      ? 'Upload a new MP4 video to replace your current creative. Your campaign will be paused and put back under review until the new video is approved.'
                      : 'Upload a new image (JPG, PNG, GIF, or WEBP) to replace your current creative. Your campaign will be paused and put back under review until the new image is approved.'
                    }
                  </p>
                  
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-text-primary-light dark:text-text-primary-dark mb-2">
                      {isVideoCampaign ? 'Select Video File (MP4)' : 'Select Image File (JPG, PNG, GIF, WEBP)'}
                    </label>
                    <input
                      type="file"
                      accept={isVideoCampaign ? "video/mp4" : "image/jpeg,image/jpg,image/png,image/gif,image/webp"}
                      onChange={handleFileSelect}
                      disabled={isUploading}
                      className="block w-full text-sm text-text-secondary-light dark:text-text-secondary-dark
                        file:mr-4 file:py-2 file:px-4
                        file:rounded-lg file:border-0
                        file:text-sm file:font-semibold
                        file:bg-primary file:text-white
                        hover:file:bg-primary/90
                        file:cursor-pointer
                        disabled:opacity-50"
                    />
                  </div>
                  {selectedFile && (
                    <p className="mt-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                      Selected: {selectedFile.name} ({(selectedFile.size / (1024 * 1024)).toFixed(2)} MB)
                    </p>
                  )}
                  {isUploading && (
                    <div className="mt-2">
                      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                        <div
                          className="bg-primary h-2 rounded-full transition-all duration-300"
                          style={{ width: `${uploadProgress}%` }}
                        ></div>
                      </div>
                      <p className="mt-1 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                        Uploading... {uploadProgress}%
                      </p>
                    </div>
                  )}
                </>
              );
            })()}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowReplaceModal(false);
                  setSelectedFile(null);
                }}
                className="px-3 py-2 rounded-lg text-sm font-medium text-text-primary-light dark:text-text-primary-dark bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700"
                disabled={isUploading}
              >
                Cancel
              </button>
              <button
                onClick={handleReplaceConfirm}
                className="px-3 py-2 rounded-lg text-sm font-semibold bg-primary hover:bg-primary/90 text-white disabled:opacity-70"
                disabled={isUploading || !selectedFile}
              >
                {isUploading ? 'Uploading...' : 'Replace Creative'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default BudgetAndCreative;