import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';

/**
 * Unified password reset/create page
 * Handles all password setup flows using unified endpoints
 */
const ResetPasswordPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');
  
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [validating, setValidating] = useState(true);
  const [valid, setValid] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [accountAlreadySetup, setAccountAlreadySetup] = useState(false);

  useEffect(() => {
    if (!token) {
      setValidating(false);
      setValid(false);
      return;
    }

    // Validate token using unified endpoint
    fetch(`/api/advertiser/validate-password-token?token=${token}`)
      .then(res => res.json())
      .then(data => {
        setValidating(false);
        if (data.valid) {
          setValid(true);
          setEmail(data.email);
          // password_reset tokens are always valid, never show "account already set up"
          // Only password_setup tokens can be blocked if password exists
        } else if (data.accountAlreadySetup) {
          // Only password_setup tokens can trigger this
          setAccountAlreadySetup(true);
          setValid(false);
        } else if (data.expired) {
          setExpired(true);
        } else {
          setValid(false);
        }
      })
      .catch(err => {
        console.error('Error validating token:', err);
        setValidating(false);
        setValid(false);
      });
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!password || !confirmPassword) {
      setError('Please enter both password fields');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (!token) {
      setError('Invalid token');
      return;
    }

    setLoading(true);

    try {
      // Use unified set-password endpoint
      const response = await fetch('/api/advertiser/set-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          token,
          password
        })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setSuccess(true);
        setTimeout(() => {
          // Redirect to advertiser-login.html (not React portal login)
          window.location.href = '/advertiser-login.html';
        }, 2000);
      } else if (data.accountAlreadySetup) {
        setError('Account already set up. Please sign in.');
        setTimeout(() => {
          // Redirect to advertiser-login.html (not React portal login)
          window.location.href = '/advertiser-login.html';
        }, 2000);
      } else {
        setError(data.error || 'Failed to set password');
      }
    } catch (err) {
      console.error('Error submitting password:', err);
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (validating) {
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        minHeight: '100vh',
        fontFamily: 'system-ui, -apple-system, sans-serif'
      }}>
        <p>Validating token...</p>
      </div>
    );
  }

  if (accountAlreadySetup) {
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        minHeight: '100vh',
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
          <h1 style={{ color: '#2F7D31', marginBottom: '20px' }}>Account Already Set Up</h1>
          <p style={{ marginBottom: '20px', color: '#6b7280' }}>
            This account already has a password. Please sign in.
          </p>
          <a 
            href="/advertiser-login.html" 
            style={{
              display: 'inline-block',
              background: '#2F7D31',
              color: 'white',
              padding: '12px 24px',
              borderRadius: '8px',
              textDecoration: 'none',
              fontWeight: '600'
            }}
          >
            Go to Login
          </a>
        </div>
      </div>
    );
  }

  if (!valid && !expired) {
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        minHeight: '100vh',
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
          <h1 style={{ color: '#2F7D31', marginBottom: '20px' }}>Invalid Link</h1>
          <p style={{ marginBottom: '20px', color: '#6b7280' }}>
            This link is invalid or has been used already.
          </p>
          <p style={{ marginBottom: '20px', color: '#6b7280', fontSize: '14px' }}>
            Use 'Forgot or never created your password?' to request a new one.
          </p>
          <a 
            href="/request-password-reset" 
            style={{
              display: 'inline-block',
              background: '#2F7D31',
              color: 'white',
              padding: '12px 24px',
              borderRadius: '8px',
              textDecoration: 'none',
              fontWeight: '600'
            }}
          >
            Request New Link
          </a>
        </div>
      </div>
    );
  }

  if (expired) {
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        minHeight: '100vh',
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
          <h1 style={{ color: '#2F7D31', marginBottom: '20px' }}>Link Expired</h1>
          <p style={{ marginBottom: '20px', color: '#6b7280' }}>
            This link has expired. Use 'Forgot or never created your password?' to request a new one.
          </p>
          <a 
            href="/request-password-reset" 
            style={{
              display: 'inline-block',
              background: '#2F7D31',
              color: 'white',
              padding: '12px 24px',
              borderRadius: '8px',
              textDecoration: 'none',
              fontWeight: '600'
            }}
          >
            Request New Link
          </a>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        minHeight: '100vh',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '20px'
      }}>
        <div style={{
          background: 'white',
          borderRadius: '12px',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.1)',
          maxWidth: '500px',
          width: '100%',
          padding: '40px',
          textAlign: 'center'
        }}>
          <h1 style={{ color: '#2F7D31', marginBottom: '20px' }}>
            Password Created!
          </h1>
          <p style={{ marginBottom: '20px', color: '#6b7280' }}>
            Your password has been created successfully. Redirecting to login...
          </p>
        </div>
      </div>
    );
  }

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
          <p style={{ color: '#6b7280', fontSize: '14px' }}>
            Create Your Password
          </p>
          {email && <p style={{ color: '#6b7280', fontSize: '14px', marginTop: '8px' }}>{email}</p>}
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

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '20px' }}>
            <label style={{
              display: 'block',
              marginBottom: '8px',
              color: '#374151',
              fontWeight: '500',
              fontSize: '14px'
            }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
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
              Must be at least 8 characters
            </p>
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label style={{
              display: 'block',
              marginBottom: '8px',
              color: '#374151',
              fontWeight: '500',
              fontSize: '14px'
            }}>
              Confirm Password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              style={{
                width: '100%',
                padding: '12px 16px',
                border: '1px solid #d1d5db',
                borderRadius: '8px',
                fontSize: '16px',
                boxSizing: 'border-box'
              }}
            />
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
            {loading ? 'Creating Password...' : 'Create Password'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default ResetPasswordPage;
