# Focus Reader

Read one sentence at a time. Built for people with ADHD who lose their place mid-sentence and end up re-reading.

The page dims, the current sentence is highlighted, and your position is remembered. It works on web pages, PDFs and documents, can read aloud, and has speed and voice controls.

## What's here

- `extension/`: the Chrome extension (Manifest V3).
- `extension/reader/`: the standalone reader (PDF, Word, PowerPoint, EPUB, Markdown, HTML, text, pasted text). The extension bundles it, and the same folder can be hosted as a static website.

## Install the extension (Chrome, Edge, Brave)

1. Clone or download this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension` folder.

Click the toolbar icon or press **Alt+Shift+R**:

- On a web page, the page dims and one sentence is highlighted.
- On a PDF tab, the PDF opens in the built-in reader.
- On a new tab, the built-in reader opens with a drop zone, a link field and a paste box.

| Key | Action |
| --- | --- |
| → / ↓ / Space / J | Next sentence |
| ← / ↑ / K | Previous sentence |
| Click a sentence | Jump to it |
| S | Read aloud, auto-advancing |
| Esc | Exit (on web pages) |

The bar has **Speed** (0.25× to 3×) and **Voice** (every voice installed on your device, grouped by language and accent).

## Host the reader as a website

`extension/reader/` is plain static files with no build step. Serve that folder from any static host (GitHub Pages, Netlify, Render, etc.). Files dropped into it are parsed in the browser and never uploaded. Reading from a link only works inside the extension, because websites block other sites from fetching their pages.

## Limits

- Scanned PDFs (images of pages with no selectable text) are not supported yet.
- Old `.doc`, `.ppt` and `.rtf` files need saving as PDF or `.docx` first.
- Local PDFs: drop the file into the reader, or enable "Allow access to file URLs" for the extension.
- Voices come from your operating system and browser, so the list differs by device.

## License

MIT
