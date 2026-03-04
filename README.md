# Wishlist + Manhwa Tracker (GitHub Pages)

Static site with three pages:
- `index.html`: wishlist
- `manhwa.html`: reading tracker
- `faves.html`: faves tracker

Both pages save locally and can optionally sync with account login.

## Features
- Wishlist add/edit/delete + drag reorder
- Manhwa tracker with type/genre/status filters + cover upload
- Faves tracker for title + chapter + link + cover
- Local browser save (`localStorage`)
- Optional email/password login + cloud sync (Firebase Auth + Firestore)

## Local data safety
Enabling login does **not** wipe your current lists.
- Existing local items stay in `localStorage`.
- On first login, local and cloud lists are merged safely.
- Local backups are kept under `wishlist-items-v1-backup-v1` and `manhwa-items-v1-backup-v1`.

## Firebase setup (for phone + computer sync)
1. Create a Firebase project.
2. Enable `Authentication` -> `Email/Password`.
3. Create Firestore database.
4. In Firebase project settings, create a web app and copy the config.
5. Paste config values into `firebase-config.js`.
6. Deploy/push to GitHub Pages.

## Firestore rules (minimum)
Use rules that allow users to access only their own data:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/lists/{listId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## Publish to GitHub Pages
1. Commit and push to `main`.
2. Repo `Settings` -> `Pages`.
3. Source: `Deploy from a branch`.
4. Branch: `main`, folder: `/ (root)`.
5. Open: `https://<username>.github.io/<repo>/`.
