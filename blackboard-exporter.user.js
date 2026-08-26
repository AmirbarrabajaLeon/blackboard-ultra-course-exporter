// ==UserScript==
// @name         Blackboard Ultra Course Exporter
// @namespace    https://github.com/
// @version      1.0.0
// @description  Export complete Blackboard Ultra course structures and documents to a structured ZIP.
// @author       A. C.
// @match        https://aulavirtual.upc.edu.pe/ultra/courses/*
// @grant        GM_xmlhttpRequest
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js
// ==/UserScript==

(function () {
  'use strict';

  function injectExportButton() {
    if (document.getElementById('bb-exporter-btn')) return;

    // Locate Blackboard Ultra header bar
    const targetHeader = document.querySelector('header, [data-testid="course-outline-header"], .course-outline-title');
    if (!targetHeader) return;

    const btn = document.createElement('button');
    btn.id = 'bb-exporter-btn';
    btn.textContent = '📥 Descargar Curso (.zip)';
    btn.style.cssText = `
      margin-left: 15px;
      padding: 8px 14px;
      background: #0072ce;
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 4px rgba(0,0,0,0.15);
      z-index: 9999;
    `;

    btn.onclick = runCourseExport;
    targetHeader.appendChild(btn);
  }

  async function runCourseExport() {
    const btn = document.getElementById('bb-exporter-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Analizando estructura...';

    const courseMatch = window.location.pathname.match(/_(\d+_\d+)/);
    if (!courseMatch) {
      alert("No se pudo detectar el ID del curso.");
      btn.disabled = false;
      btn.textContent = '📥 Descargar Curso (.zip)';
      return;
    }

    const courseId = courseMatch[0];
    const courseTitle = (document.querySelector('h1, [data-testid="course-title"]')?.textContent.trim() || "Curso_Blackboard")
      .replace(/[/\\?%*:|"<>]/g, '_');

    const xsrfMatch = document.cookie.match(/BbRouter=[^;]*xsrf:([a-f0-9\-]+)/i);
    const xsrfToken = xsrfMatch ? xsrfMatch[1] : "";

    const headers = {
      "accept": "application/json, text/plain, */*",
      "x-blackboard-xsrf": xsrfToken
    };

    const zip = new JSZip();
    const rootFolder = zip.folder(courseTitle);
    let totalFiles = 0;
    let failedFiles = 0;
    let failedNodes = 0;
    let skippedLarge = 0;
    const failedItems = [];
    const MAX_FILE_BYTES = 250 * 1024 * 1024;

    function wrapHtmlContent(title, innerHtml) {
      return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${title}</title><style>body{font-family:system-ui,sans-serif;line-height:1.6;max-width:800px;margin:40px auto;padding:0 20px;color:#222;background:#fafafa;}h1{border-bottom:2px solid #e0e0e0;padding-bottom:10px;}a{color:#0066cc;text-decoration:none;}a:hover{text-decoration:underline;}img{max-width:100%;height:auto;}</style></head><body><h1>${title}</h1>${innerHtml||"<p><em>Sin contenido.</em></p>"}</body></html>`;
    }

    function uniqueName(folder, name) {
      if (!folder._used) folder._used = new Set();
      if (!folder._used.has(name)) {
        folder._used.add(name);
        return name;
      }
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let i = 1, base;
      do { base = `${stem} (${i++})${ext}`; } while (folder._used.has(base));
      folder._used.add(base);
      return base;
    }

    async function processNode(nodeId, currentZipFolder) {
      const url = `https://aulavirtual.upc.edu.pe/learn/api/v1/courses/${courseId}/contents/${nodeId}/children?@view=Summary&limit=100`;
      try {
        const res = await fetch(url, { headers, credentials: "include" });
        if (!res.ok) {
          failedNodes++;
          console.warn(`[Exporter] HTTP ${res.status} al leer nodo ${nodeId}`);
          return;
        }
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
            await processNode(item.id, subFolder);
          } else if (handler.includes('externallink')) {
            const extUrl = item.contentDetail?.['resource/x-bb-externallink']?.url || item.body?.webLocation;
            if (extUrl) currentZipFolder.file(uniqueName(currentZipFolder, `${itemTitle}.url`), `[InternetShortcut]\nURL=${extUrl}\n`);
          } else if (handler.includes('document')) {
            const rawText = item.body?.rawText || item.body?.displayText || "";
            const docParser = new DOMParser().parseFromString(rawText, 'text/html');
            const fileLinks = Array.from(docParser.querySelectorAll('a[href*="/bbcswebdav/"], a[data-bbfile]'));

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
              if (!fileName) fileName = fileLinks.length > 1 ? `${itemTitle}_part${i + 1}` : itemTitle;
              if (fileUrl && fileUrl.startsWith('/')) fileUrl = window.location.origin + fileUrl;

              if (fileUrl) {
                try {
                  btn.textContent = `⏳ Descargando: ${fileName.substring(0, 18)}...`;
                  const fileRes = await fetch(fileUrl);
                  if (fileRes.ok) {
                    const len = Number(fileRes.headers.get('content-length') || 0);
                    if (len > MAX_FILE_BYTES) {
                      skippedLarge++;
                      const urlName = uniqueName(currentZipFolder, fileName.replace(/\.[^.]+$/, '') + '.url');
                      currentZipFolder.file(urlName, `[InternetShortcut]\nURL=${fileUrl}\n`);
                      failedItems.push({ name: fileName, status: `grande>${MAX_FILE_BYTES}`, url: fileUrl });
                      console.warn(`[Exporter] Archivo grande (${len} bytes) omitido del ZIP, guardado .url: ${fileName}`);
                      continue;
                    }
                    const blob = await fileRes.blob();
                    if (!fileName.includes('.')) {
                      const ct = fileRes.headers.get('content-type') || "";
                      if (ct.includes('pdf')) fileName += '.pdf';
                      else if (ct.includes('word')) fileName += '.docx';
                      else if (ct.includes('presentation')) fileName += '.pptx';
                      else if (ct.includes('spreadsheet')) fileName += '.xlsx';
                      else if (ct.includes('zip')) fileName += '.zip';
                    }
                    currentZipFolder.file(uniqueName(currentZipFolder, fileName.replace(/[/\\?%*:|"<>]/g, '_')), blob);
                    totalFiles++;
                  } else {
                    failedFiles++;
                    failedItems.push({ name: fileName, status: fileRes.status });
                    console.warn(`[Exporter] HTTP ${fileRes.status} al descargar: ${fileName}`);
                  }
                } catch (e) {
                  failedFiles++;
                  failedItems.push({ name: fileName, status: 'error' });
                  console.warn(`[Exporter] Error de descarga en: ${fileName}`, e);
                }
              }
            }

            const textOnly = docParser.body.textContent.trim();
            if (textOnly.length > 0) {
              currentZipFolder.file(uniqueName(currentZipFolder, `${itemTitle}.html`), wrapHtmlContent(itemTitle, rawText));
            }
          }
        }
      } catch (err) {
        failedNodes++;
        console.error(`[Exporter] Error procesando nodo ${nodeId}:`, err);
      }
    }

    await processNode("ROOT", rootFolder);
    btn.textContent = '🗜️ Comprimiendo ZIP...';

    const zipBlob = await zip.generateAsync({ type: "blob" });
    saveAs(zipBlob, `${courseTitle}.zip`);

    btn.disabled = false;
    if (failedFiles > 0 || failedNodes > 0 || skippedLarge > 0) {
      btn.textContent = `✔ ${totalFiles} ok, ⚠ ${failedFiles} fallidos, ${failedNodes} secciones, ${skippedLarge} omitidos`;
      console.warn(`[Exporter] Resumen: ${totalFiles} OK / ${failedFiles} fallidos / ${failedNodes} secciones / ${skippedLarge} omitidos (grandes)`, failedItems);
    } else {
      btn.textContent = `✔ ¡Listo! (${totalFiles} archivos)`;
    }
    setTimeout(() => { btn.textContent = '📥 Descargar Curso (.zip)'; }, 6000);
  }

  // Observe URL changes & DOM updates in Blackboard Ultra SPA
  const observer = new MutationObserver(() => injectExportButton());
  observer.observe(document.body, { childList: true, subtree: true });
})();