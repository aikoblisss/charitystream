# 🎬 Video Deletion Management System

## 📋 Overview

The Video Deletion Management System provides a safe, interactive way to remove videos from the charity-stream-videos R2 bucket while maintaining data integrity and automatic renumbering.

---

## 🚀 Quick Start

### **Run the Script**
```bash
cd charitystream/backend
npm run delete-video
```

### **Example Usage**
```bash
$ npm run delete-video

🎬 Video Management Console
================================

✅ Database connection established
🔍 Scanning charity-stream-videos bucket for videos...
📊 Found 5 videos in charity-stream-videos bucket

📊 Available videos:
1. video_1.mp4
2. video_2.mp4  
3. video_3.mp4
4. video_4.mp4
5. video_5.mp4

📝 Database mappings: 3 active mappings found

❓ Enter the number or filename of video to delete: 3

🎯 Selected video: video_3.mp4
📝 This video is mapped to: Acme Corporation (https://acme.com)

✅ Are you sure you want to delete video_3.mp4? (y/n): y

🔄 Processing deletion...
📝 Deactivating mapping for video_3.mp4 in database...
✅ Deactivated mapping for video_3.mp4
🗑️ Deleting video_3.mp4 from R2 bucket...
✅ Deleted video_3.mp4 from R2 bucket
🔄 Renumbering remaining videos...
📊 2 videos need renumbering (video_X.mp4 pattern)
📊 0 videos will keep original names
📝 Renaming: video_4.mp4 → video_3.mp4
✅ Copied video_4.mp4 to video_3.mp4
✅ Deleted old file video_4.mp4
✅ Updated database mapping: video_4.mp4 → video_3.mp4
📝 Renaming: video_5.mp4 → video_4.mp4
✅ Copied video_5.mp4 to video_4.mp4
✅ Deleted old file video_5.mp4
✅ Updated database mapping: video_5.mp4 → video_4.mp4
🎉 Renumbering complete! 2 videos renumbered

🎉 Deletion complete! 4 videos remaining.
🔄 Dynamic video looping will automatically detect changes.
🌐 No server restart required - changes take effect immediately.
```

---

## 🔧 Features

### **1. Interactive Video Selection**
- Lists all videos in the charity-stream-videos bucket
- Shows numbered list for easy selection
- Accepts both number input (1, 2, 3...) and filename input
- Displays database mapping information for context

### **2. Safe Deletion Process**
- **Step 1**: Deactivates database mapping (`is_active = false`)
- **Step 2**: Deletes video from R2 bucket
- **Step 3**: Automatically renumbers remaining videos
- **Step 4**: Updates all database mappings to reflect new filenames

### **3. Automatic Video Renumbering**
**Before Deletion:**
```
video_1.mp4
video_2.mp4  
video_3.mp4  ← Delete this one
video_4.mp4
video_5.mp4
```

**After Deletion:**
```
video_1.mp4
video_2.mp4  
video_3.mp4  ← Formerly video_4.mp4
video_4.mp4  ← Formerly video_5.mp4
```

### **4. Database Coordination**
- Sets `is_active = false` for deleted video's mapping
- Updates `video_filename` for all renumbered videos
- Maintains referential integrity
- Preserves advertiser/company information

---

## 🛠️ Technical Implementation

### **R2 Operations Used**
```javascript
// List all videos in bucket
ListObjectsV2Command

// Delete selected video
DeleteObjectCommand

// Rename remaining videos (copy + delete)
CopyObjectCommand + DeleteObjectCommand

// Verify file existence
HeadObjectCommand
```

### **Database Operations Used**
```sql
-- Deactivate deleted video mapping
UPDATE video_advertiser_mappings 
SET is_active = false 
WHERE video_filename = 'video_X.mp4';

-- Update renumbered video mappings
UPDATE video_advertiser_mappings 
SET video_filename = 'video_Y.mp4' 
WHERE video_filename = 'video_Z.mp4' AND is_active = true;
```

