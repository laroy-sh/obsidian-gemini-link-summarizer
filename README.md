# AI Link Summarizer (Obsidian Community Plugin)

Right-click a URL in the editor and run **Summarize link**.
The plugin sends the URL to your selected provider (Gemini or OpenAI), then inserts a concise summary into the current note on a new line **before the detected link**.

## Features

- Detects URLs from:
  - selected raw URLs (`https://...`)
  - selected Markdown links (`[label](https://...)`)
  - Markdown/raw link under cursor on right-click
- Adds editor context menu action: **Summarize link**
- Provider support:
  - Gemini via `@google/genai` + `urlContext`
  - OpenAI via `openai` + `web_search_preview`
- Inserts summary before the detected link (optional timestamp prefix)
- Settings:
  - Provider (Gemini/OpenAI)
  - Gemini API key + model
  - OpenAI API key + model
  - Gemini Flash model preset buttons
  - OpenAI model preset buttons
  - Summary length target (characters)
  - Custom prompt (optional)
  - Include timestamp
- Notices + clean errors for:
  - no URL found
  - invalid URL
  - provider request failure
  - unsupported/unreadable page
  - no active editor

## Build

1. Install dependencies:
   ```bash
   npm install
   ```
2. Build once:
   ```bash
   npm run build
   ```
3. Or watch during development:
   ```bash
   npm run dev
   ```

## Install In Obsidian

1. Build the plugin so `main.js` exists.
2. Copy these files to your vault plugin folder:
   - `manifest.json`
   - `main.js`
   - `styles.css` (empty here, but included for compatibility)
3. Target folder:
   - `<your-vault>/.obsidian/plugins/gemini-link-summarizer/`

Note: the folder/id is still `gemini-link-summarizer` for upgrade compatibility with existing installs.

4. In Obsidian:
   - **Settings -> Community plugins**
   - Enable **AI Link Summarizer**
   - Open plugin settings and set provider + API key + model

## How The Context Menu Hook Works

The plugin registers the official workspace event:

```ts
this.registerEvent(
  this.app.workspace.on("editor-menu", (menu, editor) => {
    // ...
  })
);
```

When you right-click in an editor, Obsidian provides the current `menu` and `editor`.
The plugin extracts a URL from the selection or link under cursor. If found, it adds **Summarize link** to that menu.

## Releases (GitHub Actions)

Pushing a version tag like `0.1.2` triggers a workflow that builds the plugin and uploads release assets:

- `main.js`
- `manifest.json`
- `versions.json`
- `styles.css`
- `obsidian-ai-link-summarizer-0.1.2.zip`

To publish:

```bash
git tag 0.1.2
git push origin 0.1.2
```

## Install From GitHub Release

1. Open the GitHub Release for your version tag.
2. Download either:
   - the zip (`obsidian-ai-link-summarizer-0.1.2.zip`), or
   - the individual files (`main.js`, `manifest.json`, `styles.css`, `versions.json`)
3. Extract/copy into:
   - `<your-vault>/.obsidian/plugins/gemini-link-summarizer/`
4. Reload/enable the plugin in Obsidian.
