# 🏗️ Technical Architecture & Reverse Engineering Guide

This document details the reverse-engineering methodology, network protocol discoveries, security mechanics, and client-side processing pipeline behind the Blackboard Ultra Course Exporter.

## 1. Architectural Paradigm: DOM Automation vs. Direct API Interception

When building tools to extract course materials from modern Single Page Applications (SPAs) like Blackboard Ultra, developers often default to headless browser automation frameworks like Selenium, Puppeteer, or Playwright. However, DOM scraping introduces major structural weaknesses in enterprise LMS environments:

- **Lazy Loading & Accordion State:** Blackboard Ultra defers rendering course nodes until a user explicitly clicks accordion components. A DOM scraper must simulate human clicks, handle variable animation delays, and manage infinite scrolling.
- **Authentication & Multi-Factor Overhead:** Headless browser instances require storing raw SSO credentials in local configuration files, managing driver binaries, and handling Multi-Factor Authentication (MFA/2FA) prompts.
- **UI Fragility:** Class names, structural XPaths, and DOM tree hierarchies change across Blackboard software releases, breaking visual scrapers frequently.

### The In-Browser API Solution

Instead of automating UI interactions, this tool bypasses the DOM layer entirely. Executing directly within the user's active session allows it to intercept and query the private REST API endpoints that Blackboard Ultra's frontend uses to render content.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        User's Browser Session                          │
│                                                                        │
│   ┌─────────────────────┐                 ┌────────────────────────┐   │
│   │   Tampermonkey /    │  JSON REST API  │   Blackboard Backend   │   │
│   │   Console Script    │ ──────────────► │  (/learn/api/v1/...)   │   │
│   └──────────┬──────────┘                 └────────────────────────┘   │
│              │                                                         │
│              │ Intercepts Redirects                                    │
│              ▼                                                         │
│   ┌─────────────────────┐                 ┌────────────────────────┐   │
│   │   Client-Side RAM   │  Signed URL     │  Amazon S3 CDN Fleet   │   │
│   │   (JSZip Buffer)    │ ──────────────► │  (*.content.blackboard)│   │
│   └─────────────────────┘                 └────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

## 2. API Endpoint Discovery & Recursive Tree Traversal

Blackboard Ultra models course content as a hierarchical tree structure. Each folder, document, external link, or assignment is represented as a node identified by a unique identifier (`contentId`).

### Core Private REST Endpoints

- **Course Root Node:**
  ```
  GET /learn/api/v1/courses/{courseId}/contents/ROOT/children?@view=Summary&limit=100
  ```
- **Subfolder & Lesson Child Nodes:**
  ```
  GET /learn/api/v1/courses/{courseId}/contents/{contentId}/children?@view=Summary&limit=100
  ```

### Recursive Traversal Algorithm

The exporter implements an asynchronous, depth-first tree traversal algorithm to construct a matching local directory hierarchy:

```
processNode(nodeId, currentZipFolder):
  1. FETCH child nodes array from Blackboard REST API for `nodeId`
  2. FOR EACH item in `results`:
        a. IF item is a Folder or Lesson (`resource/x-bb-folder` / `resource/x-bb-lesson`):
             - Sanitize folder title
             - Create new subfolder in Zip: `subFolder = currentZipFolder.folder(title)`
             - RECURSE: await processNode(item.id, subFolder)
        b. ELSE IF item is an External Link (`resource/x-bb-externallink`):
             - Extract web location URL
             - Create `.url` Internet Shortcut file inside `currentZipFolder`
        c. ELSE IF item is a Document / Content Item (`resource/x-bb-document`):
             - Extract HTML body (`rawText` or `displayText`)
             - Parse embedded anchors (`a[href*="/bbcswebdav/"]` and `a[data-bbfile]`)
             - Download attached binary files via file pipeline
             - IF body contains standalone instructions/text:
                 - Wrap HTML in styling template and write `${title}.html`
```

## 3. Session Authentication & Anti-CSRF Token Mechanics

Because the script executes inside an active browser session, standard session cookies (such as `JSESSIONID`) are attached automatically by the browser on same-origin requests. However, Blackboard's REST API enforces strict Cross-Site Request Forgery (CSRF) protections.

### Token Extraction

Upon SSO authentication, Blackboard sets a cookie named `BbRouter` containing an embedded `xsrf` parameters string:

```
Cookie: BbRouter=...xsrf:a1b2c3d4-e5f6-7890-abcd-1234567890ab...
```

The script dynamically parses this token from `document.cookie` using regular expressions:

```js
const xsrfMatch = document.cookie.match(/BbRouter=[^;]*xsrf:([a-f0-9\-]+)/i);
const xsrfToken = xsrfMatch ? xsrfMatch[1] : "";
```

Every subsequent `fetch()` query sent to `/learn/api/v1/...` must supply this token in a custom HTTP request header:

```
x-blackboard-xsrf: a1b2c3d4-e5f6-7890-abcd-1234567890ab
```

Without this header, backend API endpoints return HTTP `401 Unauthorized` or HTTP `403 Forbidden`.

## 4. WebDAV Storage, AWS S3 Redirects & CORS Mechanics

Downloading attached binary files (`.pdf`, `.docx`, `.xlsx`, `.pptx`) presents a cross-origin security hurdle caused by redirect chains.

### The Redirect Chain

- **Initial Attachment Link:** Links embedded inside document nodes point to an internal WebDAV proxy route on the university domain:
  ```
  https://aulavirtual.upc.edu.pe/bbcswebdav/pid-12345-dt-content-rid-67890_1/...
  ```
