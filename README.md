# AkZ Piling Status

Ver `1.0.2`

AkZ Piling Status is a local-first web app/PWA for tracking piling progress from uploaded PDF setting-out drawings. It runs in a browser on Windows, Android, and iOS, and can be hosted as static files so anyone with the link can use the same app revision.

## What It Tracks

- Uploaded PDF drawing metadata
- Project title and drawing title extracted from the PDF text layer where available
- X/Y grid letters and numbers detected from drawing grid lines where available
- Pile numbers / points with an editable grid dropdown
- Piling date
- Penetration depth
- Remarks and full local history per pile

## PDF Workflow

1. Upload one or more PDF drawings.
2. Review the extracted project title, drawing title, grid, and pile register.
3. The app scans the rendered drawing for red pile-number labels and X/Y grid axes.
4. Record piling date and penetration depth against each pile number / grid.
5. Export CSV or a PDF output based on the original uploaded PDF.

The exported PDF keeps the original drawing, writes saved piling date/depth notes in blue near the recorded pile locations, and appends AkZ Piling Status summary pages with the latest pile records. A small status stamp is added to the original drawing page.

## Visual Extraction

The app uses PDF.js to render page 1 of the drawing in the browser, then:

- Detects the main plan area from red drawing marks.
- Detects X-axis grid lines and labels them `A, B, C...`, skipping `I`.
- Detects Y-axis grid lines from the left-side grid extension and labels them `1, 2, 3...`.
- Runs digit-only OCR on the red pile-number labels.
- When a dense sequence such as `1..464` is detected, drops OCR outliers and fills missed sequence numbers by interpolating from nearby detected labels.

All extracted pile numbers and grids remain editable in the review table.

## PDF Markups

When exporting PDF after saving progress records:

- Each recorded pile with a detected drawing coordinate gets a compact blue note beside the pile point.
- The note uses `DD/MM depth`, for example `12/07 18.2m`.
- Notes are offset from the pile point and collision-checked so they do not stack directly on top of each other.
- Piles added manually without drawing coordinates still appear in the summary pages.

## Local Data

Records are stored locally in the user's browser:

- Metadata and piling records use `localStorage`.
- Original uploaded PDF bytes use `IndexedDB` so the app can generate PDF outputs later.
- App revisions update from the hosted files without clearing local records.
- Data is only removed when the user removes a drawing or clears local data in the app.

## Versioning

The visible app version is fixed at the bottom right of the screen.

- Minor revision: `Ver1.0.2`
- Major revision: `Ver1.1.0`

Update `index.html`, `app.js`, `manifest.webmanifest`, `sw.js`, and this README when the version changes.

## Open Locally

Open `index.html` directly for basic testing. For PWA and PDF library behavior, serve the folder over HTTP and open the local server URL.
