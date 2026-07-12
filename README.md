# AkZ Piling Status

Ver `1.0.0`

AkZ Piling Status is a local-first web app/PWA for tracking piling progress from uploaded PDF setting-out drawings. It runs in a browser on Windows, Android, and iOS, and can be hosted as static files so anyone with the link can use the same app revision.

## What It Tracks

- Uploaded PDF drawing metadata
- Project title and drawing title extracted from the PDF text layer where available
- Grid letters and grid numbers as separate editable lists
- Pile numbers / points with an editable grid dropdown
- Piling date
- Penetration depth
- Remarks and full local history per pile

## PDF Workflow

1. Upload one or more PDF drawings.
2. Review the extracted project title, drawing title, grid, and pile register.
3. If pile numbers are not readable from the PDF text layer, add them with the range tool, for example `1` to `464`.
4. Record piling date and penetration depth against each pile number / grid.
5. Export CSV or a PDF output based on the original uploaded PDF.

The exported PDF keeps the original drawing and appends AkZ Piling Status summary pages with the latest pile records. A small status stamp is added to the original drawing page.

## Local Data

Records are stored locally in the user's browser:

- Metadata and piling records use `localStorage`.
- Original uploaded PDF bytes use `IndexedDB` so the app can generate PDF outputs later.
- App revisions update from the hosted files without clearing local records.
- Data is only removed when the user removes a drawing or clears local data in the app.

## Versioning

The visible app version is fixed at the bottom right of the screen.

- Minor revision: `Ver1.0.1`
- Major revision: `Ver1.1.0`

Update `index.html`, `app.js`, `manifest.webmanifest`, `sw.js`, and this README when the version changes.

## Open Locally

Open `index.html` directly for basic testing. For PWA and PDF library behavior, serve the folder over HTTP and open the local server URL.