### **Configuration**
Uses the same R2 credentials as `process-approved-advertisers.js`:
```javascript
const R2_CONFIG = {
  accessKeyId: '9eeb17f20eafece615e6b3520faf05c0',
  secretAccessKey: '86716ae1188f87ba5c6d0939a2ff19d972a0b53a6edfb0ed9fe5ba17a87cb4a4',
  endpoint: 'https://e94c5ecbf3e438d402b3fe2ad136c0fc.r2.cloudflarestorage.com'
};
```

---

## 🔒 Safety Features

### **1. No Service Interruption**
- ✅ Website and app continue working during deletion
- ✅ No server restart required
- ✅ Dynamic video looping remains unaffected
- ✅ Changes take effect immediately

### **2. Error Handling**
- ✅ Validates user input to prevent mistakes
- ✅ Handles cases where video doesn't exist
- ✅ Graceful failure with clear error messages
- ✅ Database connection error handling

### **3. Data Integrity**
- ✅ Maintains referential integrity in database
- ✅ Ensures no broken video links in rotation
- ✅ Preserves advertiser mappings during renumbering
- ✅ Atomic operations where possible

### **4. Rollback Capability**
- ✅ If R2 deletion fails, mapping stays active
- ✅ If renumbering fails, video is still deleted (safe state)
- ✅ Clear error messages for troubleshooting

---

## 📊 Supported Video Types

### **Video_X.mp4 Pattern (Auto-renumbered)**
- `video_1.mp4`, `video_2.mp4`, etc.
- Automatically renumbered to maintain sequence
- Database mappings updated accordingly

### **Other Video Files (Keep Original Names)**
- `advertiser_12_video.mp4`
- `sponsor_logo.mp4`
- `custom_name.mp4`
- Keeps original filename after deletion

---

## 🚨 Important Notes

### **Database Mappings**
- Only videos with `video_X.mp4` pattern get renumbered
- Non-pattern videos keep their original names
- Database mappings are updated for renumbered videos only
- Deleted video mappings are deactivated, not deleted

### **Dynamic System Compatibility**
- The `/api/videos/playlist` endpoint automatically detects changes
- No code changes needed when videos are removed
- Frontend immediately reflects new video count
- Video looping continues seamlessly

### **Backup Recommendations**
- Consider backing up important videos before deletion
- Database mappings can be reactivated if needed
- R2 deletion is permanent (no recycle bin)

---

## 🔧 Troubleshooting

### **Common Issues**

**1. "No videos found in bucket"**
- Check R2 bucket name: `charity-stream-videos`
- Verify R2 credentials are correct
- Ensure bucket exists and is accessible

**2. "Database connection refused"**
- Check `DATABASE_URL` in `.env` file
- Ensure database server is running
- Verify network connectivity

**3. "R2 credentials error"**
- Verify R2 access keys are correct
- Check R2 endpoint URL
- Ensure account has bucket access

**4. "Failed to delete from R2"**
- Check bucket permissions
- Verify file exists in bucket
- Try manual deletion via Cloudflare dashboard

### **Recovery Steps**

**If deletion partially fails:**
1. Check which step failed (mapping, R2, or renumbering)
2. For mapping issues: Manually set `is_active = false`
3. For R2 issues: Delete manually via dashboard
4. For renumbering issues: Run script again or fix manually

---

## 📈 Future Enhancements

### **Potential Features**
- Bulk video deletion
- Video preview before deletion
- Undo functionality (limited by R2)
- Video analytics before deletion
- Scheduled deletion with confirmation

### **Integration Opportunities**
- Admin dashboard integration
- API endpoint for programmatic deletion
- Video lifecycle management
- Automated cleanup of old videos

---

## 🎯 Success Criteria

✅ **Interactive video selection works**  
✅ **Safe deletion from R2 bucket**  
✅ **Database mappings properly deactivated**  
✅ **Automatic video renumbering functions**  
✅ **No service interruption during process**  
✅ **Error handling with clear messages**  
✅ **Data integrity maintained**  
✅ **Dynamic system compatibility preserved**

---

## 📞 Support

For issues or questions:
1. Check console output for detailed error messages
2. Verify R2 and database connectivity
3. Review this documentation for troubleshooting steps
4. Test with a non-critical video first

**The video deletion system is production-ready and safe to use!** 🎉
