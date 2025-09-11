// This file contains additional video player functionality
// The main video player initialization is now handled in index.html

// Event tracking function for analytics
function trackEvent(eventType, duration, additionalData = {}) {
  if (!authToken) return;
  
  try {
    fetch('/api/analytics/track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        eventType: eventType,
        duration: duration,
        ...additionalData
      })
    });
  } catch (error) {
    console.error('Error tracking event:', error);
  }
}

// Quality switching functionality (can be called from index.html)
function changeVideoQuality(newQuality) {
  if (!player || !currentUser) return;
  
  // This function can be called from the upgrade button or quality selector
  console.log(`Quality change requested to: ${newQuality}`);
  
  // For now, just update the display
  document.getElementById('currentQualityDisplay').textContent = newQuality;
  
  // TODO: Implement actual quality switching logic
  // This would involve changing the video source and maintaining playback position
}