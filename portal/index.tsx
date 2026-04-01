import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    {/* basename="/portal" because backend serves /portal/* and React Router handles routes after /portal */}
    <BrowserRouter basename="/portal">
      <App />
    </BrowserRouter>
  </React.StrictMode>
);