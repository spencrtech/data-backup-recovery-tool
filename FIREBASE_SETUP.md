# Firebase Storage Setup Guide

## Overview
The backup service now supports automatic upload of backup files to Firebase Storage. This guide will walk you through setting up Firebase Storage for your database backups.

## Prerequisites
- Firebase project created
- Firebase Admin SDK access

## Step 1: Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Add project" or select an existing project
3. Follow the setup wizard

## Step 2: Enable Firebase Storage

1. In your Firebase project, go to **Build** → **Storage**
2. Click "Get started"
3. Choose your security rules (you can start in test mode and tighten later)
4. Select a Cloud Storage location (choose closest to your servers)
5. Click "Done"

## Step 3: Get Service Account Credentials

1. Go to **Project Settings** (gear icon) → **Service accounts**
2. Click "Generate new private key"
3. Download the JSON file
4. **IMPORTANT**: Keep this file secure! Never commit it to git
5. Save it in your project directory (e.g., `firebase-service-account.json`)

## Step 4: Configure databases.json

Update your `databases.json` configuration:

```json
{
  "id": "sylogate-prod",
  "name": "Sylogate Production",
  "backupFrom": {
    "uri": "mongodb+srv://...",
    "database": "sylogate"
  },
  "restoreTo": {
    "uri": "mongodb+srv://...",
    "database": "sylogate-restore"
  },
  "backupSchedule": "0 2 * * *",
  "restoreSchedule": "",
  "retentionDays": 30,
  "enabled": true,
  "storage": {
    "local": {
      "enabled": true,
      "path": "./backups"
    },
    "firebase": {
      "enabled": true,
      "serviceAccountPath": "./firebase-service-account.json",
      "bucketName": "your-project-id.appspot.com",
      "basePath": "backups/sylogate-prod"
    }
  }
}
```

### Configuration Fields:

#### `storage.local`
- **enabled**: Keep backups locally (recommended: `true`)
- **path**: Local directory for backups

#### `storage.firebase`
- **enabled**: Upload to Firebase Storage (`true` or `false`)
- **serviceAccountPath**: Path to your Firebase service account JSON file
- **bucketName**: Your Firebase Storage bucket name (found in Firebase Console → Storage)
- **basePath**: Folder structure in Firebase Storage (e.g., `backups/database-name`)

## Step 5: Install Dependencies

```bash
npm install firebase-admin
```

## Step 6: Add to .gitignore

**CRITICAL**: Add your service account file to `.gitignore`:

```
# Firebase credentials
firebase-service-account.json
*.firebase.json
```

## Step 7: Test the Setup

1. Start your application:
```bash
npm start
```

2. Check logs for Firebase initialization:
```
✓ Initialized Firebase Storage for Sylogate Production
```

3. Trigger a manual backup from the UI
4. Check logs for upload confirmation:
```
Uploading backup_20260122T1400.tar.gz to Firebase Storage...
✓ Uploaded to Firebase: backups/sylogate-prod/backup_20260122T1400.tar.gz (25.3MB in 8s)
```

5. Verify in Firebase Console → Storage that the file appears

## How It Works

1. **Backup Process**:
   - Creates local backup with mongodump
   - Compresses to `.tar.gz` archive
   - Saves locally (if `storage.local.enabled = true`)
   - Uploads to Firebase (if `storage.firebase.enabled = true`)
   - Logs backup event with Firebase info in tracking database

2. **Dual Storage**:
   - You can enable both local and Firebase storage simultaneously
   - Local backups are used for quick restores
   - Firebase backups provide off-site disaster recovery

3. **Backup History**:
   - History tracking includes Firebase upload information
   - Each backup log shows: `firebase: { bucket, path, uploadTime, fileSize }`

## Troubleshooting

### Error: "Failed to initialize Firebase Storage"
- Check that service account file path is correct
- Verify service account JSON is valid
- Ensure Firebase Storage is enabled in your project

### Error: "Firebase upload failed"
- Check bucket name matches your Firebase project
- Verify service account has Storage Admin permissions
- Check network connectivity to Firebase

### Slow Uploads
- Large backups take time to upload
- Consider compression settings in mongodump
- Check your internet upload speed
- Firebase upload progress is logged

## Security Best Practices

1. **Service Account Security**:
   - Never commit service account JSON to version control
   - Use environment variables for sensitive paths in production
   - Rotate service accounts periodically

2. **Storage Rules**:
   - Set up proper Firebase Storage security rules
   - Restrict write access to service accounts only
   - Consider bucket-level IAM policies

3. **Bucket Organization**:
   - Use separate buckets for dev/staging/production
   - Implement lifecycle policies for old backups
   - Enable versioning for critical backups

## Firebase Storage Rules Example

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /backups/{dbId}/{fileName} {
      // Only allow service account access
      allow read, write: if false;
    }
  }
}
```

## Cost Considerations

- Firebase Storage pricing: ~$0.026/GB/month
- Download costs: ~$0.12/GB
- Consider lifecycle policies to delete old backups
- Set up budget alerts in Google Cloud Console

## Support

For issues or questions:
- Check application logs: `logs/combined.log`
- Firebase documentation: https://firebase.google.com/docs/storage
- Firebase Admin SDK: https://firebase.google.com/docs/admin/setup
