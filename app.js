(function () {
  "use strict";

  const APP_VERSION = "1.0.4";
  const STORAGE_KEY = "akz:piling-status:v1";
  const DB_NAME = "akz-piling-status";
  const DB_VERSION = 1;
  const PDFJS_SCRIPT = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const PDFLIB_SCRIPT = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js";
  const TESSERACT_SCRIPT = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
  const DEFAULT_GRID_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ".split("");
  const OCR_MASK_SCALE = 2;

  const els = {
    pdfInput: document.querySelector("#pdfInput"),
    drawingSelect: document.querySelector("#drawingSelect"),
    deleteDrawingButton: document.querySelector("#deleteDrawingButton"),
    projectTitle: document.querySelector("#projectTitle"),
    drawingTitle: document.querySelector("#drawingTitle"),
    gridLetters: document.querySelector("#gridLetters"),
    gridNumbers: document.querySelector("#gridNumbers"),
    saveDrawingButton: document.querySelector("#saveDrawingButton"),
    scanDrawingButton: document.querySelector("#scanDrawingButton"),
    exportCsvButton: document.querySelector("#exportCsvButton"),
    exportPdfButton: document.querySelector("#exportPdfButton"),
    clearDataButton: document.querySelector("#clearDataButton"),
    appMessage: document.querySelector("#appMessage"),
    totalPiles: document.querySelector("#totalPiles"),
    recordedPiles: document.querySelector("#recordedPiles"),
    pendingPiles: document.querySelector("#pendingPiles"),
    progressPercent: document.querySelector("#progressPercent"),
    recordForm: document.querySelector("#recordForm"),
    gridXSelect: document.querySelector("#gridXSelect"),
    gridYSelect: document.querySelector("#gridYSelect"),
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
  let tesseractPromise = null;
  let dbPromise = null;

  init();

  function init() {
    els.pilingDate.value = todayInputValue();

    els.pdfInput.addEventListener("change", handlePdfUpload);
    els.drawingSelect.addEventListener("change", handleDrawingChange);
    els.deleteDrawingButton.addEventListener("click", deleteActiveDrawing);
    els.saveDrawingButton.addEventListener("click", saveDrawingEdits);
    els.scanDrawingButton.addEventListener("click", scanActiveDrawing);
    els.exportCsvButton.addEventListener("click", exportCsv);
    els.exportPdfButton.addEventListener("click", exportEmbeddedPdf);
    els.clearDataButton.addEventListener("click", clearAllData);
    els.recordForm.addEventListener("submit", saveProgressRecord);
    els.resetEntryButton.addEventListener("click", resetEntryForm);
    els.gridXSelect.addEventListener("change", handleEntryGridChange);
    els.gridYSelect.addEventListener("change", handleEntryGridChange);
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

  function handleEntryGridChange() {
    renderGridSelects();
    renderPileSelect();
    renderHistory();
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

    showMessage(`Reading and scanning ${files.length} PDF file${files.length === 1 ? "" : "s"}...`);
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
    const textGridModel = detectGridModel(items);
    const textPiles = extractPileRows(items, textGridModel);
    const visual = await extractVisualPlanInfo(pdf).catch(() => null);
    const gridModel = visual?.gridModel?.letters?.length && visual?.gridModel?.numbers?.length ? visual.gridModel : textGridModel;
    const visualPiles = visual?.piles || [];
    const piles = visualPiles.length >= textPiles.length ? visualPiles : textPiles;
    const noteParts = [];
    if (visual?.note) {
      noteParts.push(visual.note);
    }
    if (!piles.length) {
      noteParts.push("No pile numbers were found automatically.");
    }

    return {
      projectTitle: metadata.projectTitle,
      drawingTitle: metadata.drawingTitle,
      pageCount: pdf.numPages,
      gridLetters: gridModel.letters.map((item) => item.label),
      gridNumbers: gridModel.numbers.map((item) => item.label),
      piles,
      extractionNote: noteParts.join(" ")
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

  async function extractVisualPlanInfo(pdf) {
    const page = await pdf.getPage(1);
    const canvas = await renderPdfPageToCanvas(page, 2);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const plan = detectVisualPlan(imageData);
    const piles = plan.box ? await recognizeRedPileNumbers(canvas, imageData, plan) : [];
    const noteParts = [];

    if (!plan.redBox) {
      noteParts.push("No red pile-number area was detected.");
    }
    if (!plan.gridModel.letters.length || !plan.gridModel.numbers.length) {
      noteParts.push("X/Y grid axes were not detected from drawing lines.");
    }
    if (!piles.length) {
      noteParts.push("Red pile-number OCR found no usable numbers.");
    }

    return {
      gridModel: plan.gridModel,
      piles,
      note: noteParts.join(" ")
    };
  }

  async function renderPdfPageToCanvas(page, scale) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    return canvas;
  }

  function detectVisualPlan(imageData) {
    const { data, width, height } = imageData;
    const redBox = findRedPlanBox(data, width, height);
    const box = redBox
      ? expandBox(redBox, Math.round(width * 0.075), Math.round(height * 0.085), width, height)
      : {
          x0: Math.round(width * 0.18),
          y0: Math.round(height * 0.36),
          x1: Math.round(width * 0.84),
          y1: Math.round(height * 0.94)
        };
    const axes = detectVisualGridAxes(data, width, height, box, redBox);
    const gridModel = {
      letters: axes.vertical.map((axis, index) => ({ label: DEFAULT_GRID_LETTERS[index] || String(index + 1), x: axis.value, top: box.y0 })),
      numbers: axes.horizontal.map((axis, index) => ({ label: String(index + 1), x: box.x0, top: axis.value }))
    };
    return { box, redBox, axes, gridModel };
  }

  function findRedPlanBox(data, width, height) {
    let x0 = width;
    let y0 = height;
    let x1 = 0;
    let y1 = 0;
    let count = 0;
    const minY = Math.round(height * 0.34);
    const maxX = Math.round(width * 0.88);

    for (let y = minY; y < height; y += 2) {
      for (let x = 0; x < maxX; x += 2) {
        const offset = (y * width + x) * 4;
        if (!isRedPixel(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) {
          continue;
        }
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
        count += 1;
      }
    }

    if (count < 120) {
      return null;
    }
    return { x0, y0, x1, y1 };
  }

  function detectVisualGridAxes(data, width, height, box, redBox) {
    const colProfile = new Int32Array(width);
    const rowProfile = new Int32Array(height);
    for (let y = box.y0; y <= box.y1; y += 1) {
      for (let x = box.x0; x <= box.x1; x += 1) {
        const offset = (y * width + x) * 4;
        if (isGridLinePixel(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) {
          colProfile[x] += 1;
          rowProfile[y] += 1;
        }
      }
    }

    const boxHeight = Math.max(1, box.y1 - box.y0 + 1);
    const boxWidth = Math.max(1, box.x1 - box.x0 + 1);
    let vertical = profilePeaks(colProfile, box.x0, box.x1, boxHeight * 0.24);
    let horizontal = profilePeaks(rowProfile, box.y0, box.y1, boxWidth * 0.14);

    if (redBox) {
      vertical = vertical.filter((peak) => peak.value >= redBox.x0 - width * 0.035 && peak.value <= redBox.x1 + width * 0.035);
      horizontal = horizontal.filter((peak) => peak.value >= redBox.y0 - height * 0.075 && peak.value <= redBox.y1 + height * 0.06);
    }

    vertical = pruneClosePeaks(vertical, Math.max(8, width * 0.012));
    horizontal = pruneClosePeaks(horizontal, Math.max(8, height * 0.01));
    vertical = findRegularAxis(vertical, 5, width * 0.03, width * 0.16);

    if (vertical.length) {
      const axisHorizontal = horizontal.filter((peak) => hasLeftGridExtension(data, width, height, peak.value, vertical[0].value));
      if (axisHorizontal.length >= 5) {
        horizontal = axisHorizontal;
      }
    }

    return {
      vertical,
      horizontal
    };
  }

  function hasLeftGridExtension(data, width, height, y, firstVerticalX) {
    const x0 = Math.max(0, Math.round(firstVerticalX - width * 0.075));
    const x1 = Math.max(0, Math.round(firstVerticalX - width * 0.012));
    const y0 = Math.max(0, y - 3);
    const y1 = Math.min(height - 1, y + 3);
    const requiredRun = Math.max(38, width * 0.025);

    for (let row = y0; row <= y1; row += 1) {
      let run = 0;
      for (let x = x0; x <= x1; x += 1) {
        const offset = (row * width + x) * 4;
        if (isGridLinePixel(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) {
          run += 1;
          if (run >= requiredRun) {
            return true;
          }
        } else {
          run = 0;
        }
      }
    }

    return false;
  }

  function profilePeaks(profile, start, end, threshold) {
    const peaks = [];
    let groupStart = -1;
    let score = 0;
    let weighted = 0;

    for (let index = start; index <= end; index += 1) {
      const value = profile[index];
      if (value >= threshold) {
        if (groupStart < 0) {
          groupStart = index;
          score = 0;
          weighted = 0;
        }
        score += value;
        weighted += value * index;
      }

      if ((value < threshold || index === end) && groupStart >= 0) {
        peaks.push({ value: Math.round(weighted / Math.max(score, 1)), score });
        groupStart = -1;
      }
    }

    return peaks;
  }

  function pruneClosePeaks(peaks, minGap) {
    const sorted = [...peaks].sort((a, b) => a.value - b.value);
    const pruned = [];
    sorted.forEach((peak) => {
      const last = pruned[pruned.length - 1];
      if (last && peak.value - last.value < minGap) {
        if (peak.score > last.score) {
          pruned[pruned.length - 1] = peak;
        }
        return;
      }
      pruned.push(peak);
    });
    return pruned;
  }

  function findRegularAxis(peaks, minLength, minSpacing, maxSpacing) {
    if (peaks.length < minLength) {
      return peaks;
    }

    const sorted = [...peaks].sort((a, b) => a.value - b.value);
    let best = [];
    let bestScore = -Infinity;

    for (let first = 0; first < sorted.length - 1; first += 1) {
      for (let second = first + 1; second < sorted.length; second += 1) {
        const spacing = sorted[second].value - sorted[first].value;
        if (spacing < minSpacing || spacing > maxSpacing) {
          continue;
        }

        const sequence = [sorted[first], sorted[second]];
        let expected = sorted[second].value + spacing;
        let error = 0;

        for (let index = second + 1; index < sorted.length; index += 1) {
          const tolerance = Math.max(10, spacing * 0.18);
          if (Math.abs(sorted[index].value - expected) <= tolerance) {
            sequence.push(sorted[index]);
            error += Math.abs(sorted[index].value - expected);
            expected += spacing;
          } else if (sorted[index].value > expected + tolerance) {
            expected += spacing;
            index -= 1;
          }
        }

        const score = sequence.length * 10000 - error - spacing * 0.02;
        if (sequence.length >= minLength && score > bestScore) {
          best = sequence;
          bestScore = score;
        }
      }
    }

    return best.length ? best : sorted;
  }

  async function recognizeRedPileNumbers(sourceCanvas, sourceImageData, plan) {
    const Tesseract = await ensureTesseract();
    const mask = buildRedOcrCanvas(sourceImageData, plan.box);
    const result = await Tesseract.recognize(mask.canvas, "eng", {
      tessedit_char_whitelist: "0123456789",
      tessedit_pageseg_mode: Tesseract.PSM?.SPARSE_TEXT || "11"
    });
    const words = result?.data?.words || [];
    const piles = words
      .map((word) => ocrWordToPile(word, mask, plan))
      .filter(Boolean)
      .filter((pile) => Number(pile.number) > 0 && Number(pile.number) < 10000);
    const unique = uniquePiles(piles);
    const sequenceLimit = inferSequenceLimit(unique);
    const cleaned = sequenceLimit ? pruneSequenceOutlierPiles(unique, sequenceLimit) : unique;

    return completeSequentialPiles(cleaned, plan.gridModel, sequenceLimit).sort(sortPiles);
  }

  function completeSequentialPiles(piles, gridModel, knownSequenceLimit = 0) {
    const sequenceLimit = knownSequenceLimit || inferSequenceLimit(piles);
    if (!sequenceLimit) {
      return piles;
    }

    const byNumber = new Map();
    piles.forEach((pile) => {
      const value = Number(pile.number);
      if (value >= 1 && value <= sequenceLimit) {
        byNumber.set(value, pile);
      }
    });

    const knownNumbers = [...byNumber.keys()].sort((a, b) => a - b);
    for (let value = 1; value <= sequenceLimit; value += 1) {
      if (byNumber.has(value)) {
        continue;
      }

      const position = interpolatePilePosition(value, knownNumbers, byNumber);
      byNumber.set(
        value,
        normalizePile({
          number: String(value),
          grid: position?.grid || (position ? nearestGrid({ x: position.x, top: position.y }, gridModel) : ""),
          source: "sequence-fill",
          x: position?.x || 0,
          y: position?.y || 0,
          coordinateScale: position?.coordinateScale || OCR_MASK_SCALE
        })
      );
    }

    return [...byNumber.values()];
  }

  function pruneSequenceOutlierPiles(piles, sequenceLimit) {
    let current = piles;

    for (let pass = 0; pass < 3; pass += 1) {
      const byNumber = new Map();
      current.forEach((pile) => {
        const value = Number(pile.number);
        if (Number.isInteger(value) && value >= 1 && value <= sequenceLimit) {
          byNumber.set(value, pile);
        }
      });

      const next = current.filter((pile) => !isSequenceGridOutlier(pile, byNumber, sequenceLimit));
      if (next.length === current.length) {
        return current;
      }
      current = next;
    }

    return current;
  }

  function isSequenceGridOutlier(pile, byNumber, sequenceLimit) {
    const value = Number(pile.number);
    if (!Number.isInteger(value) || value < 1 || value > sequenceLimit || pile.source !== "red-ocr") {
      return false;
    }

    const pileY = gridYNumber(pile.grid);
    if (!Number.isFinite(pileY)) {
      return false;
    }

    const neighbors = [];
    for (let offset = 1; offset <= 8; offset += 1) {
      [value - offset, value + offset].forEach((neighborValue) => {
        const neighbor = byNumber.get(neighborValue);
        if (!neighbor) {
          return;
        }
        const neighborY = gridYNumber(neighbor.grid);
        if (Number.isFinite(neighborY)) {
          neighbors.push({ y: neighborY, offset });
        }
      });
    }

    if (neighbors.length < 4) {
      return false;
    }

    const groups = new Map();
    neighbors.forEach((neighbor) => {
      const key = String(neighbor.y);
      const group = groups.get(key) || { y: neighbor.y, count: 0, weight: 0 };
      group.count += 1;
      group.weight += 1 / neighbor.offset;
      groups.set(key, group);
    });

    const strongest = [...groups.values()].sort((a, b) => b.weight - a.weight || b.count - a.count)[0];
    const localSupport = neighbors.filter((neighbor) => Math.abs(neighbor.y - pileY) <= 1);
    const localWeight = localSupport.reduce((sum, neighbor) => sum + 1 / neighbor.offset, 0);

    return Boolean(
      strongest &&
        Math.abs(strongest.y - pileY) > 1 &&
        strongest.count >= 3 &&
        strongest.weight > Math.max(0.35, localWeight * 1.45)
    );
  }

  function inferSequenceLimit(piles) {
    const numbers = uniqueNumericValues(piles.map((pile) => Number(pile.number))).filter((value) => value > 0);
    if (numbers[0] !== 1 || numbers.length < 40) {
      return 0;
    }

    let limit = 0;
    numbers.forEach((value, index) => {
      if (value < 50) {
        return;
      }
      const coverage = (index + 1) / value;
      const next = numbers[index + 1] || Infinity;
      const gap = next - value;
      if (coverage >= 0.55 && gap > Math.max(24, value * 0.22)) {
        limit = value;
      }
    });

    return limit;
  }

  function interpolatePilePosition(value, knownNumbers, byNumber) {
    let lower = 0;
    let upper = 0;
    for (let index = 0; index < knownNumbers.length; index += 1) {
      if (knownNumbers[index] < value) {
        lower = knownNumbers[index];
      }
      if (knownNumbers[index] > value) {
        upper = knownNumbers[index];
        break;
      }
    }

    const lowerPile = byNumber.get(lower);
    const upperPile = byNumber.get(upper);
    if (lowerPile && upperPile) {
      const structured = inferStructuredPilePosition(value, lower, upper, lowerPile, upperPile, byNumber);
      if (structured) {
        return structured;
      }

      const spanValue = upper - lower || 1;
      const ratio = (value - lower) / spanValue;
      const x = lowerPile.x + (upperPile.x - lowerPile.x) * ratio;
      const y = lowerPile.y + (upperPile.y - lowerPile.y) * ratio;
      return {
        x,
        y,
        grid: inferFilledPileGrid(value, lower, upper, lowerPile, upperPile, byNumber),
        coordinateScale: Number(lowerPile.coordinateScale) || Number(upperPile.coordinateScale) || OCR_MASK_SCALE
      };
    }
    if (lowerPile) {
      return { x: lowerPile.x, y: lowerPile.y, coordinateScale: Number(lowerPile.coordinateScale) || OCR_MASK_SCALE };
    }
    if (upperPile) {
      return { x: upperPile.x, y: upperPile.y, coordinateScale: Number(upperPile.coordinateScale) || OCR_MASK_SCALE };
    }
    return null;
  }

  function inferStructuredPilePosition(value, lowerValue, upperValue, lowerPile, upperPile, byNumber) {
    const missingCount = upperValue - lowerValue - 1;
    const lowerGrid = splitGrid(lowerPile.grid);
    const upperGrid = splitGrid(upperPile.grid);
    if (missingCount < 1 || !lowerGrid.y || lowerGrid.y !== upperGrid.y) {
      return null;
    }

    const lowerPrevious = byNumber.get(lowerValue - 1);
    const upperNext = byNumber.get(upperValue + 1);
    const verticalStep = inferSequenceVerticalStep(byNumber);

    if (missingCount === 1) {
      if (lowerPile.grid && lowerPile.grid === upperPile.grid && samePileColumn(lowerPile, upperPile)) {
        if (lowerPrevious?.grid === lowerPile.grid && samePileRow(lowerPrevious, lowerPile)) {
          return {
            x: lowerPrevious.x,
            y: upperPile.y,
            grid: lowerPile.grid,
            coordinateScale: Number(upperPile.coordinateScale) || Number(lowerPrevious.coordinateScale) || OCR_MASK_SCALE
          };
        }
        if (upperNext?.grid === upperPile.grid && samePileRow(upperPile, upperNext)) {
          return {
            x: upperNext.x,
            y: lowerPile.y,
            grid: upperPile.grid,
            coordinateScale: Number(upperNext.coordinateScale) || Number(lowerPile.coordinateScale) || OCR_MASK_SCALE
          };
        }
      }

      if (lowerPile.grid && lowerPile.grid !== upperPile.grid) {
        const topLeft = byNumber.get(lowerValue - 2);
        const topRight = byNumber.get(lowerValue - 1);
        if (topLeft?.grid === lowerPile.grid && topRight?.grid === lowerPile.grid && samePileRow(topLeft, topRight)) {
          const pairGap = Math.abs(topRight.x - topLeft.x);
          const rowGap = Math.abs(lowerPile.y - topRight.y);
          if (pairGap >= 20 && pairGap <= 120 && rowGap >= verticalStep * 0.45 && rowGap <= verticalStep * 1.55) {
            return {
              x: lowerPile.x + pairGap,
              y: lowerPile.y,
              grid: lowerPile.grid,
              coordinateScale: Number(lowerPile.coordinateScale) || OCR_MASK_SCALE
            };
          }
        }
      }
    }

    if (!lowerPrevious || lowerPrevious.grid !== lowerPile.grid) {
      return null;
    }

    const lowerSameColumn = samePileColumn(lowerPrevious, lowerPile);
    const lowerSameRow = samePileRow(lowerPrevious, lowerPile);

    if (missingCount === 2 && lowerSameColumn && upperNext && upperNext.grid === upperPile.grid) {
      const lowerVerticalGap = lowerPile.y - lowerPrevious.y;
      if (Math.abs(lowerVerticalGap) >= 16 && Math.abs(lowerVerticalGap) <= 90) {
        const target = value === upperValue - 2 ? upperPile : upperNext;
        return {
          x: target.x,
          y: target.y - lowerVerticalGap,
          grid: upperPile.grid,
          coordinateScale: Number(target.coordinateScale) || Number(upperPile.coordinateScale) || OCR_MASK_SCALE
        };
      }
    }

    if (missingCount === 2 && lowerSameRow) {
      const target = value === lowerValue + 1 ? lowerPrevious : lowerPile;
      return {
        x: target.x,
        y: target.y + verticalStep,
        grid: lowerPile.grid,
        coordinateScale: Number(target.coordinateScale) || Number(lowerPile.coordinateScale) || OCR_MASK_SCALE
      };
    }

    if (missingCount === 3 && lowerSameRow) {
      const pairGap = Math.abs(lowerPile.x - lowerPrevious.x);
      if (pairGap >= 20 && pairGap <= 120) {
        if (value === upperValue - 3) {
          return {
            x: upperPile.x - pairGap,
            y: upperPile.y - verticalStep,
            grid: upperPile.grid,
            coordinateScale: Number(upperPile.coordinateScale) || OCR_MASK_SCALE
          };
        }
        if (value === upperValue - 2) {
          return {
            x: upperPile.x,
            y: upperPile.y - verticalStep,
            grid: upperPile.grid,
            coordinateScale: Number(upperPile.coordinateScale) || OCR_MASK_SCALE
          };
        }
        return {
          x: upperPile.x - pairGap,
          y: upperPile.y,
          grid: upperPile.grid,
          coordinateScale: Number(upperPile.coordinateScale) || OCR_MASK_SCALE
        };
      }
    }

    return null;
  }

  function inferFilledPileGrid(value, lowerValue, upperValue, lowerPile, upperPile, byNumber) {
    if (lowerPile.grid && lowerPile.grid === upperPile.grid) {
      return lowerPile.grid;
    }

    const lowerGrid = splitGrid(lowerPile.grid);
    const upperGrid = splitGrid(upperPile.grid);
    const missingCount = upperValue - lowerValue - 1;
    if (missingCount >= 2 && lowerGrid.y && lowerGrid.y === upperGrid.y) {
      const lowerPrevious = byNumber.get(lowerValue - 1);
      if (lowerPrevious?.grid === lowerPile.grid) {
        if (samePileColumn(lowerPrevious, lowerPile) && upperPile.grid) {
          return upperPile.grid;
        }
        if (samePileRow(lowerPrevious, lowerPile)) {
          return missingCount === 2 ? lowerPile.grid : upperPile.grid;
        }
      }
    }

    return "";
  }

  function inferSequenceVerticalStep(byNumber) {
    const gaps = [];
    const piles = [...byNumber.values()];
    for (let first = 0; first < piles.length; first += 1) {
      for (let second = first + 1; second < piles.length; second += 1) {
        if (piles[first].grid !== piles[second].grid || !samePileColumn(piles[first], piles[second])) {
          continue;
        }
        const gap = Math.abs(piles[first].y - piles[second].y);
        if (gap >= 16 && gap <= 90) {
          gaps.push(gap);
        }
      }
    }
    return median(gaps) || 41;
  }

  function samePileColumn(a, b) {
    return Math.abs(Number(a.x) - Number(b.x)) <= 18;
  }

  function samePileRow(a, b) {
    return Math.abs(Number(a.y) - Number(b.y)) <= 18;
  }

  function buildRedOcrCanvas(sourceImageData, box) {
    const padding = 12;
    const sourceWidth = box.x1 - box.x0 + 1 + padding * 2;
    const sourceHeight = box.y1 - box.y0 + 1 + padding * 2;
    const width = sourceWidth * OCR_MASK_SCALE;
    const height = sourceHeight * OCR_MASK_SCALE;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const output = context.createImageData(width, height);
    output.data.fill(255);

    for (let y = 0; y < sourceHeight; y += 1) {
      for (let x = 0; x < sourceWidth; x += 1) {
        const sourceX = box.x0 + x - padding;
        const sourceY = box.y0 + y - padding;

        if (sourceX < 0 || sourceY < 0 || sourceX >= sourceImageData.width || sourceY >= sourceImageData.height) {
          continue;
        }

        const sourceOffset = (sourceY * sourceImageData.width + sourceX) * 4;
        if (isRedPixel(sourceImageData.data[sourceOffset], sourceImageData.data[sourceOffset + 1], sourceImageData.data[sourceOffset + 2], sourceImageData.data[sourceOffset + 3])) {
          paintScaledMaskPixel(output.data, width, x, y);
        }
      }
    }

    context.putImageData(output, 0, 0);
    return { canvas, padding, scale: OCR_MASK_SCALE };
  }

  function paintScaledMaskPixel(data, width, sourceX, sourceY) {
    const scaledX = sourceX * OCR_MASK_SCALE;
    const scaledY = sourceY * OCR_MASK_SCALE;
    for (let y = scaledY; y < scaledY + OCR_MASK_SCALE; y += 1) {
      for (let x = scaledX; x < scaledX + OCR_MASK_SCALE; x += 1) {
        const offset = (y * width + x) * 4;
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
        data[offset + 3] = 255;
      }
    }
  }

  function ocrWordToPile(word, mask, plan) {
    const text = cleanText(word.text).replace(/\D/g, "");
    if (!text) {
      return null;
    }
    const bbox = word.bbox || {};
    const centerX = plan.box.x0 + (((bbox.x0 || 0) + (bbox.x1 || 0)) / 2) / mask.scale - mask.padding;
    const centerY = plan.box.y0 + (((bbox.y0 || 0) + (bbox.y1 || 0)) / 2) / mask.scale - mask.padding;

    return normalizePile({
      number: String(Number(text)),
      grid: nearestGrid({ x: centerX, top: centerY }, plan.gridModel),
      source: "red-ocr",
      x: centerX,
      y: centerY,
      coordinateScale: OCR_MASK_SCALE
    });
  }

  function isRedPixel(r, g, b, a) {
    return a > 40 && r > 125 && r - g > 35 && r - b > 35 && r > g * 1.18 && r > b * 1.18;
  }

  function isGridLinePixel(r, g, b, a) {
    if (a <= 40 || isRedPixel(r, g, b, a)) {
      return false;
    }
    const brightness = (r + g + b) / 3;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    return brightness < 185 && spread < 85;
  }

  function expandBox(box, xMargin, yMargin, width, height) {
    return {
      x0: Math.max(0, Math.round(box.x0 - xMargin)),
      y0: Math.max(0, Math.round(box.y0 - yMargin)),
      x1: Math.min(width - 1, Math.round(box.x1 + xMargin)),
      y1: Math.min(height - 1, Math.round(box.y1 + yMargin))
    };
  }

  async function scanActiveDrawing() {
    const drawing = getActiveDrawing();
    if (!drawing) {
      showMessage("Upload a PDF first.", true);
      return;
    }

    showMessage("Scanning red pile numbers and X/Y grid lines...");
    try {
      const bytes = await readPdfBytes(drawing.id);
      if (!bytes) {
        showMessage("Original PDF is not stored on this device. Re-upload it before scanning.", true);
        return;
      }

      const extracted = await extractPdfInfo(bytes.slice(0), drawing.fileName);
      drawing.projectTitle = extracted.projectTitle || drawing.projectTitle;
      drawing.drawingTitle = extracted.drawingTitle || drawing.drawingTitle;
      drawing.gridLetters = extracted.gridLetters.length ? extracted.gridLetters : drawing.gridLetters;
      drawing.gridNumbers = extracted.gridNumbers.length ? extracted.gridNumbers : drawing.gridNumbers;
      drawing.piles = uniquePiles([...extracted.piles, ...drawing.piles]).sort(sortPiles);
      drawing.extractionNote = extracted.extractionNote || "";
      drawing.updatedAt = Date.now();
      persist();
      render();
      showMessage(`${extracted.piles.length} pile number${extracted.piles.length === 1 ? "" : "s"} found from the red drawing labels.`);
    } catch (error) {
      showMessage("Red number scan failed. Try re-uploading a clearer PDF.", true);
    }
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
    if (getLatestRecord(drawing.id, pile.number)) {
      showMessage("This pile is already recorded. Clear its record before entering it again.", true);
      renderPileSelect();
      renderHistory();
      return;
    }

    const selectedGrid = composeGrid(els.gridXSelect.value, els.gridYSelect.value);
    const grid = selectedGrid || pile.grid || "";
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
    els.gridXSelect.value = "";
    els.gridYSelect.value = "";
    renderGridSelects();
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
      if (getLatestRecord(drawing.id, pile.number)) {
        showMessage("This pile is already recorded. Clear its record before entering it again.", true);
        return;
      }
      const grid = splitGrid(pile.grid);
      els.gridXSelect.value = grid.x;
      els.gridYSelect.value = grid.y;
      renderGridSelects();
      renderPileSelect();
      els.pileSelect.value = pile.number;
      renderHistory();
      window.scrollTo({ top: document.querySelector(".entry-panel").offsetTop - 12, behavior: "smooth" });
    }

    if (button.dataset.action === "clear-records") {
      const records = getPileRecords(drawing.id, pile.number);
      if (!records.length) {
        showMessage("No record to clear.", true);
        return;
      }
      const ok = window.confirm(`Clear ${pile.number} record${records.length === 1 ? "" : "s"} and return it to Daily input?`);
      if (!ok) {
        return;
      }
      state.records = state.records.filter((record) => !(record.drawingId === drawing.id && record.pileNumber === pile.number));
      persist();
      render();
      showMessage(`${pile.number} returned to Daily input.`);
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
    let entryXCurrent = els.gridXSelect.value;
    let entryYCurrent = els.gridYSelect.value;
    const rangeCurrent = els.rangeGrid.value;
    const gridHtml = gridOptions.map((grid) => `<option value="${escapeAttr(grid)}">${escapeHtml(grid)}</option>`).join("");

    let xOptions = drawing ? getEntryGridAxisOptions(drawing, "x", { y: entryYCurrent }) : [];
    if (entryXCurrent && !xOptions.includes(entryXCurrent)) {
      entryXCurrent = "";
    }
    let yOptions = drawing ? getEntryGridAxisOptions(drawing, "y", { x: entryXCurrent }) : [];
    if (entryYCurrent && !yOptions.includes(entryYCurrent)) {
      entryYCurrent = "";
    }
    xOptions = drawing ? getEntryGridAxisOptions(drawing, "x", { y: entryYCurrent }) : [];
    yOptions = drawing ? getEntryGridAxisOptions(drawing, "y", { x: entryXCurrent }) : [];

    els.gridXSelect.innerHTML = `<option value="">All X-axis</option>${xOptions.map((value) => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`).join("")}`;
    els.gridYSelect.innerHTML = `<option value="">All Y-axis</option>${yOptions.map((value) => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`).join("")}`;
    els.rangeGrid.innerHTML = `<option value="">Unassigned</option>${gridHtml}`;

    els.gridXSelect.value = xOptions.includes(entryXCurrent) ? entryXCurrent : "";
    els.gridYSelect.value = yOptions.includes(entryYCurrent) ? entryYCurrent : "";
    if (gridOptions.includes(rangeCurrent) || rangeCurrent === "") {
      els.rangeGrid.value = rangeCurrent;
    }
  }

  function renderPileSelect() {
    const drawing = getActiveDrawing();
    const current = els.pileSelect.value;
    const gridX = els.gridXSelect.value;
    const gridY = els.gridYSelect.value;
    const piles = drawing
      ? getPendingPiles(drawing)
          .filter((pile) => pileMatchesEntryGrid(pile, gridX, gridY))
          .sort(sortPiles)
      : [];
    els.pileSelect.innerHTML = piles.length
      ? piles.map((pile) => `<option value="${escapeAttr(pile.number)}">${escapeHtml(pile.number)}</option>`).join("")
      : `<option value="">No pending piles</option>`;
    if (piles.some((pile) => pile.number === current)) {
      els.pileSelect.value = current;
    } else if (piles.length) {
      els.pileSelect.value = piles[0].number;
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
          ${
            latest
              ? `<button class="secondary-button mini-button" type="button" data-action="clear-records" data-pile="${escapeAttr(pile.number)}">Clear record</button>`
              : `<button class="secondary-button mini-button" type="button" data-action="select" data-pile="${escapeAttr(pile.number)}">Select</button>`
          }
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
      els.scanDrawingButton,
      els.exportCsvButton,
      els.exportPdfButton,
      els.gridXSelect,
      els.gridYSelect,
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
      annotatePileRecordsOnOriginalPage(PDFLib, pages[0], font, drawing);
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

  function annotatePileRecordsOnOriginalPage(PDFLib, page, font, drawing) {
    if (!page) {
      return;
    }

    const geometry = pdfPageGeometry(page);
    const pileKeepouts = drawing.piles
      .map((pile) => pileDisplayPoint(pile, geometry))
      .filter(Boolean)
      .map(pileAnnotationKeepout);

    const annotated = drawing.piles
      .map((pile) => {
        const latest = getLatestRecord(drawing.id, pile.number);
        const point = pileDisplayPoint(pile, geometry);
        if (!latest || !point) {
          return null;
        }
        return {
          pile,
          latest,
          point,
          text: `${shortDate(latest.date)} ${formatDepthMeters(latest.penetrationDepth)}`
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.point.y - b.point.y || a.point.x - b.point.x);

    if (!annotated.length) {
      return;
    }

    const fontSize = annotationFontSize(annotated.length);
    const lineHeight = fontSize + 1.5;
    const occupied = [];
    const blue = PDFLib.rgb(0.03, 0.25, 0.9);
    const textRotation = PDFLib.degrees(displayTextRotation(geometry.rotation));

    annotated.forEach((item) => {
      const textWidth = Math.max(font.widthOfTextAtSize(item.text, fontSize), 18);
      const label = placeAnnotationLabel(item.point, textWidth, lineHeight, geometry.display, occupied, pileKeepouts);
      occupied.push(label.rect);

      drawDisplayArrowToPile(page, geometry, { x: label.anchorX, y: label.anchorY }, item.point, blue);
      page.drawCircle({
        ...displayToPdfPoint(item.point, geometry),
        size: Math.max(1.1, fontSize * 0.22),
        color: blue,
        opacity: 0.9
      });
      [
        [-0.65, 0],
        [0.65, 0],
        [0, -0.65],
        [0, 0.65]
      ].forEach(([offsetX, offsetY]) => {
        drawDisplayText(page, geometry, item.text, label.x + offsetX, label.y + offsetY, fontSize, font, PDFLib.rgb(1, 1, 1), 0.9, textRotation);
      });
      drawDisplayText(page, geometry, item.text, label.x, label.y, fontSize, font, blue, 0.96, textRotation);
    });
  }

  function drawDisplayArrowToPile(page, geometry, start, end, color) {
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    if (distance < 0.1) {
      return;
    }

    const unitX = (end.x - start.x) / distance;
    const unitY = (end.y - start.y) / distance;
    const arrowLength = 5.5;
    const arrowWidth = 3.2;
    const lineEnd = {
      x: end.x - unitX * 1.4,
      y: end.y - unitY * 1.4
    };
    const base = {
      x: end.x - unitX * arrowLength,
      y: end.y - unitY * arrowLength
    };
    const normal = { x: -unitY, y: unitX };
    const left = {
      x: base.x + normal.x * arrowWidth,
      y: base.y + normal.y * arrowWidth
    };
    const right = {
      x: base.x - normal.x * arrowWidth,
      y: base.y - normal.y * arrowWidth
    };

    drawDisplayLine(page, geometry, start, lineEnd, color, 0.48, 0.84);
    drawDisplayLine(page, geometry, left, end, color, 0.48, 0.9);
    drawDisplayLine(page, geometry, right, end, color, 0.48, 0.9);
  }

  function drawDisplayLine(page, geometry, start, end, color, thickness, opacity) {
    page.drawLine({
      start: displayToPdfPoint(start, geometry),
      end: displayToPdfPoint(end, geometry),
      thickness,
      color,
      opacity
    });
  }

  function drawDisplayText(page, geometry, text, x, y, size, font, color, opacity, rotate) {
    const point = displayToPdfPoint({ x, y }, geometry);
    page.drawText(text, {
      x: point.x,
      y: point.y,
      size,
      font,
      color,
      opacity,
      rotate
    });
  }

  function annotationFontSize(count) {
    if (count > 120) {
      return 4.8;
    }
    if (count > 60) {
      return 5.4;
    }
    if (count > 25) {
      return 6.2;
    }
    return 7;
  }

  function pdfPageGeometry(page) {
    const media = page.getSize();
    const rotation = normalizedPageRotation(page);
    return {
      media,
      rotation,
      display: displayedPageSize(media, rotation)
    };
  }

  function normalizedPageRotation(page) {
    const angle = Number(page.getRotation?.().angle) || 0;
    return ((angle % 360) + 360) % 360;
  }

  function displayedPageSize(media, rotation) {
    if (rotation === 90 || rotation === 270) {
      return { width: media.height, height: media.width };
    }
    return { width: media.width, height: media.height };
  }

  function pileDisplayPoint(pile, geometry) {
    const x = Number(pile.x);
    const y = Number(pile.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) {
      return null;
    }

    const scale = inferredPileCoordinateScale(pile, geometry.display);
    if (scale > 1.05 || /red-ocr|sequence-fill/.test(pile.source)) {
      return {
        x: clamp(x / scale, 4, geometry.display.width - 4),
        y: clamp(geometry.display.height - y / scale, 4, geometry.display.height - 4)
      };
    }

    return pdfToDisplayPoint(
      {
        x: clamp(x, 4, geometry.media.width - 4),
        y: clamp(y, 4, geometry.media.height - 4)
      },
      geometry
    );
  }

  function inferredPileCoordinateScale(pile, displaySize) {
    const stored = Number(pile.coordinateScale);
    if (Number.isFinite(stored) && stored > 0) {
      return stored;
    }

    if (/red-ocr|sequence-fill/.test(pile.source)) {
      return OCR_MASK_SCALE;
    }

    const x = Number(pile.x) || 0;
    const y = Number(pile.y) || 0;
    const xScale = x > displaySize.width ? x / displaySize.width : 1;
    const yScale = y > displaySize.height ? y / displaySize.height : 1;
    const scale = Math.max(xScale, yScale);
    return scale > 1.05 ? scale : 1;
  }

  function displayToPdfPoint(point, geometry) {
    switch (geometry.rotation) {
      case 90:
        return { x: geometry.media.width - point.y, y: point.x };
      case 180:
        return { x: geometry.media.width - point.x, y: geometry.media.height - point.y };
      case 270:
        return { x: point.y, y: geometry.media.height - point.x };
      default:
        return { x: point.x, y: point.y };
    }
  }

  function pdfToDisplayPoint(point, geometry) {
    switch (geometry.rotation) {
      case 90:
        return { x: point.y, y: geometry.media.width - point.x };
      case 180:
        return { x: geometry.media.width - point.x, y: geometry.media.height - point.y };
      case 270:
        return { x: geometry.media.height - point.y, y: point.x };
      default:
        return { x: point.x, y: point.y };
    }
  }

  function displayTextRotation(rotation) {
    return rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0;
  }

  function pileAnnotationKeepout(point) {
    return {
      x0: point.x - 34,
      y0: point.y - 22,
      x1: point.x + 34,
      y1: point.y + 22
    };
  }

  function placeAnnotationLabel(point, width, height, pageSize, occupied, keepouts = []) {
    const margin = 8;
    const candidates = annotationCandidates(point, width, height);
    let best = null;

    candidates.forEach((candidate) => {
      const rect = {
        x0: clamp(candidate.x, margin, pageSize.width - width - margin),
        y0: clamp(candidate.y, margin, pageSize.height - height - margin),
        x1: 0,
        y1: 0
      };
      rect.x1 = rect.x0 + width;
      rect.y1 = rect.y0 + height;
      const anchorX = clamp(rect.x0 + (point.x < rect.x0 ? 0 : width), rect.x0, rect.x1);
      const anchorY = clamp(rect.y0 + height * 0.45, rect.y0, rect.y1);
      const overlap = occupied.reduce((sum, item) => sum + rectOverlapArea(rect, item), 0);
      const keepoutOverlap = keepouts.reduce((sum, item) => sum + rectOverlapArea(rect, item), 0);
      const distance = Math.hypot(rect.x0 + width / 2 - point.x, rect.y0 + height / 2 - point.y);
      const score = overlap * 1000 + keepoutOverlap * 500 + distance + edgePenalty(rect, pageSize);
      if (!best || score < best.score) {
        best = { rect, x: rect.x0, y: rect.y0, anchorX, anchorY, score };
      }
    });

    return best;
  }

  function annotationCandidates(point, width, height) {
    const candidates = [];
    [28, 46, 70, 100, 138, 180].forEach((gap) => {
      candidates.push({ x: point.x + gap, y: point.y + gap * 0.25 });
      candidates.push({ x: point.x - width - gap, y: point.y + gap * 0.25 });
      candidates.push({ x: point.x + gap, y: point.y - height - gap * 0.25 });
      candidates.push({ x: point.x - width - gap, y: point.y - height - gap * 0.25 });
      candidates.push({ x: point.x - width / 2, y: point.y + gap });
      candidates.push({ x: point.x - width / 2, y: point.y - height - gap });
    });
    return candidates;
  }

  function rectOverlapArea(a, b) {
    const width = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    const height = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    return width * height;
  }

  function edgePenalty(rect, pageSize) {
    const margin = 16;
    let penalty = 0;
    if (rect.x0 < margin || rect.x1 > pageSize.width - margin) {
      penalty += 20;
    }
    if (rect.y0 < margin || rect.y1 > pageSize.height - margin) {
      penalty += 20;
    }
    return penalty;
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

  function getPendingPiles(drawing) {
    if (!drawing) {
      return [];
    }
    return drawing.piles.filter((pile) => !getLatestRecord(drawing.id, pile.number));
  }

  function getEntryGridAxisOptions(drawing, axis, filters = {}) {
    const values = getPendingPiles(drawing)
      .map((pile) => splitGrid(pile.grid))
      .filter((grid) => grid.x || grid.y)
      .filter((grid) => !filters.x || grid.x === filters.x)
      .filter((grid) => !filters.y || grid.y === filters.y)
      .map((grid) => (axis === "x" ? grid.x : grid.y));

    return uniqueStrings(values).sort(axis === "x" ? sortAxisLabel : sortAxisNumber);
  }

  function pileMatchesEntryGrid(pile, x, y) {
    const grid = splitGrid(pile.grid);
    return (!x || grid.x === x) && (!y || grid.y === y);
  }

  function splitGrid(grid) {
    const text = cleanText(grid);
    if (!text) {
      return { x: "", y: "" };
    }
    const parts = text.split("/");
    if (parts.length >= 2) {
      return {
        x: cleanText(parts[0]),
        y: cleanText(parts.slice(1).join("/"))
      };
    }
    return { x: text, y: "" };
  }

  function gridYNumber(grid) {
    const value = Number(splitGrid(grid).y);
    return Number.isFinite(value) ? value : NaN;
  }

  function composeGrid(x, y) {
    const gridX = cleanText(x);
    const gridY = cleanText(y);
    return gridX && gridY ? `${gridX}/${gridY}` : "";
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
      coordinateScale: Number(pile.coordinateScale) || 0,
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

  async function ensureTesseract() {
    if (window.Tesseract) {
      return window.Tesseract;
    }
    if (!tesseractPromise) {
      tesseractPromise = loadScript(TESSERACT_SCRIPT).then(() => window.Tesseract);
    }
    return tesseractPromise;
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
      navigator.serviceWorker.register("./sw.js?v=1.0.4").catch(() => {});
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

  function uniqueNumericValues(values) {
    return [...new Set(values.filter((value) => Number.isFinite(value)).map((value) => Math.round(value)))].sort((a, b) => a - b);
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

  function sortAxisLabel(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }

  function sortAxisNumber(a, b) {
    const aNumber = Number(a);
    const bNumber = Number(b);
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
      return aNumber - bNumber;
    }
    return sortAxisLabel(a, b);
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

  function shortDate(value) {
    const date = normalizeDate(value);
    if (!date) {
      return cleanText(value);
    }
    const [year, month, day] = date.split("-");
    return `${Number(day)}/${Number(month)}/${year.slice(-2)}`;
  }

  function formatDepthMeters(value) {
    const text = cleanText(value);
    if (!text) {
      return "";
    }
    const compact = text.replace(/\s+/g, "");
    return /m$/i.test(compact) ? compact.replace(/m$/i, "m") : `${compact}m`;
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

  function median(values) {
    if (!values.length) {
      return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
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
