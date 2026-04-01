import React, { useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';

/**
 * CreatePasswordPage - Redirects to unified reset-password page
 * This maintains backward compatibility for old email links
 */
const CreatePasswordPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  useEffect(() => {
    // Redirect to unified reset-password page (no type parameter needed)
    if (token) {
      navigate(`/reset-password?token=${token}`, { replace: true });
    } else {
      // No token, redirect to request password reset
      navigate('/request-password-reset', { replace: true });
    }
  }, [token, navigate]);

  // Show loading while redirecting
  return (
    <div style={{ 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center', 
      minHeight: '100vh',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      <p>Redirecting...</p>
    </div>
  );
};

export default CreatePasswordPage;
