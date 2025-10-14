# Advertiser/Sponsor Submission System

## Overview

This system handles form submissions from the `/advertise/company` page for both **Advertisers** (companies running ad campaigns) and **Sponsors** (organizations providing financial support). Each submission includes:

1. Form data (company info, budget, CPM rates, etc.)
2. File upload (video or static image) to Cloudflare R2
3. Database record insertion into the `advertisers` table

---

## Cloudflare R2 Configuration

### Credentials
- **Public Dev URL**: `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev`
- **Bucket Name**: `advertiser-media`
- **Access Key ID**: `9eeb17f20eafece615e6b3520faf05c0`
- **Secret Access Key**: `86716ae1188f87ba5c6d0939a2ff19d972a0b53a6edfb0ed9fe5ba17a87cb4a4`
- **Account Endpoint**: `https://5077a490479046dbac97642d6ea9aa70.r2.cloudflarestorage.com`

### File Upload Rules
- Filenames are made unique by prepending a timestamp (e.g., `1704398421000-video.mp4`)
- Accepted file types: MP4 videos, PNG/JPG images
- Max file size: 50MB
- Public URL format: `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/<unique_filename>`

---

## Database Schema

### Table: `advertisers`

```sql
CREATE TABLE IF NOT EXISTS advertisers (
  id SERIAL PRIMARY KEY,
  company_name TEXT,
  website_url TEXT,
  first_name TEXT,
  last_name TEXT,
  email TEXT NOT NULL,
  title_role TEXT,
  ad_format TEXT,                             -- 'video' or 'static'
  weekly_budget_cap DECIMAL(10,2),
  cpm_rate DECIMAL(10,2),
  media_r2_link TEXT,                         -- R2 public URL
  recurring_weekly BOOLEAN DEFAULT false,
  approved BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

---

## API Endpoint

### `POST /api/advertiser/submit`

Handles advertiser campaign submissions.

#### Headers
- `Content-Type: multipart/form-data` (automatically set by FormData)

#### Request Body (FormData)

**Required Fields:**
- `email` (required): Contact email

**Optional Fields:**
- `companyName`: Company or organization name
- `websiteUrl`: Company website URL
- `firstName`: Contact first name
- `lastName`: Contact last name
- `jobTitle`: Contact title/role
- `adFormat`: `"video"` or `"static"`
- `weeklyBudget`: Budget cap in dollars (e.g., `"500"`)
- `cpmRate`: Cost per thousand impressions (e.g., `"0.25"`)
- `isRecurring`: `"true"` or `"false"` for recurring weekly campaigns
- `creative` (file): Video or image upload (MP4, PNG, JPG)

#### Response (Success - 200)
```json
{
  "success": true,
  "message": "Advertiser submission received successfully",
  "data": {
    "id": 123,
    "email": "contact@company.com",
    "mediaUrl": "https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/1704398421000-video.mp4",
    "createdAt": "2024-01-04T12:34:56.789Z"
  }
}
```

#### Response (Error - 400/500)
```json
{
  "error": "Missing required fields",
  "message": "email is required"
}
```

---

## Frontend Integration

### Advertiser Form Submission

The advertiser form in `public/advertiser.html` uses a modal system for enhancements before submission.

**Flow:**
1. User fills out form and clicks "Launch Campaign"
2. Enhancement modal appears with optional add-ons
3. User clicks "Skip" or "Add Enhancements"
4. Form data is collected and submitted via `processSubmission(withEnhancements)`
5. Success modal shows confirmation

**Key JavaScript Function:**
```javascript
async function processSubmission(withEnhancements) {
  const formData = new FormData();
  formData.append('companyName', document.getElementById('companyName').value);
  formData.append('websiteUrl', document.getElementById('websiteUrl').value);
  formData.append('firstName', document.getElementById('firstName').value);
  formData.append('lastName', document.getElementById('lastName').value);
  formData.append('email', document.getElementById('email').value);
  formData.append('jobTitle', document.getElementById('jobTitle').value);
  formData.append('adFormat', document.querySelector('input[name="adFormat"]:checked')?.value || '');
  formData.append('weeklyBudget', budget);
  formData.append('cpmRate', finalCPM);
  formData.append('isRecurring', recurring);
  
  if (fileInput.files[0]) {
    formData.append('creative', fileInput.files[0]);
  }

  const response = await fetch('/api/advertiser/submit', {
    method: 'POST',
    body: formData
  });
  
  const data = await response.json();
  // Handle response...
}
```

---

## Testing with cURL

### Test Advertiser Submission (with file)

```bash
curl -X POST http://localhost:3001/api/advertiser/submit \
  -F "companyName=Acme Corp" \
  -F "websiteUrl=https://acme.com" \
  -F "firstName=John" \
  -F "lastName=Doe" \
  -F "email=john@acme.com" \
  -F "jobTitle=Marketing Director" \
  -F "adFormat=video" \
  -F "weeklyBudget=500" \
  -F "cpmRate=0.25" \
  -F "isRecurring=true" \
  -F "creative=@/path/to/video.mp4"
