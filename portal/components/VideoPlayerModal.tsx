import React, { useEffect, useRef } from 'react';

interface VideoPlayerModalProps {
  isOpen: boolean;
  videoUrl: string | null;
  onClose: () => void;
  adFormat?: string; // 'video' or 'image'/'static_image'
}

const VideoPlayerModal: React.FC<VideoPlayerModalProps> = ({ isOpen, videoUrl, onClose, adFormat }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  
  // Determine if this is an image campaign
  const isImageCampaign = adFormat === 'image' || adFormat === 'static_image' || adFormat === 'Image' || adFormat === 'Static Image';
  const isVideoCampaign = !isImageCampaign; // Default to video for legacy campaigns

  useEffect(() => {
    // Only auto-play video for video campaigns
    if (isOpen && videoRef.current && isVideoCampaign) {
      videoRef.current.play();
      
      // Hide the more options button after video loads
      const hideMoreOptionsButton = () => {
        const video = videoRef.current;
        if (!video) return;
        
        // Wait for controls to render
        setTimeout(() => {
          // Hide picture-in-picture button and overflow menu
          const style = document.createElement('style');
          style.id = 'video-controls-hide';
          style.textContent = `
            video::-webkit-media-controls-picture-in-picture-button {
              display: none !important;
            }
            video::-webkit-media-controls-overlay-enclosure {
              display: none !important;
            }
            video::-webkit-media-controls-enclosure {
              overflow: visible !important;
            }
          `;
          if (!document.getElementById('video-controls-hide')) {
            document.head.appendChild(style);
          }
        }, 100);
      };
      
      if (videoRef.current.readyState >= 2) {
        hideMoreOptionsButton();
      } else {
        videoRef.current.addEventListener('loadedmetadata', hideMoreOptionsButton);
        return () => {
          videoRef.current?.removeEventListener('loadedmetadata', hideMoreOptionsButton);
        };
      }
    }
  }, [isOpen, isVideoCampaign]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  if (!isOpen || !videoUrl) {
    return null;
  }

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm transition-all duration-200 ease-out"
      onClick={onClose}
    >
      <div 
        className="relative z-10 w-full max-w-5xl mx-4 bg-container-light dark:bg-container-dark rounded-2xl shadow-2xl overflow-hidden transition-all duration-200 ease-out"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with close button */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-light dark:border-border-dark">
          <p className="text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
            Ad Creative
          </p>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center w-8 h-8 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-text-secondary-light dark:text-text-secondary-dark transition-colors"
            aria-label="Close modal"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Creative preview - video or image based on ad_format */}
        {isVideoCampaign ? (
          <div className="bg-black aspect-video">
            <video
              ref={videoRef}
              src={videoUrl}
              className="w-full h-full video-no-more-options"
              controls
              controlsList="nodownload noplaybackrate nopictureinpicture"
              disablePictureInPicture
              autoPlay
              onContextMenu={(e) => e.preventDefault()}
            />
            <style>{`
              /* Hide the more options button (three dots menu) */
              .video-no-more-options::-webkit-media-controls-overlay-enclosure {
                display: none !important;
              }
              /* Hide picture-in-picture button specifically */
              .video-no-more-options::-webkit-media-controls-picture-in-picture-button {
                display: none !important;
              }
              /* For Firefox and other browsers */
              .video-no-more-options::-moz-media-controls-picture-in-picture-button {
                display: none !important;
              }
              /* Ensure controls enclosure doesn't show overflow menu */
              .video-no-more-options::-webkit-media-controls-enclosure {
                overflow: visible !important;
              }
            `}</style>
          </div>
        ) : (
          <div className="bg-black flex items-center justify-center p-8 min-h-[400px] max-h-[80vh]">
            <img
              src={videoUrl || ''}
              alt="Ad Creative"
              className="max-w-full max-h-full object-contain rounded-lg"
              onContextMenu={(e) => e.preventDefault()}
              onError={(e) => {
                console.error('Failed to load image:', videoUrl);
                e.currentTarget.style.display = 'none';
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default VideoPlayerModal;

