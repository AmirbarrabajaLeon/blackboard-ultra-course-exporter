# 📦 Blackboard Ultra Course Exporter

A high-performance, client-side exporter tool designed for Blackboard Learn Ultra. It recursively traverses course content, downloads all attached files (PDF, DOCX, PPTX, XLSX, ZIP, etc.), converts rich text announcements/instructions into offline HTML documents, and packages everything into a neatly structured ZIP archive right inside your browser.

## ✨ Features

- 📂 **Complete Recursive Traversal:** Automatically navigates nested folders, modules, and documents.
- 📄 **Full Document & Attachment Preservation:** Downloads embedded attachments alongside written instructions without losing text.
- 📝 **Offline HTML Generation:** Converts announcements and rich-text assignments into standalone, styled offline `.html` pages.
- 🔗 **Smart Internet Shortcuts:** Saves external links as double-clickable `.url` Internet Shortcuts.
- 🔒 **Pure Client-Side & Zero Third-Party Servers:** Uses your browser's existing active session; no credentials or files ever touch an external backend.
- 🗜️ **In-Memory Compression:** Uses JSZip and FileSaver.js to build and download the archive seamlessly.

## 🚀 Installation & Usage

### Option 1: Tampermonkey Userscript (Recommended)

This mode injects a permanent "📥 Descargar Curso (.zip)" button directly into Blackboard Ultra's top header bar for one-click exports.

1. Install a userscript manager extension such as Tampermonkey or Violentmonkey.
2. Open the `blackboard-exporter.user.js` file in this repository and click **Raw** (or click the install link if viewing on GreasyFork).
3. Confirm the installation prompt in Tampermonkey.
4. Navigate to any course on Blackboard Ultra (`https://aulavirtual.upc.edu.pe/ultra/courses/...`), and click the newly injected download button in the header.

### Option 2: Standalone Browser Console (Zero Install)

Useful when working on public/library computers where browser extensions cannot be installed.

1. Navigate to the main page of the target course on Blackboard Ultra.
2. Open your browser's Developer Tools (`F12` or `Ctrl+Shift+I` / `Cmd+Option+I`) and select the **Console** tab.
3. Open `snippets/standalone-console.js`, copy the entire code block, paste it into the console, and press **Enter**.
4. Monitor the live log in the console as the ZIP archive compiles and triggers an automatic browser download.

## 📁 Repository Structure

```
blackboard-ultra-course-exporter/
├── README.md                     <-- Main documentation
├── LICENSE                       <-- Open-source license (MIT)
├── blackboard-exporter.user.js   <-- Production Tampermonkey Userscript
├── snippets/
│   └── standalone-console.js     <-- Pure JS snippet for DevTools execution
└── docs/
    └── ARCHITECTURE.md           <-- In-depth reverse-engineering breakdown
```

## ⚙️ Troubleshooting

Blackboard Ultra is a Single Page Application (SPA). If the button does not render immediately, try refreshing the page while inside the course outline, or check if the URL contains the `/_12345_1/` style course ID pattern matched by the script.

Check your browser console (`F12`). If the university server or cloud CDN experiences a temporary network blip or rate-limits a request, the exporter will log a `console.warn()` message and proceed with the remaining items without crashing.

## 🔧 Compatibility

Tested primarily on **Blackboard Ultra at Universidad Peruana de Ciencias Aplicadas (UPC)** (`aulavirtual.upc.edu.pe`).

The underlying architecture (private REST API, `x-blackboard-xsrf` CSRF handling, and Amazon S3 CORS redirect behavior) applies broadly to other Blackboard Learn Ultra instances, since they share the same standard endpoints. However, the `@match` rule in `blackboard-exporter.user.js` is currently tailored to UPC's domain. To use the script on another institution's Blackboard Ultra deployment, update the `@match` directive to that institution's course URL pattern.

## 🛠️ Architecture & Technical Details

For an in-depth reverse-engineering breakdown — including how Blackboard's REST API, `x-blackboard-xsrf` tokens, and Amazon S3 CORS redirects were analyzed — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## ⚖️ License

Distributed under the MIT License. Free for academic and personal use.
