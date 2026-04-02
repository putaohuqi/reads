# Reads

A small GitHub Pages site for tracking reads, saving favorite chapters, and building EPUBs from supported web-novel sources.

`index.html` redirects to [`manhwa.html`](manhwa.html), so the app effectively has three main pages:

- [`manhwa.html`](manhwa.html): reading tracker
- [`faves.html`](faves.html): saved favorite chapters
- [`epub.html`](epub.html): EPUB downloader + download history

## What It Does

### Reads
- Track series by title, link, current chapter, status, type, genre, cover, and notes
- Organize entries into `ongoing`, `want to read`, and `completed`
- Filter by status, type, genre, and search text
- Upload a cover from device or paste a cover URL
- Export tracker notes

### Faves
- Save standout chapters with title, chapter, link, type, genre, and cover
- Search and filter by type and genre
- Drag to reorder saved entries
- Upload a cover from device or paste a cover URL

### EPUB Downloader
- Search ReadHive titles directly from the page
- Open Novel Updates when ReadHive has no match
- Fetch novel info from supported source URLs
- Download EPUBs through a local Python server
- Edit saved author and cover metadata from download history
- Add external EPUBs to history manually for safekeeping
- Show a WebToEpub helper for unsupported sites

## Supported EPUB Sources

The local EPUB flow currently supports:

- `readhive.org`
- compatible public `wordpress.com` translator sites

When a pasted site is not supported directly:

- the page shows a clear error instead of failing silently
- if it looks like a web-reading source, it offers a WebToEpub helper
- if ReadHive search has no result, it offers a Novel Updates search button

## Local Server Setup

The EPUB page depends on the Flask server in [`NOVEL-TO-EPUB/readhive_server.py`](NOVEL-TO-EPUB/readhive_server.py).

Install Python dependencies once:

```bash
pip3 install -r NOVEL-TO-EPUB/requirements.txt
```

Then run the local server from the project root:

```bash
cd "/Users/hujiaqi/Downloads/PERSONAL SITES/READS" && python3 NOVEL-TO-EPUB/readhive_server.py
```

The server runs on `http://localhost:7842`.

## Sync And Storage

All three pages work in local-only mode first, then optionally sync through Firebase Auth + Firestore.

- local data is stored in `localStorage`
- signing in does not wipe existing local data
- local and cloud data are merged when syncing
- per-list local backups are kept by the shared auth/sync layer
- EPUB download history syncs too when signed in

The shared sync/auth logic lives in [`auth-sync.js`](auth-sync.js).

## Firebase Setup

If you are cloning this repo for your own project, update [`firebase-config.js`](firebase-config.js) with your own Firebase web app config.

Minimum setup:

1. Create a Firebase project.
2. Enable `Authentication` with `Email/Password`.
3. Create a Firestore database.
4. Create a web app in Firebase project settings.
5. Replace the config values in `firebase-config.js`.

Suggested Firestore rules:

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

## PWA / Icons

The site includes:

- [`manifest.webmanifest`](manifest.webmanifest)
- favicon + touch icon assets
- standalone install support with `start_url` set to `manhwa.html`

## Deploying To GitHub Pages

1. Commit and push to `main`.
2. In GitHub, open `Settings` -> `Pages`.
3. Set source to `Deploy from a branch`.
4. Choose `main` and `/ (root)`.
5. Open the published site at `https://<username>.github.io/<repo>/`.

## Project Files

- [`manhwa.html`](manhwa.html): main reading tracker
- [`faves.html`](faves.html): favorite chapters page
- [`epub.html`](epub.html): EPUB UI
- [`manhwa.js`](manhwa.js): reads page logic
- [`favourite-chapters.js`](favourite-chapters.js): faves page logic
- [`auth-sync.js`](auth-sync.js): shared auth + sync layer
- [`NOVEL-TO-EPUB/readhive_server.py`](NOVEL-TO-EPUB/readhive_server.py): local EPUB server