```

### Test Advertiser Submission (no file)

```bash
curl -X POST http://localhost:3001/api/advertiser/submit \
  -F "companyName=Tech Company" \
  -F "email=contact@techcompany.com" \
  -F "adFormat=static" \
  -F "weeklyBudget=250" \
  -F "cpmRate=0.15" \
  -F "isRecurring=false"
```

### Expected Success Response

```json
{
  "success": true,
  "message": "Advertiser submission received successfully",
  "data": {
    "id": 1,
    "email": "john@acme.com",
    "mediaUrl": "https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/1704398421000-video.mp4",
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
     "message": "submissionType and email are required"
   }
   ```

2. **Invalid Submission Type (400)**
   ```json
   {
     "error": "Invalid submission type",
     "message": "submissionType must be either 'advertiser' or 'sponsor'"
   }
   ```

3. **File Upload Failed (500)**
   ```json
   {
     "error": "File upload failed",
     "message": "Failed to upload media file to storage"
   }
   ```

4. **Database Connection Error (500)**
   ```json
   {
     "error": "Database connection not available"
   }
   ```

5. **General Server Error (500)**
   ```json
   {
     "error": "Internal server error",
     "message": "Failed to submit application. Please try again later."
   }
   ```

### File Type Validation

Multer middleware validates file types. Invalid files return:
```json
{
  "error": "Invalid file type. Only MP4 videos and PNG/JPG images are allowed."
}
```

---

## Admin Workflow

### Reviewing Submissions

Query all pending submissions:
```sql
SELECT * FROM advertisers 
WHERE approved = false AND payment_status = 'pending'
ORDER BY created_at DESC;
```

### Approve a Submission

```sql
UPDATE advertisers 
SET approved = true, payment_status = 'approved'
WHERE id = <submission_id>;
```

### View Media Files

All uploaded media URLs are publicly accessible:
```
https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/<filename>
```

Simply open the `media_url` from the database record to view the uploaded file.

---

## File Structure

### Backend Files Modified
- `backend/server.js`: R2 client config, multer config, `/api/advertiser/submit` endpoint
- `backend/database-postgres.js`: `advertisers` table creation

### Frontend Files Modified
- `public/advertiser.html`: Advertiser form submission, sponsor form submission

### Dependencies Added
- `@aws-sdk/client-s3`: S3-compatible client for Cloudflare R2
- `multer`: Multipart form data handling for file uploads

---

## Security Considerations

1. **File Size Limit**: 50MB enforced by multer
2. **File Type Validation**: Only MP4, PNG, JPG allowed
3. **Filename Sanitization**: Special characters removed, timestamp prepended
4. **No Authentication Required**: Public submission endpoint (as per design)
5. **SQL Injection Protection**: Parameterized queries used throughout
6. **CORS**: Ensure CORS allows form submissions from your domain

---

## Next Steps for Production

1. **Add Email Notifications**: Send confirmation emails to submitters
2. **Add Admin Notifications**: Alert admins of new submissions
3. **Add Stripe Integration**: Process payments for advertisers
4. **Add Admin Dashboard**: Create UI for reviewing/approving submissions
5. **Add Rate Limiting**: Prevent spam submissions
6. **Environment Variables**: Move R2 credentials to `.env` file
7. **Add Validation**: More robust server-side validation of form fields
8. **Add File Scanning**: Scan uploaded files for malware/viruses

---

## Support

For issues or questions about this system, contact the development team or refer to:
- Cloudflare R2 Docs: https://developers.cloudflare.com/r2/
- Multer Docs: https://github.com/expressjs/multer
- AWS SDK for JavaScript v3: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/

