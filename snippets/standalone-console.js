(async function exportCourseToZip() {
  console.log("%c📦 Initializing Blackboard Course Exporter...", "color: #00bcd4; font-size: 14px; font-weight: bold;");

  const loadScript = (url) => new Promise((resolve, reject) => {
    if (window.JSZip && url.includes('jszip')) return resolve();
    if (window.saveAs && url.includes('FileSaver')) return resolve();
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  try {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js');
  } catch (e) {
    console.error("❌ Failed to load ZIP libraries from CDN.", e);
    return;
  }

  const courseMatch = window.location.pathname.match(/_(\d+_\d+)/);
  if (!courseMatch) {
    console.error("❌ Could not detect Course ID from URL.");
    return;
  }
  const courseId = courseMatch[0];
  const courseTitle = (document.querySelector('h1, [data-testid="course-title"]') 
    ? document.querySelector('h1, [data-testid="course-title"]').textContent.trim() 
    : "Blackboard_Course").replace(/[/\\?%*:|"<>]/g, '_');

  const xsrfMatch = document.cookie.match(/BbRouter=[^;]*xsrf:([a-f0-9\-]+)/i);
  const xsrfToken = xsrfMatch ? xsrfMatch[1] : "";

  const headers = {
    "accept": "application/json, text/plain, */*",
    "x-blackboard-xsrf": xsrfToken
  };

  const zip = new JSZip();
  const rootFolder = zip.folder(courseTitle);
  let downloadedCount = 0;

  function wrapHtmlContent(title, innerHtml) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #222; background: #fafafa; }
    h1 { border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; color: #111; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    img { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${innerHtml || "<p><em>No content provided.</em></p>"}
</body>
</html>`;
  }

  async function processNode(nodeId, currentZipFolder) {
    const url = `https://aulavirtual.upc.edu.pe/learn/api/v1/courses/${courseId}/contents/${nodeId}/children?@view=Summary&limit=100`;

    try {
      const res = await fetch(url, { headers, credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      const items = data.results || [];

      for (const item of items) {
        const itemTitle = (item.title || "Untitled").replace(/[/\\?%*:|"<>]/g, '_');
        const handler = item.contentHandler || "";
        const isFolder = item.contentDetail?.['resource/x-bb-folder']?.isFolder || 
                         item.contentDetail?.['resource/x-bb-lesson']?.isLesson ||
                         handler.includes('folder') || handler.includes('lesson');

        if (isFolder) {
          const subFolder = currentZipFolder.folder(itemTitle);
          console.log(`📁 Folder: ${itemTitle}`);
          await processNode(item.id, subFolder);
        } 
        else if (handler.includes('externallink')) {
          const extUrl = item.contentDetail?.['resource/x-bb-externallink']?.url || item.body?.webLocation;
          if (extUrl) {
            currentZipFolder.file(`${itemTitle}.url`, `[InternetShortcut]\nURL=${extUrl}\n`);
            console.log(`🔗 Link: ${itemTitle}`);
          }
        } 
        else if (handler.includes('document')) {
          const rawText = item.body?.rawText || item.body?.displayText || "";
          const docParser = new DOMParser().parseFromString(rawText, 'text/html');
          const fileLinks = Array.from(docParser.querySelectorAll('a[href*="/bbcswebdav/"], a[data-bbfile]'));

          // 1. Process files
          for (let i = 0; i < fileLinks.length; i++) {
            const a = fileLinks[i];
            let fileName = "";
            let fileUrl = a.getAttribute('href');

            if (a.hasAttribute('data-bbfile')) {
              try {
                const meta = JSON.parse(a.getAttribute('data-bbfile').replace(/&quot;/g, '"'));
                fileName = meta.displayName || meta.linkName || "";
                if (!fileUrl) fileUrl = meta.viewerUrl || meta.resourceUrl;
              } catch (e) {}
            }

            if (!fileName) {
              const text = a.textContent.trim();
              if (text && !text.startsWith("http")) fileName = text;
            }

            // Fallback: use item title with index
            if (!fileName) {
              fileName = fileLinks.length > 1 ? `${itemTitle}_part${i + 1}` : itemTitle;
            }

            if (fileUrl && fileUrl.startsWith('/')) {
              fileUrl = window.location.origin + fileUrl;
            }

            if (fileUrl) {
              try {
                console.log(`⏳ Downloading: ${fileName}...`);
                const fileRes = await fetch(fileUrl);
                if (fileRes.ok) {
                  const blob = await fileRes.blob();
                  
                  // Auto-detect extension if missing from name
                  if (!fileName.includes('.')) {
                    const ct = fileRes.headers.get('content-type') || "";
                    if (ct.includes('pdf')) fileName += '.pdf';
                    else if (ct.includes('word') || ct.includes('officedocument.wordprocessingml')) fileName += '.docx';
                    else if (ct.includes('presentation') || ct.includes('officedocument.presentationml')) fileName += '.pptx';
                    else if (ct.includes('spreadsheet') || ct.includes('officedocument.spreadsheetml')) fileName += '.xlsx';
                    else if (ct.includes('zip')) fileName += '.zip';
                  }

                  currentZipFolder.file(fileName.replace(/[/\\?%*:|"<>]/g, '_'), blob);
                  downloadedCount++;
                  console.log(`✔ Saved: ${fileName}`);
                }
              } catch (fetchErr) {
                console.warn(`Failed downloading ${fileName}:`, fetchErr);
              }
            }
          }

          // 2. Also save text/instructions if there is actual text content
          const textOnly = docParser.body.textContent.trim();
          if (textOnly.length > 0) {
            const htmlBlob = wrapHtmlContent(itemTitle, rawText);
            currentZipFolder.file(`${itemTitle}.html`, htmlBlob);
            console.log(`📝 Saved Text: ${itemTitle}.html`);
          }
        }
      }
    } catch (err) {
      console.error(`Error on node ${nodeId}:`, err);
    }
  }

  await processNode("ROOT", rootFolder);

  console.log("%c🗜️ Compressing into ZIP file...", "color: #ff9800; font-weight: bold;");
  const zipBlob = await zip.generateAsync({ type: "blob" });
  saveAs(zipBlob, `${courseTitle}.zip`);

  console.log(`%c🎉 Complete! Saved ${downloadedCount} files into ${courseTitle}.zip`, "color: #4caf50; font-size: 14px; font-weight: bold;");
})();