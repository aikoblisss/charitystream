# Sponsor Submission System

## Overview

This system handles sponsor application submissions from the `/advertise/company` page. Each submission includes:

1. Organization and contact information
2. Logo file upload (PNG/SVG) to Cloudflare R2
3. Database record insertion into the `sponsors` table

---

## Cloudflare R2 Configuration

### Credentials
- **Public Dev URL**: `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev`
- **Bucket Name**: `advertiser-media` (shared with advertiser submissions)
- **Access Key ID**: `9eeb17f20eafece615e6b3520faf05c0`
- **Secret Access Key**: `86716ae1188f87ba5c6d0939a2ff19d972a0b53a6edfb0ed9fe5ba17a87cb4a4`
- **Account Endpoint**: `https://e94c5ecbf3e438d402b3fe2ad136c0fc.r2.cloudflarestorage.com`

### File Upload Rules
- Filenames are prefixed with `sponsor-` and a timestamp (e.g., `sponsor-1704398421000-logo.png`)
- Accepted file types: PNG, SVG (configured in frontend)
- Max file size: 50MB (enforced by multer)
- Public URL format: `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/sponsor-<timestamp>-<filename>`

---

## Database Schema

### Table: `sponsors`

```sql
CREATE TABLE IF NOT EXISTS sponsors (
  id SERIAL PRIMARY KEY,
  organization TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  website TEXT,
  ein_tax_id TEXT,
  sponsor_tier TEXT CHECK (sponsor_tier IN ('bronze', 'silver', 'gold', 'diamond') OR sponsor_tier IS NULL),  -- Validated values only
  logo_r2_link TEXT,              -- R2 public URL
  approved BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

### Column Details
- `organization`: Legal name of the sponsoring organization (required)
- `contact_email`: Primary contact email (required)
- `website`: Organization's homepage URL
- `ein_tax_id`: EIN or Tax ID number
- `sponsor_tier`: Sponsorship level selected from the form
- `logo_r2_link`: Public R2 URL of the uploaded logo
- `approved`: Admin approval status (defaults to `false`)
- `created_at`: Timestamp of submission

---

## API Endpoint

### `POST /api/sponsor/submit`

Handles sponsor application submissions with logo uploads.

#### Headers
- `Content-Type: multipart/form-data` (automatically set by FormData)

#### Request Body (FormData)

**Required Fields:**
- `organization` (required): Legal organization name
- `contactEmail` (required): Contact email address

**Optional Fields:**
- `website`: Organization website URL
- `einTaxId`: EIN or Tax ID number
- `sponsorTier`: `"bronze"`, `"silver"`, `"gold"`, or `"diamond"` (case-insensitive, validated)
- `logo` (file): Logo image upload (PNG or SVG)

#### Response (Success - 200)
```json
{
  "success": true,
  "message": "Sponsor submission received successfully",
  "data": {
    "id": 456,
    "organization": "Tech Foundation",
    "contactEmail": "contact@techfoundation.org",
    "logoUrl": "https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/sponsor-1704398421000-logo.png",
    "createdAt": "2024-01-04T12:34:56.789Z"
  }
}
```

#### Response (Error - 400/500)

**Missing Required Fields (400):**
```json
{
  "error": "Missing required fields",
  "message": "organization and contactEmail are required"
}
```

**Invalid Sponsor Tier (400):**
```json
{
  "error": "Invalid sponsor tier",
  "message": "sponsorTier must be one of: bronze, silver, gold, diamond"
}
```

---

## Frontend Integration

### Sponsor Form Submission

The sponsor form in `public/advertiser.html` submits directly to the API with logo upload.

**Flow:**
1. User fills out sponsor form
2. User uploads logo (PNG or SVG)
3. User clicks "Submit Sponsorship Application"
4. Form data + logo file submitted to `/api/sponsor/submit`
5. Logo uploaded to R2
6. Database record created
7. Success alert shown to user

**Key JavaScript Function:**
```javascript
document.getElementById('sponsorForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  
  const formData = new FormData();
  formData.append('organization', document.getElementById('sp-org').value);
  formData.append('contactEmail', document.getElementById('sp-email').value);
  formData.append('website', document.getElementById('sp-website').value);
  formData.append('einTaxId', document.getElementById('sp-ein').value);
  formData.append('sponsorTier', document.querySelector('input[name="tier"]:checked')?.value || '');
  
  const logoInput = document.getElementById('sp-logo');
  if (logoInput.files[0]) {
    formData.append('logo', logoInput.files[0]);
  }

  const response = await fetch('/api/sponsor/submit', {
    method: 'POST',
    body: formData
  });
  
  const data = await response.json();
  // Handle response...
});
```

---

## Testing with cURL

### Test Sponsor Submission (with logo)

```bash
curl -X POST http://localhost:3001/api/sponsor/submit \
  -F "organization=Tech Foundation" \
  -F "contactEmail=contact@techfoundation.org" \
  -F "website=https://techfoundation.org" \
  -F "einTaxId=12-3456789" \
  -F "sponsorTier=gold" \
  -F "logo=@/path/to/logo.png"
```

### Test Sponsor Submission (no logo)

```bash
curl -X POST http://localhost:3001/api/sponsor/submit \
  -F "organization=Community Sponsor" \
  -F "contactEmail=info@communitysponsor.org" \
  -F "sponsorTier=bronze"
