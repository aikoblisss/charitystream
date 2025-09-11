# Vercel Deployment Guide

## Project Structure Changes Made

1. **Created `public/` directory** - Contains all frontend files (HTML, CSS, JS, videos)
2. **Updated `vercel.json`** - Configured routing for API and static files
3. **Updated `backend/server.js`** - Changed static file serving from `frontend/` to `public/`
4. **Added `.vercelignore`** - Excludes unnecessary files from deployment

## Deployment Steps

### 1. Install Vercel CLI (if not already installed)
```bash
npm i -g vercel
```

### 2. Login to Vercel
```bash
vercel login
```

### 3. Deploy to Vercel
```bash
vercel
```

### 4. Set Environment Variables
In your Vercel dashboard, go to Project Settings > Environment Variables and add:

- `JWT_SECRET` - A secure random string for JWT tokens
- `PORT` - Set to 3000 (optional, Vercel handles this automatically)

## Important Notes

### Database Limitation
⚠️ **CRITICAL**: The current setup uses SQLite with a local file (`letswatchads.db`). This will NOT work in production on Vercel because:

1. Vercel functions are stateless
2. File system is read-only in production
3. Database file will be lost between deployments

### Recommended Solutions

1. **Use a cloud database service:**
   - **Supabase** (PostgreSQL with free tier)
   - **PlanetScale** (MySQL with free tier)
   - **MongoDB Atlas** (MongoDB with free tier)
   - **Railway** (PostgreSQL with free tier)

2. **Update database connection in `backend/database.js`** to use the cloud database

### Current Status
- ✅ Frontend files properly structured for Vercel
- ✅ API routes configured for Vercel functions
- ✅ Static file serving updated
- ⚠️ Database needs cloud migration for production use

## Testing Locally

You can test the Vercel configuration locally:

```bash
vercel dev
```

This will start a local development server that mimics Vercel's behavior.

## File Structure After Changes

```
charity-stream/
├── public/                 # Frontend files (served as static)
│   ├── index.html
│   ├── auth.html
│   ├── admin.html
│   ├── script.js
│   └── videos/
├── backend/               # Backend API (Vercel function)
│   ├── server.js
│   ├── database.js
│   └── ...
├── vercel.json           # Vercel configuration
├── .vercelignore         # Files to ignore in deployment
└── package.json
```

## Next Steps

1. Deploy to Vercel using the steps above
2. Set up a cloud database service
3. Update the database connection code
4. Test all functionality in production
