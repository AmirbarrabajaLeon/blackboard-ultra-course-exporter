// ==UserScript==
// @name         Blackboard Ultra Course Exporter
// @namespace    https://github.com/
// @version      1.0.0
// @description  Export complete Blackboard Ultra course structures and documents to a structured ZIP.
// @author       A. C.
// @match        https://aulavirtual.upc.edu.pe/ultra/courses/*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js
// ==/UserScript==

(function () {
  'use strict';

  function injectExportButton() {
    if (document.getElementById('bb-exporter-btn')) return;

    // UI-agnostic floating action button, independent of Blackboard's layout
    const btn = document.createElement('button');
    btn.id = 'bb-exporter-btn';
    btn.textContent = '📥 Descargar Curso (.zip)';
    btn.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      padding: 12px 18px;
      background: #0072ce;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      touch-action: none;
      user-select: none;
    `;

    // Restore last dragged position
    try {
      const saved = JSON.parse(localStorage.getItem('bb-exporter-btn-pos') || 'null');
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        btn.style.left = saved.x + 'px';
        btn.style.top = saved.y + 'px';
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
      }
    } catch (e) {}

    // Make the button draggable without breaking the click-to-export
    const DRAG_THRESHOLD = 5;
    let dragging = false, moved = false, startX = 0, startY = 0;
    btn.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      btn.style.transition = 'none';
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    });
    btn.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      if (Math.abs(e.clientX - startX) > DRAG_THRESHOLD || Math.abs(e.clientY - startY) > DRAG_THRESHOLD) moved = true;
      if (moved) {
        let nx = e.clientX - btn.offsetWidth / 2;
        let ny = e.clientY - btn.offsetHeight / 2;
        nx = Math.max(0, Math.min(nx, window.innerWidth - btn.offsetWidth));
        ny = Math.max(0, Math.min(ny, window.innerHeight - btn.offsetHeight));
        btn.style.left = nx + 'px';
        btn.style.top = ny + 'px';
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
      }
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try { btn.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved) {
        try {
          localStorage.setItem('bb-exporter-btn-pos', JSON.stringify({ x: parseInt(btn.style.left, 10), y: parseInt(btn.style.top, 10) }));
        } catch (_) {}
      }
    };
    btn.addEventListener('pointerup', endDrag);
    btn.addEventListener('pointercancel', endDrag);
    btn.addEventListener('click', (e) => {
      if (moved) { moved = false; return; }
      runCourseExport();
    });

    // Keep the dragged button inside the viewport on window resize
    function clampButton() {
      if (btn.style.right !== 'auto') return; // still in default corner position
      const maxX = window.innerWidth - btn.offsetWidth;
      const maxY = window.innerHeight - btn.offsetHeight;
      const x = parseInt(btn.style.left, 10);
      const y = parseInt(btn.style.top, 10);
      if (isNaN(x) || isNaN(y)) return;
      btn.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
      btn.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
    }
    clampButton();
    window.addEventListener('resize', clampButton);

    document.body.appendChild(btn);
  }

  // fetch with a hard timeout so a stalled S3/CORS request can't hang the whole export
  async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // File types that are already compressed: store them uncompressed (STORE) to
  // avoid wasting CPU on DEFLATE during zip generation (the "stuck" phase).
  const STORE_RE = /\.(pdf|docx?|pptx?|xlsx?|zip|rar|7z|tar|gz|bz2|tgz|mp4|mov|avi|mkv|mp3|wav|png|jpe?g|gif|webp|svg|doc|ppt|xls)$/i;
  function fileOptions(name) {
    return STORE_RE.test(name) ? { compression: 'STORE' } : { compression: 'DEFLATE' };
  }

  function getFilenameFromResponse(response, fallbackName) {
    const disposition = response.headers.get('content-disposition');
    if (disposition) {
      const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1].trim().replace(/['"]/g, ''));
      const stdMatch = disposition.match(/filename="?([^";]+)"?/i);
      if (stdMatch?.[1]) return stdMatch[1].trim();
    }
    try {
      const parsedUrl = new URL(response.url);
      const paramDisp = parsedUrl.searchParams.get('response-content-disposition');
      if (paramDisp) {
        const utf8Param = paramDisp.match(/filename\*=UTF-8''([^;]+)/i);
        if (utf8Param?.[1]) return decodeURIComponent(utf8Param[1].trim().replace(/['"]/g, ''));
        const stdParam = paramDisp.match(/filename="?([^";]+)"?/i);
        if (stdParam?.[1]) return stdParam[1].trim();
      }
    } catch (e) {}
    return fallbackName;
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

    console.log(`%c📦 [Exporter] Iniciando export del curso: ${courseTitle} (${courseId})`, "color:#00bcd4;font-weight:bold;");

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
        const res = await fetchWithTimeout(url, { headers, credentials: "include" }, 30000);
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
            console.log(`📁 [Exporter] Carpeta: ${itemTitle}`);
            const subFolder = currentZipFolder.folder(itemTitle);
            await processNode(item.id, subFolder);
          } else if (handler.includes('externallink')) {
            const extUrl = item.contentDetail?.['resource/x-bb-externallink']?.url || item.body?.webLocation;
            if (extUrl) {
              currentZipFolder.file(uniqueName(currentZipFolder, `${itemTitle}.url`), `[InternetShortcut]\nURL=${extUrl}\n`);
              console.log(`🔗 [Exporter] Enlace: ${itemTitle}`);
            }
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
                  btn.textContent = `⏳ Descargando (${totalFiles + 1}): ${fileName.substring(0, 18)}...`;
                  console.log(`⏳ [Exporter] Descargando (${totalFiles + 1}): ${fileName}`);
                  const fileRes = await fetchWithTimeout(fileUrl, {}, 60000);
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
                    fileName = getFilenameFromResponse(fileRes, fileName);
                    if (!fileName.includes('.')) {
                      const ct = fileRes.headers.get('content-type') || "";
                      if (ct.includes('pdf')) fileName += '.pdf';
                      else if (ct.includes('word')) fileName += '.docx';
                      else if (ct.includes('presentation')) fileName += '.pptx';
                      else if (ct.includes('spreadsheet')) fileName += '.xlsx';
                      else if (ct.includes('zip')) fileName += '.zip';
                    }
                    const safeName = uniqueName(currentZipFolder, fileName.replace(/[/\\?%*:|"<>]/g, '_'));
                    currentZipFolder.file(safeName, blob, fileOptions(safeName));
                    totalFiles++;
                    console.log(`✔ [Exporter] Guardado: ${safeName} (${(blob.size / 1024).toFixed(1)} KB)`);
                  } else {
                    failedFiles++;
                    failedItems.push({ name: fileName, status: fileRes.status });
                    console.warn(`[Exporter] HTTP ${fileRes.status} al descargar: ${fileName}`);
                  }
                } catch (e) {
                  failedFiles++;
                  failedItems.push({ name: fileName, status: 'error/timeout' });
                  console.warn(`[Exporter] Error de descarga (timeout?) en: ${fileName}`, e);
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
    btn.textContent = '🗜️ Comprimiendo 0%';

    // Scope report so progress is visible even when % is coarse
    let totalBytes = 0;
    try {
      for (const f of Object.values(zip.files)) {
        if (f.dir) continue;
        const data = f._data;
        if (data && typeof data.uncompressedSize === 'number') totalBytes += data.uncompressedSize;
      }
    } catch (e) {}
    console.log(`%c🗜️ [Exporter] Comprimiendo ZIP (${totalFiles} archivos, ${skippedLarge} omitidos, ~${(totalBytes / 1048576).toFixed(1)} MB)...`, "color:#ff9800;font-weight:bold;");

    let lastTick = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastTick > 5000) {
        console.warn('[Exporter] La compresión sigue corriendo (ZIP grande). No está colgado, solo tardando...');
        lastTick = Date.now();
      }
    }, 5000);

    const zipBlob = await zip.generateAsync(
      { type: "blob" },
      (metadata) => {
        const percent = Math.round(metadata.percent || 0);
        btn.textContent = `🗜️ Comprimiendo ${percent}%`;
        lastTick = Date.now();
      }
    );
    clearInterval(watchdog);
    saveAs(zipBlob, `${courseTitle}.zip`);

    btn.disabled = false;
    if (failedFiles > 0 || failedNodes > 0 || skippedLarge > 0) {
      btn.textContent = `✔ ${totalFiles} ok, ⚠ ${failedFiles} fallidos, ${failedNodes} secciones, ${skippedLarge} omitidos`;
      console.warn(`[Exporter] Resumen: ${totalFiles} OK / ${failedFiles} fallidos / ${failedNodes} secciones / ${skippedLarge} omitidos (grandes)`, failedItems);
    } else {
      btn.textContent = `✔ ¡Listo! (${totalFiles} archivos)`;
    }
    console.log(`%c🎉 [Exporter] Completado: ${totalFiles} archivos en ${courseTitle}.zip (fallidos: ${failedFiles}, secciones con error: ${failedNodes}, omitidos grandes: ${skippedLarge})`, "color:#4caf50;font-weight:bold;");
    setTimeout(() => { btn.textContent = '📥 Descargar Curso (.zip)'; }, 6000);
  }

  // Observe URL changes & DOM updates in Blackboard Ultra SPA
  const observer = new MutationObserver(() => injectExportButton());
  observer.observe(document.body, { childList: true, subtree: true });
})();