import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * ProtectedRoute - Only allows access if user has valid advertiser_portal JWT
 * 
 * CRITICAL: This component ONLY checks advertiserPortalToken
 * Viewer website tokens (localStorage.token) are completely ignored
 * 
 * This component ONLY wraps /dashboard route.
 * Password reset/setup pages are public routes and never use this component.
 */
const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const location = useLocation();
  
  // ONLY check advertiser portal token - ignore viewer tokens completely
  const advertiserPortalToken = localStorage.getItem('advertiserPortalToken');
  
  // If no advertiser portal token, redirect to login
  if (!advertiserPortalToken) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  
  // If we have a token, allow access to protected route
  // This component only wraps /dashboard, so we don't need to check pathname
  return <>{children}</>;
};

export default ProtectedRoute;

