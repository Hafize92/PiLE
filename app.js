(function () {
  "use strict";

  const APP_VERSION = "1.0.0";
  const STORAGE_KEY = "akz:piling-status:v1";
  const DB_NAME = "akz-piling-status";
  const DB_VERSION = 1;
  const PDFJS_SCRIPT = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const PDFLIB_SCRIPT = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js";

  const els = {
    pdfInput: document.querySelector("#pdfInput"),
    drawingSelect: document.querySelector("#drawingSelect"),
    deleteDrawingButton: document.querySelector("#deleteDrawingButton"),
    projectTitle: document.querySelector("#projectTitle"),
    drawingTitle: document.querySelector("#drawingTitle"),
    gridLetters: document.querySelector("#gridLetters"),
    gridNumbers: document.querySelector("#gridNumbers"),
    saveDrawingButton: document.querySelector("#saveDrawingButton"),
    exportCsvButton: document.querySelector("#exportCsvButton"),
    exportPdfButton: document.querySelector("#exportPdfButton"),
    clearDataButton: document.querySelector("#clearDataButton"),
    appMessage: document.querySelector("#appMessage"),
    totalPiles: document.querySelector("#totalPiles"),
    recordedPiles: document.querySelector("#recordedPiles"),
    pendingPiles: document.querySelector("#pendingPiles"),
    progressPercent: document.querySelector("#progressPercent"),
    recordForm: document.querySelector("#recordForm"),
    gridSelect: document.querySelector("#gridSelect"),
    pileSelect: document.querySelector("#pileSelect"),
    pilingDate: document.querySelector("#pilingDate"),
    penetrationDepth: document.querySelector("#penetrationDepth"),
    recordRemarks: document.querySelector("#recordRemarks"),
    resetEntryButton: document.querySelector("#resetEntryButton"),
    pileHistory: document.querySelector("#pileHistory"),
    pileSearch: document.querySelector("#pileSearch"),
    addPileButton: document.querySelector("#addPileButton"),
    rangeStart: document.querySelector("#rangeStart"),
    rangeEnd: document.querySelector("#rangeEnd"),
    rangePrefix: document.querySelector("#rangePrefix"),
    rangeGrid: document.querySelector("#rangeGrid"),
    addRangeButton: document.querySelector("#addRangeButton"),
    statusBody: document.querySelector("#statusBody"),
    emptyState: document.querySelector("#emptyState"),
    storageStatus: document.querySelector("#storageStatus")
  };

  const state = loadAppState();
  let pdfJsPromise = null;
  let pdfLibPromise = null;
  let dbPromise = null;

  init();

  function init() {
    els.pilingDate.value = todayInputValue();

    els.pdfInput.addEventListener("change", handlePdfUpload);
    els.drawingSelect.addEventListener("change", handleDrawingChange);
    els.deleteDrawingButton.addEventListener("click", deleteActiveDrawing);
    els.saveDrawingButton.addEventListener("click", saveDrawingEdits);
    els.exportCsvButton.addEventListener("click", exportCsv);
    els.exportPdfButton.addEventListener("click", exportEmbeddedPdf);
    els.clearDataButton.addEventListener("click", clearAllData);
    els.recordForm.addEventListener("submit", saveProgressRecord);
    els.resetEntryButton.addEventListener("click", resetEntryForm);
    els.gridSelect.addEventListener("change", () => {
      renderPileSelect();
      renderHistory();
    });
    els.pileSelect.addEventListener("change", renderHistory);
    els.pileSearch.addEventListener("input", renderStatusTable);
    els.addPileButton.addEventListener("click", addSinglePile);
    els.addRangeButton.addEventListener("click", addPileRange);
    els.statusBody.addEventListener("click", handleStatusClick);
    els.statusBody.addEventListener("change", handleStatusChange);
    els.pileHistory.addEventListener("click", handleStatusClick);

    render();
    registerServiceWorker();
  }

  function loadAppState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return {
        activeDrawingId: cleanText(parsed.activeDrawingId),
        drawings: Array.isArray(parsed.drawings) ? parsed.drawings.map(normalizeDrawing).filter(Boolean) : [],
        records: Array.isArray(parsed.records) ? parsed.records.map(normalizeRecord).filter(Boolean) : []
      };
    } catch (error) {
      return { activeDrawingId: "", drawings: [], records: [] };
    }
  }

  function persist() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: APP_VERSION,
        activeDrawingId: state.activeDrawingId,
        drawings: state.drawings,
        records: state.records
      })
    );
  }

  async function handlePdfUpload(event) {
    const files = Array.from(event.target.files || []).filter((file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name));
    if (!files.length) {
      return;
    }

    showMessage(`Reading ${files.length} PDF file${files.length === 1 ? "" : "s"}...`);
    let imported = 0;
    let manualReview = false;

    for (const file of files) {
      const buffer = await file.arrayBuffer();
      let extracted = null;

      try {
        extracted = await extractPdfInfo(buffer.slice(0), file.name);
      } catch (error) {
        extracted = fallbackExtraction(file.name);
        manualReview = true;
      }

      const drawing = normalizeDrawing({
        id: uniqueId("drawing"),
        fileName: file.name,
        projectTitle: extracted.projectTitle,
        drawingTitle: extracted.drawingTitle,
        pageCount: extracted.pageCount,
        gridLetters: extracted.gridLetters,
        gridNumbers: extracted.gridNumbers,
        piles: extracted.piles,
        importedAt: Date.now(),
        updatedAt: Date.now(),
        extractionNote: extracted.extractionNote || ""
      });

      try {
        await savePdfBytes(drawing.id, buffer);
        drawing.pdfStored = true;
      } catch (error) {
        drawing.pdfStored = false;
        manualReview = true;
      }

      state.drawings = [drawing, ...state.drawings.filter((item) => item.fileName !== drawing.fileName)];
      state.activeDrawingId = drawing.id;
      imported += 1;

      if (!drawing.piles.length) {
        manualReview = true;
      }
    }

    persist();
    event.target.value = "";
    render();
    showMessage(
      manualReview
        ? `${imported} PDF imported. Review or add pile numbers before recording.`
        : `${imported} PDF imported and ready.`
    );
  }

  async function extractPdfInfo(buffer, fileName) {
    const pdfjsLib = await ensurePdfJs();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
    const items = [];

    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      textContent.items.forEach((item) => {
        const text = cleanText(item.str);
        if (!text) {
          return;
        }
        const transform = item.transform || [1, 0, 0, 1, 0, 0];
        const x = Number(transform[4]) || 0;
        const y = Number(transform[5]) || 0;
        const width = Number(item.width) || 0;
        const height = Number(item.height) || Math.abs(Number(transform[3])) || 8;
        items.push({
          text,
          pageNo,
          x,
          y,
          right: x + width,
          top: viewport.height - y,
          height,
          pageWidth: viewport.width,
          pageHeight: viewport.height
        });
      });
    }

    const lines = buildTextLines(items);
    const metadata = extractMetadata(lines, fileName);
    const gridModel = detectGridModel(items);
    const piles = extractPileRows(items, gridModel);

    return {
      projectTitle: metadata.projectTitle,
      drawingTitle: metadata.drawingTitle,
      pageCount: pdf.numPages,
      gridLetters: gridModel.letters.map((item) => item.label),
      gridNumbers: gridModel.numbers.map((item) => item.label),
      piles,
      extractionNote: piles.length ? "" : "No pile-number text was found in the PDF text layer."
    };
  }

  function fallbackExtraction(fileName) {
    return {
      projectTitle: titleFromFileName(fileName),
      drawingTitle: titleFromFileName(fileName),
      pageCount: 0,
      gridLetters: [],
      gridNumbers: [],
      piles: [],
      extractionNote: "PDF text extraction was not available."
    };
  }

  function buildTextLines(items) {
    const sorted = [...items].sort((a, b) => {
      if (a.pageNo !== b.pageNo) {
        return a.pageNo - b.pageNo;
      }
      if (Math.abs(a.top - b.top) > 3) {
        return a.top - b.top;
      }
      return a.x - b.x;
    });
    const lines = [];

    sorted.forEach((item) => {
      const last = lines[lines.length - 1];
      const sameLine = last && last.pageNo === item.pageNo && Math.abs(last.top - item.top) <= Math.max(4, item.height * 0.8);
      if (sameLine) {
        last.items.push(item);
        last.top = (last.top + item.top) / 2;
        return;
      }
      lines.push({ pageNo: item.pageNo, top: item.top, items: [item] });
    });

    return lines.map((line) => {
      const lineItems = [...line.items].sort((a, b) => a.x - b.x);
      let text = "";
      let previous = null;
      lineItems.forEach((item) => {
        const gap = previous ? item.x - previous.right : 0;
        const spacer = previous && gap > Math.max(1.5, item.height * 0.25) ? " " : "";
        text += `${spacer}${item.text}`;
        previous = item;
      });
      return { ...line, text: cleanText(text) };
    });
  }

  function extractMetadata(lines, fileName) {
    const projectTitle =
      collectAfterLabel(lines, /PROJECT\s*TITLE|TAJUK\s*PROJEK/i, /DRAWING\s*TITLE|FASA|PHASE|CONTRACTOR|CLIENT|LICENSED/i, 6) ||
      findProjectLine(lines) ||
      titleFromFileName(fileName);
    const drawingTitle =
      collectAfterLabel(lines, /DRAWING\s*TITLE|TAJUK\s*LUKISAN/i, /CHECKED|SURVEYED|DRAWN|SCALE|DATE|DRAWING\s*NO|REV/i, 5) ||
      findDrawingTitleLine(lines) ||
      titleFromFileName(fileName);

    return {
      projectTitle: cleanTitle(projectTitle),
      drawingTitle: cleanTitle(drawingTitle)
    };
  }

  function collectAfterLabel(lines, labelPattern, stopPattern, maxLines) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].text;
      if (!labelPattern.test(line)) {
        continue;
      }

      const parts = [];
      const after = cleanTitle(line.replace(labelPattern, "").replace(/^[/:\s-]+/, ""));
      if (isUsefulTitlePart(after)) {
        parts.push(after);
      }

      for (let next = index + 1; next < lines.length && parts.length < maxLines; next += 1) {
        const text = cleanTitle(lines[next].text);
        if (!text || stopPattern.test(text)) {
          break;
        }
        if (isUsefulTitlePart(text)) {
          parts.push(text);
        }
      }

      if (parts.length) {
        return parts.join(" ");
      }
    }
    return "";
  }

  function findProjectLine(lines) {
    const line = lines.find((item) => /PEMBINAAN|DEVELOPMENT|PROJECT|CADANGAN/i.test(item.text));
    return line ? line.text : "";
  }

  function findDrawingTitleLine(lines) {
    const candidates = lines
      .map((line) => line.text)
      .filter((text) => /PILING/i.test(text) && /PLAN/i.test(text))
      .sort((a, b) => b.length - a.length);
    return candidates[0] || "";
  }

  function isUsefulTitlePart(value) {
    if (!value || value.length < 3) {
      return false;
    }
    return !/^(NO\.?|REV\.?|DATE|NAME|POSITION|SIGNATURE|PAGE|SECTION|AMENDMENTS?|NOTES?|LEGENDS?)\b/i.test(value);
  }

  function detectGridModel(items) {
    const pageItems = items.filter((item) => item.pageNo === 1);
    const pageWidth = pageItems[0]?.pageWidth || 0;
    const pageHeight = pageItems[0]?.pageHeight || 0;
    const letters = detectGridLetters(pageItems, pageWidth);
    const numbers = detectGridNumbers(pageItems, pageHeight);
    return { letters, numbers, pageWidth, pageHeight };
  }

  function detectGridLetters(items, pageWidth) {
    const letterItems = items.filter((item) => /^[A-Z]$/.test(item.text) && item.height >= 3 && item.height <= 30);
    const rowGroups = groupClose(letterItems, "top", 10)
      .map((group) => uniquePositionLabels(group, "x"))
      .filter((group) => group.length >= 4 && span(group.map((item) => item.x)) > pageWidth * 0.2);

    if (!rowGroups.length) {
      return [];
    }

    const best = rowGroups.sort((a, b) => scoreLetterGroup(b, pageWidth) - scoreLetterGroup(a, pageWidth))[0];
    return best
      .sort((a, b) => a.x - b.x)
      .map((item) => ({ label: item.text, x: item.x, top: item.top }));
  }

  function detectGridNumbers(items, pageHeight) {
    const numberItems = items.filter((item) => /^(?:[1-9]|1[0-9]|2[0-9]|30)$/.test(item.text) && item.height >= 3 && item.height <= 30);
    const columnGroups = groupClose(numberItems, "x", 12)
      .map((group) => uniquePositionLabels(group, "top"))
      .filter((group) => group.length >= 4 && span(group.map((item) => item.top)) > pageHeight * 0.18);

    if (!columnGroups.length) {
      return [];
    }

    const best = columnGroups.sort((a, b) => scoreNumberGroup(b) - scoreNumberGroup(a))[0];
    return best
      .sort((a, b) => Number(a.text) - Number(b.text))
      .map((item) => ({ label: item.text, x: item.x, top: item.top }));
  }

  function scoreLetterGroup(group, pageWidth) {
    return group.length * 10 + span(group.map((item) => item.x)) / Math.max(pageWidth, 1);
  }

  function scoreNumberGroup(group) {
    const leftBonus = 1000 / Math.max(100, average(group.map((item) => item.x)));
    return group.length * 10 + leftBonus;
  }

  function extractPileRows(items, gridModel) {
    const numberItems = items
      .filter((item) => item.pageNo === 1)
      .filter((item) => /^\d{1,4}$/.test(item.text))
      .filter((item) => Number(item.text) > 0 && Number(item.text) <= 9999)
      .filter((item) => isInsideGridBounds(item, gridModel));

    const byNumber = new Map();
    numberItems.forEach((item) => {
      const value = Number(item.text);
      if (!byNumber.has(value)) {
        byNumber.set(value, item);
      }
    });

    const bestRun = longestConsecutiveRun([...byNumber.keys()].sort((a, b) => a - b));
    if (bestRun.length >= 20) {
      return bestRun.map((value) => {
        const item = byNumber.get(value);
        return normalizePile({
          number: String(value),
          grid: nearestGrid(item, gridModel),
          source: "pdf-text",
          x: item.x,
          y: item.y
        });
      });
    }

    const explicit = extractExplicitPileLabels(items, gridModel);
    if (explicit.length >= 8 || explicit.some((pile) => !/^PT\b/i.test(pile.number))) {
      return explicit;
    }

    return [];
  }

  function extractExplicitPileLabels(items, gridModel) {
    const lines = buildTextLines(items.filter((item) => item.pageNo === 1));
    const matches = [];
    lines.forEach((line) => {
      const regex = /\b((?:P|BP|CP|PILE|PT)\s*-?\s*\d{1,5})\b/gi;
      let match = regex.exec(line.text);
      while (match) {
        const firstItem = line.items[0];
        matches.push(
          normalizePile({
            number: cleanText(match[1]).replace(/\s+/g, " ").toUpperCase(),
            grid: nearestGrid(firstItem, gridModel),
            source: "pdf-text",
            x: firstItem?.x || 0,
            y: firstItem?.y || 0
          })
        );
        match = regex.exec(line.text);
      }
    });
    return uniquePiles(matches);
  }

  function isInsideGridBounds(item, gridModel) {
    if (!gridModel.letters.length || !gridModel.numbers.length) {
      return true;
    }
    const letterX = gridModel.letters.map((grid) => grid.x);
    const numberTop = gridModel.numbers.map((grid) => grid.top);
    const xMin = Math.min(...letterX) - 140;
    const xMax = Math.max(...letterX) + 140;
    const topMin = Math.min(...gridModel.letters.map((grid) => grid.top), ...numberTop) - 80;
    const topMax = Math.max(...numberTop) + 80;
    return item.x >= xMin && item.x <= xMax && item.top >= topMin && item.top <= topMax;
  }

  function nearestGrid(item, gridModel) {
    if (!item || !gridModel.letters.length || !gridModel.numbers.length) {
      return "";
    }
    const letter = nearestBy(gridModel.letters, item.x, "x");
    const number = nearestBy(gridModel.numbers, item.top, "top");
    return letter && number ? `${letter.label}/${number.label}` : "";
  }

  function handleDrawingChange() {
    state.activeDrawingId = els.drawingSelect.value;
    persist();
    resetEntryForm();
    render();
  }

  function saveDrawingEdits() {
    const drawing = getActiveDrawing();
    if (!drawing) {
      showMessage("Upload a PDF first.", true);
      return;
    }

    drawing.projectTitle = cleanText(els.projectTitle.value) || drawing.projectTitle;
    drawing.drawingTitle = cleanText(els.drawingTitle.value) || drawing.drawingTitle;
    drawing.gridLetters = parseList(els.gridLetters.value);
    drawing.gridNumbers = parseList(els.gridNumbers.value);
    drawing.updatedAt = Date.now();
    persist();
    render();
    showMessage("Drawing details saved.");
  }

  async function deleteActiveDrawing() {
    const drawing = getActiveDrawing();
    if (!drawing) {
      return;
    }
    const ok = window.confirm(`Remove ${drawing.fileName} and its local records?`);
    if (!ok) {
      return;
    }

    state.drawings = state.drawings.filter((item) => item.id !== drawing.id);
    state.records = state.records.filter((record) => record.drawingId !== drawing.id);
    state.activeDrawingId = state.drawings[0]?.id || "";
    await deletePdfBytes(drawing.id).catch(() => {});
    persist();
    resetEntryForm();
    render();
    showMessage("Drawing removed from this device.");
  }

  async function clearAllData() {
    const ok = window.confirm("Clear all local AkZ piling status data on this device?");
    if (!ok) {
      return;
    }
    localStorage.removeItem(STORAGE_KEY);
    state.drawings = [];
    state.records = [];
    state.activeDrawingId = "";
    await clearPdfBytes().catch(() => {});
    resetEntryForm();
    render();
    showMessage("Local data cleared.");
  }

  function addSinglePile() {
    const drawing = getActiveDrawing();
    if (!drawing) {
      showMessage("Upload or choose a drawing first.", true);
      return;
    }
    const number = cleanText(window.prompt("Pile number / point") || "");
    if (!number) {
      return;
    }
    const grid = els.rangeGrid.value || "";
    addPilesToDrawing(drawing, [{ number, grid, source: "manual" }]);
  }

  function addPileRange() {
    const drawing = getActiveDrawing();
    if (!drawing) {
      showMessage("Upload or choose a drawing first.", true);
      return;
    }

    const start = Number.parseInt(els.rangeStart.value, 10);
    const end = Number.parseInt(els.rangeEnd.value, 10);
    const prefix = cleanText(els.rangePrefix.value);
    const grid = els.rangeGrid.value || "";

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      showMessage("Enter a valid pile range.", true);
      return;
    }
    if (end - start > 3000) {
      showMessage("Use a smaller range.", true);
      return;
    }

    const piles = [];
    for (let value = start; value <= end; value += 1) {
      piles.push({ number: `${prefix}${value}`, grid, source: "manual" });
    }
    addPilesToDrawing(drawing, piles);
  }

  function addPilesToDrawing(drawing, piles) {
    const existing = new Set(drawing.piles.map((pile) => pile.number.toLowerCase()));
    const next = piles.map(normalizePile).filter((pile) => pile.number && !existing.has(pile.number.toLowerCase()));
    if (!next.length) {
      showMessage("No new pile numbers were added.", true);
      return;
    }
    drawing.piles = uniquePiles([...drawing.piles, ...next]).sort(sortPiles);
    drawing.updatedAt = Date.now();
    persist();
    render();
    showMessage(`${next.length} pile number${next.length === 1 ? "" : "s"} added.`);
  }

  function saveProgressRecord(event) {
    event.preventDefault();
    const drawing = getActiveDrawing();
    if (!drawing) {
      showMessage("Upload or choose a drawing first.", true);
      return;
    }

    const pileNumber = els.pileSelect.value;
    const pile = drawing.piles.find((item) => item.number === pileNumber);
    const date = els.pilingDate.value;
    const depth = cleanText(els.penetrationDepth.value);

    if (!pile) {
      showMessage("Choose a pile number.", true);
      return;
    }
    if (!date) {
      showMessage("Choose a piling date.", true);
      return;
    }
    if (!depth) {
      showMessage("Enter penetration depth.", true);
      return;
    }

    const grid = els.gridSelect.value || pile.grid || "";
    if (grid && grid !== pile.grid) {
      pile.grid = grid;
    }

    state.records.push(
      normalizeRecord({
        id: uniqueId("record"),
        drawingId: drawing.id,
        pileNumber: pile.number,
        grid,
        date,
        penetrationDepth: depth,
        remarks: cleanText(els.recordRemarks.value),
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    );

    drawing.updatedAt = Date.now();
    persist();
    els.penetrationDepth.value = "";
    els.recordRemarks.value = "";
    render();
    showMessage(`Progress saved for ${pile.number}.`);
  }

  function resetEntryForm() {
    els.gridSelect.value = "";
    renderPileSelect();
    els.pilingDate.value = todayInputValue();
    els.penetrationDepth.value = "";
    els.recordRemarks.value = "";
    renderHistory();
  }

  function handleStatusClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const drawing = getActiveDrawing();
    if (!drawing) {
      return;
    }

    const pileNumber = button.dataset.pile;
    const pile = drawing.piles.find((item) => item.number === pileNumber);
    if (!pile) {
      return;
    }

    if (button.dataset.action === "select") {
      els.gridSelect.value = pile.grid || "";
      renderPileSelect();
      els.pileSelect.value = pile.number;
      renderHistory();
      window.scrollTo({ top: document.querySelector(".entry-panel").offsetTop - 12, behavior: "smooth" });
    }

    if (button.dataset.action === "remove") {
      const hasRecords = state.records.some((record) => record.drawingId === drawing.id && record.pileNumber === pile.number);
      const ok = window.confirm(hasRecords ? `Remove ${pile.number} and its history?` : `Remove ${pile.number}?`);
      if (!ok) {
        return;
      }
      drawing.piles = drawing.piles.filter((item) => item.number !== pile.number);
      state.records = state.records.filter((record) => !(record.drawingId === drawing.id && record.pileNumber === pile.number));
      persist();
      render();
      showMessage(`${pile.number} removed.`);
    }

    if (button.dataset.action === "delete-record") {
      const record = state.records.find((item) => item.id === button.dataset.recordId);
      if (!record) {
        return;
      }
      const ok = window.confirm(`Delete ${record.pileNumber} record for ${record.date}?`);
      if (!ok) {
        return;
      }
      state.records = state.records.filter((item) => item.id !== record.id);
      persist();
      render();
      showMessage("Record deleted.");
    }
  }

  function handleStatusChange(event) {
    const select = event.target.closest("select[data-action='grid']");
    if (!select) {
      return;
    }
    const drawing = getActiveDrawing();
    const pile = drawing?.piles.find((item) => item.number === select.dataset.pile);
    if (!pile) {
      return;
    }
    pile.grid = select.value;
    drawing.updatedAt = Date.now();
    persist();
    renderGridSelects();
    renderPileSelect();
    renderStats();
  }

  function render() {
    ensureActiveDrawing();
    renderDrawingSelect();
    renderDrawingFields();
    renderGridSelects();
    renderPileSelect();
    renderStats();
    renderStatusTable();
    renderHistory();
    updateControlStates();
  }

  function ensureActiveDrawing() {
    if (state.activeDrawingId && state.drawings.some((drawing) => drawing.id === state.activeDrawingId)) {
      return;
    }
    state.activeDrawingId = state.drawings[0]?.id || "";
  }

  function renderDrawingSelect() {
    const options = state.drawings.map(
      (drawing) => `<option value="${escapeAttr(drawing.id)}">${escapeHtml(drawing.fileName)}</option>`
    );
    els.drawingSelect.innerHTML = options.length ? options.join("") : `<option value="">No PDF uploaded</option>`;
    els.drawingSelect.value = state.activeDrawingId;
  }

  function renderDrawingFields() {
    const drawing = getActiveDrawing();
    els.projectTitle.value = drawing?.projectTitle || "";
    els.drawingTitle.value = drawing?.drawingTitle || "";
    els.gridLetters.value = drawing?.gridLetters.join(", ") || "";
    els.gridNumbers.value = drawing?.gridNumbers.join(", ") || "";
  }

  function renderGridSelects() {
    const drawing = getActiveDrawing();
    const gridOptions = drawing ? getGridOptions(drawing) : [];
    const entryCurrent = els.gridSelect.value;
    const rangeCurrent = els.rangeGrid.value;
    const gridHtml = gridOptions.map((grid) => `<option value="${escapeAttr(grid)}">${escapeHtml(grid)}</option>`).join("");

    els.gridSelect.innerHTML = `<option value="">All grids</option>${gridHtml}`;
    els.rangeGrid.innerHTML = `<option value="">Unassigned</option>${gridHtml}`;

    if (gridOptions.includes(entryCurrent) || entryCurrent === "") {
      els.gridSelect.value = entryCurrent;
    }
    if (gridOptions.includes(rangeCurrent) || rangeCurrent === "") {
      els.rangeGrid.value = rangeCurrent;
    }
  }

  function renderPileSelect() {
    const drawing = getActiveDrawing();
    const current = els.pileSelect.value;
    const grid = els.gridSelect.value;
    const piles = drawing ? drawing.piles.filter((pile) => !grid || pile.grid === grid).sort(sortPiles) : [];
    els.pileSelect.innerHTML = piles.length
      ? piles.map((pile) => `<option value="${escapeAttr(pile.number)}">${escapeHtml(pile.number)}</option>`).join("")
      : `<option value="">No piles</option>`;
    if (piles.some((pile) => pile.number === current)) {
      els.pileSelect.value = current;
    }
  }

  function renderStats() {
    const drawing = getActiveDrawing();
    const total = drawing?.piles.length || 0;
    const recorded = drawing ? drawing.piles.filter((pile) => getLatestRecord(drawing.id, pile.number)).length : 0;
    const pending = Math.max(total - recorded, 0);
    const percent = total ? Math.round((recorded / total) * 100) : 0;

    els.totalPiles.textContent = String(total);
    els.recordedPiles.textContent = String(recorded);
    els.pendingPiles.textContent = String(pending);
    els.progressPercent.textContent = `${percent}%`;
  }

  function renderStatusTable() {
    const drawing = getActiveDrawing();
    const search = cleanText(els.pileSearch.value).toLowerCase();
    const gridOptions = drawing ? getGridOptions(drawing) : [];
    const piles = drawing
      ? drawing.piles
          .filter((pile) => {
            const latest = getLatestRecord(drawing.id, pile.number);
            const haystack = [pile.number, pile.grid, latest?.date, latest?.penetrationDepth, latest?.remarks].join(" ").toLowerCase();
            return !search || haystack.includes(search);
          })
          .sort(sortPiles)
      : [];

    els.emptyState.classList.toggle("show", !drawing || !piles.length);
    els.emptyState.querySelector("p").textContent = drawing ? "No piles match the current search." : "No drawing loaded.";
    els.statusBody.innerHTML = piles.map((pile) => renderPileRow(drawing, pile, gridOptions)).join("");
  }

  function renderPileRow(drawing, pile, gridOptions) {
    const latest = getLatestRecord(drawing.id, pile.number);
    const gridHtml = [`<option value="">Unassigned</option>`]
      .concat(gridOptions.map((grid) => `<option value="${escapeAttr(grid)}">${escapeHtml(grid)}</option>`))
      .join("");
    const statusClass = latest ? "status-done" : "status-open";

    return `
      <tr>
        <td><strong>${escapeHtml(pile.number)}</strong></td>
        <td>
          <select class="inline-select" data-action="grid" data-pile="${escapeAttr(pile.number)}">
            ${gridHtml}
          </select>
        </td>
        <td>${escapeHtml(latest?.date || "-")}</td>
        <td>${escapeHtml(latest?.penetrationDepth || "-")}</td>
        <td><span class="${statusClass}">${latest ? "Recorded" : "Pending"}</span></td>
        <td class="row-actions">
          <button class="secondary-button mini-button" type="button" data-action="select" data-pile="${escapeAttr(pile.number)}">Select</button>
          <button class="danger-button mini-button" type="button" data-action="remove" data-pile="${escapeAttr(pile.number)}">Remove</button>
        </td>
      </tr>
    `.replace('value="' + escapeAttr(pile.grid || "") + '"', 'value="' + escapeAttr(pile.grid || "") + '" selected');
  }

  function renderHistory() {
    const drawing = getActiveDrawing();
    const pileNumber = els.pileSelect.value;
    const records = drawing && pileNumber ? getPileRecords(drawing.id, pileNumber) : [];
    els.pileHistory.innerHTML = records.length
      ? records
          .map(
            (record) => `
              <div class="history-row">
                <div>
                  <strong>${escapeHtml(record.date)}</strong>
                  <span>${escapeHtml(record.penetrationDepth)}</span>
                  ${record.remarks ? `<p>${escapeHtml(record.remarks)}</p>` : ""}
                </div>
                <button class="danger-button mini-button" type="button" data-action="delete-record" data-record-id="${escapeAttr(record.id)}" data-pile="${escapeAttr(record.pileNumber)}">Delete</button>
              </div>
            `
          )
          .join("")
      : `<p class="muted-text">No history for this pile.</p>`;
  }

  function updateControlStates() {
    const hasDrawing = Boolean(getActiveDrawing());
    [
      els.drawingSelect,
      els.deleteDrawingButton,
      els.projectTitle,
      els.drawingTitle,
      els.gridLetters,
      els.gridNumbers,
      els.saveDrawingButton,
      els.exportCsvButton,
      els.exportPdfButton,
      els.gridSelect,
      els.pileSelect,
      els.pilingDate,
      els.penetrationDepth,
      els.recordRemarks,
      els.resetEntryButton,
      els.pileSearch,
      els.addPileButton,
      els.rangeStart,
      els.rangeEnd,
      els.rangePrefix,
      els.rangeGrid,
      els.addRangeButton
    ].forEach((element) => {
      element.disabled = !hasDrawing;
    });
  }

  function exportCsv() {
    const drawing = getActiveDrawing();
    if (!drawing) {
      showMessage("Upload or choose a drawing first.", true);
      return;
    }

    const rows = drawing.piles.map((pile) => {
      const latest = getLatestRecord(drawing.id, pile.number);
      return [
        drawing.projectTitle,
        drawing.drawingTitle,
        drawing.fileName,
        pile.number,
        pile.grid || "",
        latest?.date || "",
        latest?.penetrationDepth || "",
        latest?.remarks || "",
        getPileRecords(drawing.id, pile.number).length,
        latest ? "Recorded" : "Pending"
      ];
    });
    const csv = [
      ["Project Title", "Drawing Title", "PDF File", "Pile Number", "Grid", "Latest Piling Date", "Latest Penetration Depth", "Latest Remarks", "History Count", "Status"],
      ...rows
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\n");

    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${filenamePart(drawing.drawingTitle || drawing.fileName)}-akz-status.csv`);
    showMessage("CSV exported.");
  }

  async function exportEmbeddedPdf() {
    const drawing = getActiveDrawing();
    if (!drawing) {
      showMessage("Upload or choose a drawing first.", true);
      return;
    }

    showMessage("Preparing PDF output...");
    try {
      const originalBytes = await readPdfBytes(drawing.id);
      if (!originalBytes) {
        showMessage("Original PDF is not stored on this device. Re-upload it before exporting.", true);
        return;
      }

      const PDFLib = await ensurePdfLib();
      const pdfDoc = await PDFLib.PDFDocument.load(originalBytes, { ignoreEncryption: true });
      const font = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
      const bold = await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaBold);
      const pages = pdfDoc.getPages();
      const summaryRows = buildSummaryRows(drawing);
      const recorded = summaryRows.filter((row) => row.status === "Recorded").length;

      pdfDoc.setTitle(`${drawing.drawingTitle || drawing.fileName} - AkZ Piling Status`);
      pdfDoc.setSubject(`AkZ Piling Status Ver${APP_VERSION}: ${recorded} of ${summaryRows.length} piles recorded`);
      pdfDoc.setKeywords(["AkZ Piling Status", `Ver${APP_VERSION}`, "piling", "penetration", "local records"]);
      stampOriginalPdfPage(PDFLib, pages[0], font, drawing, recorded, summaryRows.length);
      appendSummaryPages(PDFLib, pdfDoc, font, bold, drawing, summaryRows);

      const outputBytes = await pdfDoc.save({ useObjectStreams: false });
      downloadBlob(new Blob([outputBytes], { type: "application/pdf" }), `${filenamePart(drawing.drawingTitle || drawing.fileName)}-akz-status.pdf`);
      showMessage("PDF output exported.");
    } catch (error) {
      showMessage("PDF output failed. Check the PDF and try again.", true);
    }
  }

  function buildSummaryRows(drawing) {
    return drawing.piles.sort(sortPiles).map((pile) => {
      const latest = getLatestRecord(drawing.id, pile.number);
      return {
        pile: pile.number,
        grid: pile.grid || "",
        date: latest?.date || "",
        depth: latest?.penetrationDepth || "",
        remarks: latest?.remarks || "",
        status: latest ? "Recorded" : "Pending"
      };
    });
  }

  function stampOriginalPdfPage(PDFLib, page, font, drawing, recorded, total) {
    if (!page) {
      return;
    }
    const { width } = page.getSize();
    const text = `AkZ Piling Status Ver${APP_VERSION} | ${recorded}/${total} piles recorded | ${formatDateForDisplay(new Date())}`;
    page.drawRectangle({
      x: 24,
      y: 20,
      width: Math.min(width - 48, 520),
      height: 20,
      color: PDFLib.rgb(1, 1, 1),
      opacity: 0.82
    });
    page.drawText(text, {
      x: 30,
      y: 26,
      size: 8,
      font,
      color: PDFLib.rgb(0.08, 0.3, 0.38)
    });
    page.drawText(truncatePdfText(drawing.drawingTitle || drawing.fileName, 88), {
      x: 30,
      y: 11,
      size: 6,
      font,
      color: PDFLib.rgb(0.26, 0.32, 0.35)
    });
  }

  function appendSummaryPages(PDFLib, pdfDoc, font, bold, drawing, rows) {
    const pageSize = [842, 595];
    const margin = 32;
    const rowHeight = 16;
    const rowsPerPage = 24;
    const chunks = chunk(rows, rowsPerPage);

    chunks.forEach((pageRows, pageIndex) => {
      const page = pdfDoc.addPage(pageSize);
      const { width, height } = page.getSize();
      let y = height - margin;

      page.drawText("AkZ Piling Status Summary", { x: margin, y, size: 16, font: bold, color: PDFLib.rgb(0.08, 0.3, 0.38) });
      page.drawText(`Ver${APP_VERSION}`, { x: width - margin - 48, y: y + 2, size: 9, font, color: PDFLib.rgb(0.28, 0.35, 0.38) });
      y -= 22;
      page.drawText(`Project: ${truncatePdfText(drawing.projectTitle || "-", 128)}`, { x: margin, y, size: 9, font, color: PDFLib.rgb(0.1, 0.12, 0.13) });
      y -= 14;
      page.drawText(`Drawing: ${truncatePdfText(drawing.drawingTitle || drawing.fileName, 128)}`, { x: margin, y, size: 9, font, color: PDFLib.rgb(0.1, 0.12, 0.13) });
      y -= 14;
      page.drawText(`Source PDF: ${truncatePdfText(drawing.fileName, 128)}`, { x: margin, y, size: 8, font, color: PDFLib.rgb(0.28, 0.35, 0.38) });
      y -= 24;

      drawTableHeader(PDFLib, page, bold, margin, y);
      y -= rowHeight;

      pageRows.forEach((row) => {
        drawTableRow(PDFLib, page, font, margin, y, row);
        y -= rowHeight;
      });

      page.drawText(`Page ${pageIndex + 1} of ${chunks.length} | Exported ${formatDateForDisplay(new Date())}`, {
        x: margin,
        y: 20,
        size: 7,
        font,
        color: PDFLib.rgb(0.28, 0.35, 0.38)
      });
    });
  }

  function drawTableHeader(PDFLib, page, font, x, y) {
    page.drawRectangle({ x, y: y - 4, width: 778, height: 18, color: PDFLib.rgb(0.9, 0.96, 0.97) });
    [
      ["Pile", 0],
      ["Grid", 76],
      ["Date", 152],
      ["Depth", 230],
      ["Status", 320],
      ["Remarks", 410]
    ].forEach(([label, offset]) => {
      page.drawText(label, { x: x + offset, y, size: 8, font, color: PDFLib.rgb(0.08, 0.3, 0.38) });
    });
  }

  function drawTableRow(PDFLib, page, font, x, y, row) {
    page.drawLine({
      start: { x, y: y - 5 },
      end: { x: x + 778, y: y - 5 },
      thickness: 0.35,
      color: PDFLib.rgb(0.8, 0.86, 0.86)
    });
    [
      [row.pile, 0, 14],
      [row.grid || "-", 76, 14],
      [row.date || "-", 152, 14],
      [row.depth || "-", 230, 18],
      [row.status, 320, 18],
      [row.remarks || "", 410, 76]
    ].forEach(([value, offset, max]) => {
      page.drawText(truncatePdfText(value, max), { x: x + offset, y, size: 7, font, color: PDFLib.rgb(0.1, 0.12, 0.13) });
    });
  }

  function getActiveDrawing() {
    return state.drawings.find((drawing) => drawing.id === state.activeDrawingId) || null;
  }

  function getGridOptions(drawing) {
    const cross = [];
    drawing.gridLetters.forEach((letter) => {
      drawing.gridNumbers.forEach((number) => cross.push(`${letter}/${number}`));
    });
    const assigned = drawing.piles.map((pile) => pile.grid).filter(Boolean);
    return uniqueStrings([...cross, ...assigned]).sort(sortGrid);
  }

  function getPileRecords(drawingId, pileNumber) {
    return state.records
      .filter((record) => record.drawingId === drawingId && record.pileNumber === pileNumber)
      .sort((a, b) => {
        const dateSort = b.date.localeCompare(a.date);
        return dateSort || b.createdAt - a.createdAt;
      });
  }

  function getLatestRecord(drawingId, pileNumber) {
    return getPileRecords(drawingId, pileNumber)[0] || null;
  }

  function normalizeDrawing(drawing) {
    if (!drawing) {
      return null;
    }
    const id = cleanText(drawing.id) || uniqueId("drawing");
    const piles = Array.isArray(drawing.piles) ? uniquePiles(drawing.piles.map(normalizePile).filter(Boolean)).sort(sortPiles) : [];
    return {
      id,
      fileName: cleanText(drawing.fileName) || "drawing.pdf",
      projectTitle: cleanTitle(drawing.projectTitle),
      drawingTitle: cleanTitle(drawing.drawingTitle),
      pageCount: Number(drawing.pageCount) || 0,
      gridLetters: parseList(Array.isArray(drawing.gridLetters) ? drawing.gridLetters.join(",") : drawing.gridLetters),
      gridNumbers: parseList(Array.isArray(drawing.gridNumbers) ? drawing.gridNumbers.join(",") : drawing.gridNumbers),
      piles,
      importedAt: Number(drawing.importedAt) || Date.now(),
      updatedAt: Number(drawing.updatedAt) || Date.now(),
      pdfStored: Boolean(drawing.pdfStored),
      extractionNote: cleanText(drawing.extractionNote)
    };
  }

  function normalizePile(pile) {
    if (!pile) {
      return null;
    }
    const number = cleanText(pile.number || pile.pileNumber);
    if (!number) {
      return null;
    }
    return {
      number,
      grid: cleanText(pile.grid),
      source: cleanText(pile.source) || "manual",
      x: Number(pile.x) || 0,
      y: Number(pile.y) || 0,
      addedAt: Number(pile.addedAt) || Date.now()
    };
  }

  function normalizeRecord(record) {
    if (!record) {
      return null;
    }
    const drawingId = cleanText(record.drawingId);
    const pileNumber = cleanText(record.pileNumber);
    const date = normalizeDate(record.date);
    const penetrationDepth = cleanText(record.penetrationDepth);
    if (!drawingId || !pileNumber || !date || !penetrationDepth) {
      return null;
    }
    return {
      id: cleanText(record.id) || uniqueId("record"),
      drawingId,
      pileNumber,
      grid: cleanText(record.grid),
      date,
      penetrationDepth,
      remarks: cleanText(record.remarks),
      createdAt: Number(record.createdAt) || Date.now(),
      updatedAt: Number(record.updatedAt) || Date.now()
    };
  }

  async function ensurePdfJs() {
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return window.pdfjsLib;
    }
    if (!pdfJsPromise) {
      pdfJsPromise = loadScript(PDFJS_SCRIPT).then(() => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        return window.pdfjsLib;
      });
    }
    return pdfJsPromise;
  }

  async function ensurePdfLib() {
    if (window.PDFLib) {
      return window.PDFLib;
    }
    if (!pdfLibPromise) {
      pdfLibPromise = loadScript(PDFLIB_SCRIPT).then(() => window.PDFLib);
    }
    return pdfLibPromise;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  function openDb() {
    if (!("indexedDB" in window)) {
      return Promise.reject(new Error("IndexedDB unavailable"));
    }
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("pdfs", { keyPath: "id" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }

  async function savePdfBytes(id, buffer) {
    const db = await openDb();
    return transact(db, "readwrite", (store) => store.put({ id, buffer, savedAt: Date.now() }));
  }

  async function readPdfBytes(id) {
    const db = await openDb();
    const record = await transact(db, "readonly", (store) => store.get(id));
    return record?.buffer || null;
  }

  async function deletePdfBytes(id) {
    const db = await openDb();
    return transact(db, "readwrite", (store) => store.delete(id));
  }

  async function clearPdfBytes() {
    const db = await openDb();
    return transact(db, "readwrite", (store) => store.clear());
  }

  function transact(db, mode, callback) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("pdfs", mode);
      const request = callback(transaction.objectStore("pdfs"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator && /^https?:$/.test(window.location.protocol)) {
      navigator.serviceWorker.register("./sw.js?v=1.0.0").catch(() => {});
    }
  }

  function groupClose(items, key, tolerance) {
    const groups = [];
    [...items]
      .sort((a, b) => a[key] - b[key])
      .forEach((item) => {
        const group = groups[groups.length - 1];
        if (group && Math.abs(average(group.map((current) => current[key])) - item[key]) <= tolerance) {
          group.push(item);
        } else {
          groups.push([item]);
        }
      });
    return groups;
  }

  function uniquePositionLabels(items, positionKey) {
    const byText = new Map();
    items.forEach((item) => {
      if (!byText.has(item.text)) {
        byText.set(item.text, item);
        return;
      }
      const current = byText.get(item.text);
      if (item[positionKey] < current[positionKey]) {
        byText.set(item.text, item);
      }
    });
    return [...byText.values()];
  }

  function uniquePiles(piles) {
    const seen = new Set();
    return piles.filter((pile) => {
      const key = pile.number.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function uniqueStrings(values) {
    return [...new Set(values.map(cleanText).filter(Boolean))];
  }

  function longestConsecutiveRun(values) {
    let best = [];
    let current = [];
    values.forEach((value, index) => {
      if (index === 0 || value === values[index - 1] + 1) {
        current.push(value);
      } else {
        if (current.length > best.length) {
          best = current;
        }
        current = [value];
      }
    });
    return current.length > best.length ? current : best;
  }

  function nearestBy(items, value, key) {
    return items.reduce((best, item) => {
      if (!best || Math.abs(item[key] - value) < Math.abs(best[key] - value)) {
        return item;
      }
      return best;
    }, null);
  }

  function sortPiles(a, b) {
    return a.number.localeCompare(b.number, undefined, { numeric: true, sensitivity: "base" });
  }

  function sortGrid(a, b) {
    const [aLetter, aNumber] = a.split("/");
    const [bLetter, bNumber] = b.split("/");
    const letterSort = aLetter.localeCompare(bLetter, undefined, { numeric: true });
    return letterSort || Number(aNumber) - Number(bNumber);
  }

  function parseList(value) {
    return uniqueStrings(String(value || "").split(/[,;\s]+/));
  }

  function normalizeDate(value) {
    const text = cleanText(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return text;
    }
    const match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (!match) {
      return "";
    }
    return `${match[3]}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
  }

  function todayInputValue() {
    return new Date().toISOString().slice(0, 10);
  }

  function formatDateForDisplay(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function titleFromFileName(fileName) {
    return cleanTitle(String(fileName || "drawing").replace(/\.pdf$/i, "").replace(/[_-]+/g, " "));
  }

  function cleanTitle(value) {
    return cleanText(value)
      .replace(/\s*:\s*/g, ": ")
      .replace(/\s+\/\s+/g, " / ")
      .replace(/\s{2,}/g, " ")
      .slice(0, 260);
  }

  function cleanText(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
  }

  function span(values) {
    return values.length ? Math.max(...values) - Math.min(...values) : 0;
  }

  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function chunk(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks.length ? chunks : [[]];
  }

  function truncatePdfText(value, maxLength) {
    const text = cleanText(value);
    return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function filenamePart(value) {
    return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "akz-piling-status";
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function uniqueId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function showMessage(message, isError) {
    els.appMessage.textContent = message;
    els.appMessage.classList.toggle("error", Boolean(isError));
    els.storageStatus.dataset.state = isError ? "error" : "local";
    els.storageStatus.querySelector("span:last-child").textContent = isError ? "Needs review" : "Local data";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }
})();