```

### Test Invalid Sponsor Tier (should fail)

```bash
curl -X POST http://localhost:3001/api/sponsor/submit \
  -F "organization=Test Org" \
  -F "contactEmail=test@example.com" \
  -F "sponsorTier=platinum"
```

**Expected Error Response:**
```json
{
  "error": "Invalid sponsor tier",
  "message": "sponsorTier must be one of: bronze, silver, gold, diamond"
}
```

### Expected Success Response

```json
{
  "success": true,
  "message": "Sponsor submission received successfully",
  "data": {
    "id": 1,
    "organization": "Tech Foundation",
    "contactEmail": "contact@techfoundation.org",
    "logoUrl": "https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/sponsor-1704398421000-logo.png",
    "createdAt": "2024-01-04T12:34:56.789Z"
  }
}
```

---

## Error Handling

### Common Errors

1. **Missing Required Fields (400)**
   ```json
   {
     "error": "Missing required fields",
     "message": "organization and contactEmail are required"
   }
   ```

2. **Logo Upload Failed (500)**
   ```json
   {
     "error": "Logo upload failed",
     "message": "Failed to upload logo file to storage"
   }
   ```

3. **Database Connection Error (500)**
   ```json
   {
     "error": "Database connection not available"
   }
   ```

4. **General Server Error (500)**
   ```json
   {
     "error": "Internal server error",
     "message": "Failed to submit sponsor application. Please try again later."
   }
   ```

---

## Admin Workflow

### Reviewing Submissions

Query all pending sponsor submissions:
```sql
SELECT * FROM sponsors 
WHERE approved = false
ORDER BY created_at DESC;
```

Query sponsors by tier:
```sql
SELECT * FROM sponsors 
WHERE sponsor_tier = 'gold' AND approved = true
ORDER BY created_at DESC;
```

### Approve a Submission

```sql
UPDATE sponsors 
SET approved = true
WHERE id = <sponsor_id>;
```

### View Logo Files

All uploaded logos are publicly accessible via the `logo_r2_link`:
```
https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/sponsor-<timestamp>-<filename>
```

Simply open the `logo_r2_link` from the database record to view the uploaded logo.

---

## Column Mapping (Form → Database)

| Form Field | Database Column |
|------------|----------------|
| `sp-org` (organization) | `organization` |
| `sp-email` (contactEmail) | `contact_email` |
| `sp-website` (website) | `website` |
| `sp-ein` (einTaxId) | `ein_tax_id` |
| `tier` (sponsorTier) | `sponsor_tier` |
| `sp-logo` (logo file) | `logo_r2_link` (URL) |

---

## Sponsor Tiers

The form supports four sponsorship tiers:

1. **Bronze** - $50
   - Logo in ad reel
   - Leaderboard listing

2. **Silver** - $100
   - Bronze benefits +
   - Dedicated static placement (2s)
   - Top-tier ranking

3. **Gold** - $250
   - Silver benefits +
   - Extended static placement (4s)
   - Featured homepage slot

4. **Diamond** - $500
   - Gold benefits +
   - Extended static placement (6s)
   - Priority placement in sponsor reel
   - Rotating homepage hero slot

---

## File Structure

### Backend Files Modified
- `backend/server.js`: R2 client config, multer config, `/api/sponsor/submit` endpoint
- `backend/database-postgres.js`: `sponsors` table creation

### Frontend Files Modified
- `public/advertiser.html`: Sponsor form submission handler

### Dependencies
- `@aws-sdk/client-s3`: S3-compatible client for Cloudflare R2
- `multer`: Multipart form data handling for file uploads

---

## Security Considerations

1. **File Size Limit**: 50MB enforced by multer
2. **File Type Validation**: Frontend accepts only PNG and SVG
3. **Filename Sanitization**: Special characters removed, `sponsor-` prefix + timestamp added
4. **No Authentication Required**: Public submission endpoint (as per design)
5. **SQL Injection Protection**: Parameterized queries used throughout
6. **CORS**: Ensure CORS allows form submissions from your domain

---

## Next Steps for Production

1. **Add Email Notifications**: Send confirmation emails to sponsors
2. **Add Admin Notifications**: Alert admins of new sponsor applications
3. **Add Stripe Integration**: Process sponsorship payments
4. **Add Admin Dashboard**: Create UI for reviewing/approving sponsors
5. **Add Rate Limiting**: Prevent spam submissions
6. **Environment Variables**: Move R2 credentials to `.env` file
7. **Add Validation**: More robust server-side validation
8. **Add File Scanning**: Scan uploaded images for malware/viruses
9. **Image Optimization**: Automatically resize/optimize logos
10. **Logo Preview**: Show uploaded logo before submission

---

## Integration with Advertiser System

Both sponsors and advertisers use:
- Same R2 bucket (`advertiser-media`)
- Same R2 credentials
- Same multer configuration
- Same file size limits

Differences:
- Sponsors: `logo` field → `logo_r2_link` column, filename prefix `sponsor-`
- Advertisers: `creative` field → `media_r2_link` column, filename prefix is timestamp only

---

## Support

For issues or questions about this system, contact the development team or refer to:
- Cloudflare R2 Docs: https://developers.cloudflare.com/r2/
- Multer Docs: https://github.com/expressjs/multer
- AWS SDK for JavaScript v3: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/

