import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

const RequestPasswordResetPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const role = searchParams.get('role'); // 'advertiser' or 'sponsor'
  
  // Determine the correct login page URL based on role
  const getLoginUrl = () => {
    if (role === 'sponsor') {
      return '/sponsor-login.html';
    }
    // Default to advertiser login (backward compatible)
    return '/advertiser-login.html';
  };
  
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (!email) {
      setError('Please enter your email address');
      return;
    }

    setLoading(true);

    try {
      // Determine endpoint based on role query parameter
      // role=sponsor → /api/sponsor/request-password-reset
      // role=advertiser or no role → /api/advertiser/request-password-reset (default for backward compatibility)
      const endpoint = role === 'sponsor' 
        ? '/api/sponsor/request-password-reset'
        : '/api/advertiser/request-password-reset';

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setSuccess(true);
      } else {
        setError(data.error || 'Failed to send reset link');
      }
    } catch (err) {
      console.error('Error requesting password reset:', err);
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center', 
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: '20px'
    }}>
      <div style={{
        background: 'white',
        borderRadius: '12px',
        boxShadow: '0 10px 40px rgba(0, 0, 0, 0.1)',
        maxWidth: '500px',
        width: '100%',
        padding: '40px'
      }}>
        <div style={{ textAlign: 'center', marginBottom: '30px' }}>
          <h1 style={{ color: '#2F7D31', fontSize: '28px', marginBottom: '8px' }}>Charity Stream</h1>
          <p style={{ color: '#6b7280', fontSize: '14px' }}>Request Password Reset</p>
        </div>

        {error && (
          <div style={{
            background: '#fee2e2',
            border: '1px solid #fecaca',
            color: '#991b1b',
            padding: '12px 16px',
            borderRadius: '8px',
            marginBottom: '20px',
            fontSize: '14px'
          }}>
            {error}
          </div>
        )}

        {success ? (
          <div>
            <div style={{
              background: '#d1fae5',
              border: '1px solid #a7f3d0',
              color: '#065f46',
              padding: '12px 16px',
              borderRadius: '8px',
              marginBottom: '20px',
              fontSize: '14px'
            }}>
              If an account exists with this email, you will receive a password reset link.
            </div>
            <button
              onClick={() => window.location.href = getLoginUrl()}
              style={{
                width: '100%',
                background: '#2F7D31',
                color: 'white',
                border: 'none',
                padding: '14px',
                borderRadius: '8px',
                fontSize: '16px',
                fontWeight: '600',
                cursor: 'pointer'
              }}
            >
              Back to Login
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: '20px' }}>
              <label style={{
                display: 'block',
                marginBottom: '8px',
                color: '#374151',
                fontWeight: '500',
                fontSize: '14px'
              }}>
                Email Address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  border: '1px solid #d1d5db',
                  borderRadius: '8px',
                  fontSize: '16px',
                  boxSizing: 'border-box'
                }}
              />
              <p style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px' }}>
                Enter your email to receive a password reset or creation link.
              </p>
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                background: loading ? '#9ca3af' : '#2F7D31',
                color: 'white',
                border: 'none',
                padding: '14px',
                borderRadius: '8px',
                fontSize: '16px',
                fontWeight: '600',
                cursor: loading ? 'not-allowed' : 'pointer',
                marginTop: '10px'
              }}
            >
              {loading ? 'Sending...' : 'Send Reset Link'}
            </button>
          </form>
        )}

        <div style={{ textAlign: 'center', marginTop: '20px', paddingTop: '20px', borderTop: '1px solid #e5e7eb' }}>
          <a 
            href={getLoginUrl()}
            style={{
              color: '#2F7D31',
              textDecoration: 'none',
              fontWeight: '500',
              fontSize: '14px'
            }}
          >
            ← Back to Login
          </a>
        </div>
      </div>
    </div>
  );
};

export default RequestPasswordResetPage;

