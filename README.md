# E*TRADE Confirmation Downloader

Unpacked Chrome extension for downloading visible E*TRADE confirmation PDFs from the current page.

It supports:

- `View Confirmation Of Purchase`
- `View Confirmation Of Release`
- trade-confirmation document rows such as `COMPANY NAME / DOCUMENT_ID`

## Install Locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:

   the `etrade-confirmation-downloader` folder from this workspace

## Use

1. Open the relevant E*TRADE page.
2. Expand or filter the sections/rows you want downloaded.
3. Click **Download confirmations** in the bottom-right overlay.

Chrome saves the PDFs under your Downloads folder in a timestamped folder:

`etrade-confirmations/<timestamp>/`

PDF filenames use:

`yyyy-mm-dd_##_type_confirmation.pdf`

The extension also downloads `manifest.json` and `links.txt`.
