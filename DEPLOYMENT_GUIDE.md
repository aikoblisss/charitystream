# Deploy LetsWatchAds to Production

## Quick Deploy with Railway (Recommended)

### Step 1: Prepare Your Code
1. Your code is already prepared with `railway.json` and root `package.json`
2. Make sure your server is working locally first

### Step 2: Deploy to Railway
1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Connect your GitHub account
5. Select your `charity-stream` repository
6. Railway will automatically detect it's a Node.js app
7. Click "Deploy"

### Step 3: Configure Environment Variables
In Railway dashboard:
1. Go to your project → "Variables"
2. Add these variables:
   ```
   PORT=3001
   NODE_ENV=production
   JWT_SECRET=your-super-secret-jwt-key-change-this
   ```

### Step 4: Get Your Railway URL
1. Railway will give you a URL like: `https://your-app-name.railway.app`
2. Test it works: Visit the URL in your browser

### Step 5: Connect Your Domain
1. In Railway dashboard → "Settings" → "Domains"
2. Add custom domain: `stream.charity`
3. Railway will give you DNS instructions
4. Update your GoDaddy DNS with Railway's instructions

## Alternative: VPS Deployment

### Step 1: Get a VPS
- **DigitalOcean**: $5/month droplet
- **Linode**: $5/month nanode
- **Vultr**: $2.50/month instance

### Step 2: Set Up Server
```bash
# Connect to your server
ssh root@your-server-ip

# Update system
apt update && apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
apt-get install -y nodejs

# Install PM2 (process manager)
npm install -g pm2

# Clone your repository
git clone https://github.com/yourusername/charity-stream.git
cd charity-stream

# Install dependencies
cd backend
npm install

# Start the application
pm2 start server.js --name "letswatchads"
pm2 save
pm2 startup
```

### Step 3: Configure Nginx (Reverse Proxy)
```bash
# Install Nginx
apt install nginx -y

# Create Nginx config
cat > /etc/nginx/sites-available/stream.charity << EOF
server {
    listen 80;
    server_name stream.charity www.stream.charity;
    
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

# Enable the site
ln -s /etc/nginx/sites-available/stream.charity /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

### Step 4: Set Up SSL with Let's Encrypt
```bash
# Install Certbot
apt install certbot python3-certbot-nginx -y

# Get SSL certificate
certbot --nginx -d stream.charity -d www.stream.charity

# Test auto-renewal
certbot renew --dry-run
```

### Step 5: Configure GoDaddy DNS
In your GoDaddy DNS management:
1. **A Record**: `@` → `your-server-ip`
2. **A Record**: `www` → `your-server-ip`
3. **CNAME Record**: `www` → `stream.charity`

## Performance Optimization

### For 100+ Concurrent Users:
1. **Enable Gzip compression** in Nginx
2. **Set up CDN** (Cloudflare) for static files
3. **Monitor server resources** (CPU, RAM, disk)
4. **Set up database backups**
5. **Configure log rotation**

### Monitoring Commands:
```bash
# Check server resources
htop
df -h
free -h

# Check application logs
pm2 logs letswatchads

# Check Nginx logs
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log
```

## Security Checklist

- [ ] Change default SSH port
- [ ] Set up firewall (UFW)
- [ ] Enable fail2ban
- [ ] Regular security updates
- [ ] Strong JWT secret
- [ ] HTTPS enabled
- [ ] Database backups

## Cost Breakdown

### Railway (Easiest):
- **Railway**: $5-20/month
- **Domain**: Already paid
- **Total**: ~$5-20/month

### VPS (Most Control):
- **VPS**: $5-20/month
- **Domain**: Already paid
- **Total**: ~$5-20/month

Both options can easily handle 100+ concurrent users!