- **Backend Validation & 302 Redirect:** Blackboard's WebDAV controller validates session permissions and issues an HTTP `302 Found` redirect pointing to a pre-signed Amazon S3 CDN bucket:
  ```
  https://learn-us-east-1-prod-fleet02-xythos.content.blackboardcdn.com/...
  ```

### The CORS Wildcard Conflict (`Access-Control-Allow-Origin: *`)

When issuing authenticated API requests to Blackboard, setting `credentials: "include"` on `fetch()` is mandatory to forward same-site cookies. However, when `fetch()` follows the HTTP `302` redirect to Amazon S3, retaining `credentials: "include"` triggers a strict browser CORS violation:

```
CORS Error: The value of the 'Access-Control-Allow-Origin' header in the response must not be the wildcard '*' when the request's credentials mode is 'include'.
```

### The Resolution

AWS S3 pre-signed URLs embed authentication parameters (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Date`) directly inside the URL query string. Consequently, cookies are not required on the secondary request leg. By omitting explicit `credentials: "include"` on binary file downloads, the browser defaults to standard fetch redirect rules:

- It sends active cookies to the initial `aulavirtual.upc.edu.pe` WebDAV domain.
- Upon receiving the HTTP `302` redirect, it follows the redirect to Amazon S3 without attaching sensitive cookies, satisfying S3's `Access-Control-Allow-Origin: *` policy without triggering CORS rejections.

```js
// Correct implementation for CDN-redirected binary downloads
const fileRes = await fetch(fileUrl); // Omit credentials: "include"
```

## 5. File Resolution Pipeline & Collision Handling

Anchor tags inside Blackboard Ultra document bodies frequently lack explicit filenames or extension information (e.g., `<a href="/bbcswebdav/pid-123...">https://...</a>`). To prevent corrupted or ambiguous files (such as Windows mistaking files ending in `.com` for MS-DOS executables), the exporter applies a multi-stage resolution pipeline:

```
┌────────────────────────────────────────────────────────┐
│               File Filename Resolution                 │
└──────────────────────────┬─────────────────────────────┘
                           │
             1. Has `data-bbfile` JSON?
             ├──► YES ──► Extract `displayName` / `linkName`
             │
              └──► NO ───► 2. Has human anchor text (`a.textContent`)?
                           ├──► YES ──► Use anchor text
                           │
                           └──► NO ───► 3. Fallback to Parent Item Title + MIME Sniffing
```

### 1. Metadata Parsing (`data-bbfile`)

Blackboard encodes file metadata in JSON string attributes within anchor tags. The parser parses this payload to retrieve original filenames:

```js
const meta = JSON.parse(a.getAttribute('data-bbfile').replace(/&quot;/g, '"'));
const fileName = meta.displayName || meta.linkName;
```

### 2. MIME-Type Extension Fallback

If the resolved name lacks a valid extension, the script inspects `response.headers.get('content-type')` to append the appropriate extension (`.pdf`, `.docx`, `.pptx`, `.xlsx`, `.zip`).

### 3. Collision Avoidance

To prevent overwriting files with identical names within the same directory, the exporter tracks existing paths in the ZIP folder and appends numeric indexes (e.g., `Document (1).pdf`).

## 6. Document Parsing & Offline HTML Asset Rewriting

When course materials contain formatted text instructions alongside file attachments, dropping the written instructions results in data loss. The exporter processes documents with a dual-path pipeline:

- **Attachment Extraction:** Downloads and archives binary files found within the document.
- **Text Formatting:** If instructional text exists, wraps the inner HTML in a standalone HTML document template with clean typography and embedded responsive styling.
- **Local Image Relative Path Rewriting** *(Planned — see Roadmap):* Embedded `<img>` tags pointing to remote WebDAV endpoints would be downloaded locally and their `src` attributes rewritten to point to relative local files (e.g., `<img src="./image1.png">`), enabling full offline rendering.

## 7. Client-Side Packaging & Memory Management

The entire archiving process takes place in client memory:

```
Download Blobs ──► Memory Buffers ──► JSZip Tree ──► Blob Compilation ──► FileSaver Stream
```

- **In-Memory Archiving:** Binary responses are converted to `Blob` streams and passed directly to JSZip.
- **Large File Safety Checks:** Before buffering large video lectures or massive archives into RAM, the exporter inspects the `Content-Length` header. Files exceeding threshold limits (~250 MB) can be converted to `.url` Internet Shortcuts to prevent browser memory exhaustion and tab crashes.
- **Consolidated Streaming:** Upon traversal completion (100%), `zip.generateAsync({ type: "blob" })` compiles the archive into a single binary payload, invoking FileSaver.js (`saveAs`) to trigger the native browser download manager.

> **Compatibility:** Tested primarily on Blackboard Ultra at UPC (`aulavirtual.upc.edu.pe`). See the [README](../README.md#-compatibility) for details on porting to other institutions.

## 🗺️ Roadmap

The following enhancements are planned but not yet implemented:

- **Local Image Relative Path Rewriting:** Download embedded `<img>` assets referenced inside document bodies and rewrite their `src` attributes to relative local paths so offline `.html` pages render images without a network connection. Currently, only file attachments and the document's text are captured.
- **Content-Disposition Filename Extraction:** ~~Inspect the `Content-Disposition` response header (`filename*=`) to recover original filenames when `data-bbfile` metadata and anchor text are unavailable. Currently not implemented; the script falls back to the parent item title.~~ **Implemented.** The `getFilenameFromResponse()` helper parses both the `Content-Disposition` header (with UTF-8 `filename*` support) and the S3 `response-content-disposition` query param fallback, slotting into the pipeline after the blob fetch.
