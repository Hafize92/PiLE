(function () {
  "use strict";

  const STORAGE_KEY = "pile:piling-records:v1";
  const LEGACY_STORAGE_KEY = "hafize:piling-records:v1";
  const PROFILE_KEY = "pile:profile:v1";
  const LEGACY_PROFILE_KEY = "hafize:profile:v1";
  const DEVICE_KEY = "pile:device-id:v1";
  const currentDeviceId = getDeviceId();

  const els = {
    form: document.querySelector("#recordForm"),
    projectName: document.querySelector("#projectName"),
    blockName: document.querySelector("#blockName"),
    username: document.querySelector("#username"),
    recordDate: document.querySelector("#recordDate"),
    pilingPointNumber: document.querySelector("#pilingPointNumber"),
    length3m: document.querySelector("#length3m"),
    length6m: document.querySelector("#length6m"),
    length9m: document.querySelector("#length9m"),
    length12m: document.querySelector("#length12m"),
    meterPreview: document.querySelector("#meterPreview"),
    weldingPreview: document.querySelector("#weldingPreview"),
    formMessage: document.querySelector("#formMessage"),
    saveButton: document.querySelector("#saveButton"),
    resetButton: document.querySelector("#resetButton"),
    exportButton: document.querySelector("#exportButton"),
    searchInput: document.querySelector("#searchInput"),
    projectFilter: document.querySelector("#projectFilter"),
    reportDate: document.querySelector("#reportDate"),
    reportSite: document.querySelector("#reportSite"),
    reportFormat: document.querySelector("#reportFormat"),
    reportButton: document.querySelector("#reportButton"),
    recordList: document.querySelector("#recordList"),
    emptyState: document.querySelector("#emptyState"),
    syncStatus: document.querySelector("#syncStatus")
  };

  const state = {
    records: loadRecords(),
    editingId: "",
    channel: null
  };

  init();

  function init() {
    hydrateProfile();
    setupBroadcastChannel();
    setSyncStatus("local", "Local");
    els.recordDate.value = todayInputValue();

    els.form.addEventListener("submit", handleSubmit);
    els.resetButton.addEventListener("click", resetForm);
    els.exportButton.addEventListener("click", exportCsv);
    els.reportButton.addEventListener("click", exportDailyReport);
    els.searchInput.addEventListener("input", render);
    els.projectFilter.addEventListener("change", render);
    els.pilingPointNumber.addEventListener("blur", formatPilingPointField);
    els.pilingPointNumber.addEventListener("change", formatPilingPointField);

    [els.length3m, els.length6m, els.length9m, els.length12m].forEach((input) => {
      input.addEventListener("input", updateMeterPreview);
    });

    [els.projectName, els.blockName, els.username].forEach((input) => {
      input.addEventListener("input", persistProfile);
    });

    updateMeterPreview();
    render();

    if ("serviceWorker" in navigator && /^https?:$/.test(window.location.protocol)) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    clearMessage();

    let record;
    const previousId = state.editingId;

    try {
      record = readFormRecord();
    } catch (error) {
      showMessage(error.message, true);
      return;
    }

    const existing = state.records.find((item) => item.id === record.id);
    const previousRecord = previousId ? state.records.find((item) => item.id === previousId) : null;
    if (previousRecord && previousId !== record.id && !canDeleteRecord(previousRecord)) {
      showMessage("Only this PC can change the point or date for this record.", true);
      return;
    }

    if (existing && previousId !== record.id) {
      const ok = window.confirm("This point and date already exists. Update it?");
      if (!ok) {
        return;
      }
    }

    upsertLocalRecord(record, previousId);
    persistProfile();
    notifyPeers();
    resetForm({ keepContext: true });
    showMessage("Record saved locally.");
  }

  function readFormRecord() {
    const projectName = cleanText(els.projectName.value);
    const blockName = cleanText(els.blockName.value);
    const username = cleanText(els.username.value);
    const date = normalizeDateInput(els.recordDate.value);
    const pilingPointNumber = formatPilingPoint(els.pilingPointNumber.value);

    if (!projectName) {
      throw new Error("Project Name is required.");
    }
    if (!blockName) {
      throw new Error("Block Name is required.");
    }
    if (!username) {
      throw new Error("Supervisor is required.");
    }
    if (!date) {
      throw new Error("Date must be day.month.year.");
    }
    if (!pilingPointNumber) {
      throw new Error("Piling Point Numbers must be a number.");
    }
    els.pilingPointNumber.value = pilingPointNumber;

    const lengths = {
      length3m: intValue(els.length3m.value),
      length6m: intValue(els.length6m.value),
      length9m: intValue(els.length9m.value),
      length12m: intValue(els.length12m.value)
    };

    const totalPieces = lengths.length3m + lengths.length6m + lengths.length9m + lengths.length12m;
    const totalMeters =
      lengths.length3m * 3 + lengths.length6m * 6 + lengths.length9m * 9 + lengths.length12m * 12;
    const totalWelding = weldingCount(totalPieces);

    if (totalPieces <= 0) {
      throw new Error("Enter at least one piling length count.");
    }

    const id = recordId(projectName, blockName, pilingPointNumber, date);
    const current = state.records.find((item) => item.id === id);
    const editing = state.records.find((item) => item.id === state.editingId);

    return {
      id,
      projectName,
      blockName,
      username,
      pilingPointNumber,
      date,
      ...lengths,
      totalPieces,
      totalMeters,
      totalWelding,
      ownerDeviceId: current?.ownerDeviceId || editing?.ownerDeviceId || currentDeviceId,
      ownerUid: current?.ownerUid || editing?.ownerUid || "",
      createdAt: current?.createdAt || editing?.createdAt || Date.now(),
      updatedAt: Date.now()
    };
  }

  function upsertLocalRecord(record, previousId) {
    const nextRecords = state.records.filter((item) => item.id !== record.id && item.id !== previousId);
    state.records = [record, ...nextRecords];
    persistRecords();
    render();
  }

  function editRecord(recordIdValue) {
    const record = state.records.find((item) => item.id === recordIdValue);
    if (!record) {
      return;
    }
    if (!canDeleteRecord(record)) {
      showMessage("Only this device can edit this record.", true);
      return;
    }

    state.editingId = record.id;
    els.projectName.value = record.projectName;
    els.blockName.value = record.blockName;
    els.username.value = record.username;
    els.recordDate.value = dateInputValue(record.date);
    els.pilingPointNumber.value = record.pilingPointNumber;
    els.length3m.value = record.length3m;
    els.length6m.value = record.length6m;
    els.length9m.value = record.length9m;
    els.length12m.value = record.length12m;
    els.saveButton.querySelector("span:last-child").textContent = "Update record";
    updateMeterPreview();
    clearMessage();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function deleteRecord(recordIdValue) {
    const record = state.records.find((item) => item.id === recordIdValue);
    if (!record) {
      return;
    }
    if (!canDeleteRecord(record)) {
      showMessage("Only this PC can delete this record.", true);
      return;
    }

    const ok = window.confirm(`Delete ${record.pilingPointNumber} for ${record.blockName}?`);
    if (!ok) {
      return;
    }

    state.records = state.records.filter((item) => item.id !== recordIdValue);
    persistRecords();
    notifyPeers();
    render();

    if (state.editingId === recordIdValue) {
      resetForm({ keepContext: true });
    }

    showMessage("Record deleted locally.");
  }

  function resetForm(options = {}) {
    const profile = readProfile();
    state.editingId = "";
    els.pilingPointNumber.value = "";
    els.length3m.value = "0";
    els.length6m.value = "0";
    els.length9m.value = "0";
    els.length12m.value = "0";
    els.recordDate.value = todayInputValue();

    if (!options.keepContext) {
      els.projectName.value = profile.projectName || "";
      els.blockName.value = profile.blockName || "";
      els.username.value = profile.username || "";
    }

    els.saveButton.querySelector("span:last-child").textContent = "Save record";
    updateMeterPreview();
    clearMessage();
  }

  function render() {
    const filteredRecords = getFilteredRecords();
    renderProjectFilter();
    renderReportFilters();
    renderRecords(filteredRecords);
  }

  function renderProjectFilter() {
    const currentValue = els.projectFilter.value;
    const projects = Array.from(new Set(state.records.map((record) => record.projectName))).sort();
    els.projectFilter.innerHTML = `<option value="">All projects</option>${projects
      .map((project) => `<option value="${escapeAttr(project)}">${escapeHtml(project)}</option>`)
      .join("")}`;
    if (projects.includes(currentValue)) {
      els.projectFilter.value = currentValue;
    }
  }

  function renderReportFilters() {
    const currentDate = els.reportDate.value;
    const currentSite = els.reportSite.value;
    const dates = Array.from(new Set(state.records.map((record) => record.date))).sort((a, b) =>
      dateKey(b).localeCompare(dateKey(a))
    );
    const sites = Array.from(new Set(state.records.map((record) => record.projectName))).sort();

    els.reportDate.innerHTML = dates.length
      ? dates.map((date) => `<option value="${escapeAttr(date)}">${escapeHtml(date)}</option>`).join("")
      : `<option value="">No dates</option>`;
    els.reportSite.innerHTML = `<option value="">All sites</option>${sites
      .map((site) => `<option value="${escapeAttr(site)}">${escapeHtml(site)}</option>`)
      .join("")}`;

    if (dates.includes(currentDate)) {
      els.reportDate.value = currentDate;
    }
    if (sites.includes(currentSite)) {
      els.reportSite.value = currentSite;
    }
  }

  function renderRecords(records) {
    els.emptyState.classList.toggle("show", records.length === 0);

    els.recordList.innerHTML = groupRecordsByDate(records)
      .map(
        (group) => `
          <section class="date-group" aria-label="${escapeAttr(group.date)}">
            <h3 class="date-heading">${escapeHtml(group.date)}</h3>
            <ul class="record-items">
              ${group.records.map(renderRecordRow).join("")}
            </ul>
          </section>
        `
      )
      .join("");

    els.recordList.querySelectorAll("button[data-action]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.action === "edit") {
          editRecord(button.dataset.id);
        } else {
          deleteRecord(button.dataset.id);
        }
      });
    });
  }

  function renderRecordRow(record) {
    const editButton = canDeleteRecord(record)
      ? `<button class="secondary-button" type="button" data-action="edit" data-id="${escapeAttr(record.id)}">Edit</button>`
      : "";
    const deleteButton = canDeleteRecord(record)
      ? `<button class="danger-button" type="button" data-action="delete" data-id="${escapeAttr(record.id)}">Delete</button>`
      : "";
    const lengthHtml = lengthParts(record)
      .map((part) => `<span class="length-chip">${escapeHtml(part)}</span>`)
      .join("");

    return `
      <li class="record-row">
        <div class="record-title">
          <h4><span class="point-chip">${escapeHtml(record.pilingPointNumber)}</span></h4>
          <div class="record-subtitle">${escapeHtml(record.projectName)} / ${escapeHtml(record.blockName)} / ${escapeHtml(record.username)}</div>
        </div>
        <div class="record-facts" aria-label="Record details">
          <div class="record-lengths">${lengthHtml}</div>
          <div class="record-measures">
            <span class="welding-chip">${record.totalWelding} welding</span>
            <span class="meter-chip">${record.totalMeters}m length</span>
          </div>
        </div>
        <div class="record-actions">
          ${editButton}
          ${deleteButton}
        </div>
      </li>
    `;
  }

  function groupRecordsByDate(records) {
    return records.reduce((groups, record) => {
      const currentGroup = groups[groups.length - 1];
      if (currentGroup && currentGroup.date === record.date) {
        currentGroup.records.push(record);
        return groups;
      }

      groups.push({ date: record.date, records: [record] });
      return groups;
    }, []);
  }

  function lengthParts(record) {
    return [
      [3, record.length3m],
      [6, record.length6m],
      [9, record.length9m],
      [12, record.length12m]
    ]
      .filter(([, count]) => count > 0)
      .map(([length, count]) => `${length}m - ${count} nos`);
  }

  function recordLengthText(record) {
    const parts = lengthParts(record);
    return parts.length ? parts.join(", ") : "";
  }

  function getFilteredRecords() {
    const search = cleanText(els.searchInput.value).toLowerCase();
    const project = els.projectFilter.value;

    return state.records
      .filter((record) => {
        if (project && record.projectName !== project) {
          return false;
        }

        if (!search) {
          return true;
        }

        const haystack = [
          record.projectName,
          record.blockName,
          record.username,
          record.pilingPointNumber,
          record.date
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(search);
      })
      .sort(sortRecords);
  }

  function exportCsv() {
    const records = getFilteredRecords();
    if (!records.length) {
      showMessage("No records to export.", true);
      return;
    }

    const headers = [
      "Project Name",
      "Block Name",
      "Supervisor",
      "Piling Point Numbers",
      "Date",
      "3m",
      "6m",
      "9m",
      "12m",
      "Total Pieces",
      "Total Meters",
      "No. of Welding"
    ];

    const rows = records.map((record) => [
      record.projectName,
      record.blockName,
      record.username,
      record.pilingPointNumber,
      record.date,
      record.length3m,
      record.length6m,
      record.length9m,
      record.length12m,
      record.totalPieces,
      record.totalMeters,
      record.totalWelding
    ]);

    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pile-piling-records-${dateKey(todayValue())}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showMessage("CSV exported.");
  }

  function exportDailyReport() {
    const date = els.reportDate.value;
    const site = els.reportSite.value;
    const format = els.reportFormat.value;

    if (!date) {
      showMessage("Choose a report date.", true);
      return;
    }

    const records = state.records
      .filter((record) => record.date === date && (!site || record.projectName === site))
      .sort((a, b) => {
        if (a.projectName !== b.projectName) {
          return a.projectName.localeCompare(b.projectName);
        }
        if (a.blockName !== b.blockName) {
          return a.blockName.localeCompare(b.blockName);
        }
        return a.pilingPointNumber.localeCompare(b.pilingPointNumber, undefined, { numeric: true });
      });

    if (!records.length) {
      showMessage("No daily records for this selection.", true);
      return;
    }

    const html = buildDailyReportHtml(date, site, records);
    if (format === "word") {
      downloadWordReport(html, date, site);
      showMessage("Word report exported.");
      return;
    }

    openPdfReport(html);
  }

  function buildDailyReportHtml(date, site, records) {
    const groupedSites = groupRecordsBySite(records);
    const siteLabel = site || "All sites";

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Daily Piling Report</title>
    <style>${reportCss()}</style>
  </head>
  <body>
    <header>
      <h1>Daily Piling Report</h1>
      <p>Date: ${escapeHtml(date)} | Site: ${escapeHtml(siteLabel)}</p>
    </header>
    ${groupedSites.map(renderReportSite).join("")}
  </body>
</html>`;
  }

  function renderReportSite(group) {
    return `
    <section class="site">
      <h2>${escapeHtml(group.site)}</h2>
      <table>
        <thead>
          <tr>
            <th>No.</th>
            <th>Piling No.</th>
            <th>Block</th>
            <th>Length</th>
            <th>Welding</th>
            <th>Meters</th>
            <th>Supervisor</th>
          </tr>
        </thead>
        <tbody>
          ${group.records
            .map(
              (record, index) => `
          <tr>
            <td>${index + 1}</td>
            <td><b>${escapeHtml(record.pilingPointNumber)}</b></td>
            <td>${escapeHtml(record.blockName)}</td>
            <td>${escapeHtml(recordLengthText(record))}</td>
            <td>${record.totalWelding}</td>
            <td>${record.totalMeters}</td>
            <td>${escapeHtml(record.username)}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </section>`;
  }

  function groupRecordsBySite(records) {
    const groups = [];
    records.forEach((record) => {
      const current = groups.find((group) => group.site === record.projectName);
      if (current) {
        current.records.push(record);
      } else {
        groups.push({ site: record.projectName, records: [record] });
      }
    });
    return groups;
  }

  function openPdfReport(html) {
    const reportWindow = window.open("", "_blank");
    if (!reportWindow) {
      showMessage("Allow pop-ups to create the PDF report.", true);
      return;
    }

    reportWindow.document.open();
    reportWindow.document.write(html);
    reportWindow.document.close();
    reportWindow.focus();
    window.setTimeout(() => reportWindow.print(), 350);
    showMessage("PDF report opened. Choose Save as PDF.");
  }

  function downloadWordReport(html, date, site) {
    const blob = new Blob([html], { type: "application/msword;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pile-daily-report-${dateKey(date)}-${filenamePart(site || "all-sites")}.doc`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function reportCss() {
    return `
      body {
        color: #17211f;
        font-family: Arial, sans-serif;
        margin: 24px;
      }
      h1 {
        font-size: 22px;
        margin: 0 0 6px;
      }
      h2 {
        color: #0b5f59;
        font-size: 16px;
        margin: 18px 0 8px;
      }
      p {
        margin: 0 0 10px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      th,
      td {
        border: 1px solid #dbe3df;
        padding: 7px;
        text-align: left;
        vertical-align: top;
      }
      th {
        background: #eef4f2;
      }
    `;
  }

  function loadRecords() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      const legacy = stored ? "" : localStorage.getItem(LEGACY_STORAGE_KEY);
      const parsed = JSON.parse(stored || legacy || "[]");
      const records = Array.isArray(parsed)
        ? parsed.map((record) => normalizeLocalRecord(record, { assignCurrentDevice: true })).filter(Boolean)
        : [];
      if (!stored && legacy) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
      }
      return records;
    } catch (error) {
      return [];
    }
  }

  function persistRecords() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records));
  }

  function readProfile() {
    try {
      const stored = localStorage.getItem(PROFILE_KEY);
      const legacy = stored ? "" : localStorage.getItem(LEGACY_PROFILE_KEY);
      const profile = JSON.parse(stored || legacy || "{}") || {};
      if (!stored && legacy) {
        localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
      }
      return profile;
    } catch (error) {
      return {};
    }
  }

  function hydrateProfile() {
    const profile = readProfile();
    els.projectName.value = profile.projectName || "";
    els.blockName.value = profile.blockName || "";
    els.username.value = profile.username || "";
  }

  function persistProfile() {
    localStorage.setItem(
      PROFILE_KEY,
      JSON.stringify({
        projectName: cleanText(els.projectName.value),
        blockName: cleanText(els.blockName.value),
        username: cleanText(els.username.value)
      })
    );
  }

  function setupBroadcastChannel() {
    if (!("BroadcastChannel" in window)) {
      return;
    }

    state.channel = new BroadcastChannel("pile-records");
    state.channel.addEventListener("message", (event) => {
      if (!event.data || event.data.type !== "records-updated") {
        return;
      }
      state.records = loadRecords();
      render();
    });
  }

  function notifyPeers() {
    if (state.channel) {
      state.channel.postMessage({ type: "records-updated" });
    }
  }

  function updateMeterPreview() {
    const totalPieces =
      intValue(els.length3m.value) +
      intValue(els.length6m.value) +
      intValue(els.length9m.value) +
      intValue(els.length12m.value);
    const totalMeters =
      intValue(els.length3m.value) * 3 +
      intValue(els.length6m.value) * 6 +
      intValue(els.length9m.value) * 9 +
      intValue(els.length12m.value) * 12;
    els.meterPreview.textContent = `${totalMeters} m`;
    els.weldingPreview.textContent = `${weldingCount(totalPieces)} welding`;
  }

  function setSyncStatus(stateName, label) {
    els.syncStatus.dataset.state = stateName;
    els.syncStatus.querySelector("span:last-child").textContent = label;
  }

  function showMessage(message, isError) {
    els.formMessage.textContent = message;
    els.formMessage.classList.toggle("error", Boolean(isError));
  }

  function clearMessage() {
    showMessage("", false);
  }

  function normalizeLocalRecord(record, options = {}) {
    if (!record || !record.id) {
      return null;
    }

    const length3m = intValue(record.length3m);
    const length6m = intValue(record.length6m);
    const length9m = intValue(record.length9m);
    const length12m = intValue(record.length12m);
    const totalPieces = length3m + length6m + length9m + length12m;
    const totalMeters = length3m * 3 + length6m * 6 + length9m * 9 + length12m * 12;
    const date = normalizeDateInput(record.date) || todayValue();
    const ownerDeviceId = cleanText(record.ownerDeviceId) || (options.assignCurrentDevice ? currentDeviceId : "");

    return {
      id: String(record.id),
      projectName: cleanText(record.projectName),
      blockName: cleanText(record.blockName),
      username: cleanText(record.username),
      pilingPointNumber: formatPilingPoint(record.pilingPointNumber) || cleanText(record.pilingPointNumber).toUpperCase(),
      date,
      length3m,
      length6m,
      length9m,
      length12m,
      totalPieces,
      totalMeters,
      totalWelding: weldingCount(totalPieces),
      ownerDeviceId,
      ownerUid: cleanText(record.ownerUid),
      createdAt: Number(record.createdAt) || Date.now(),
      updatedAt: Number(record.updatedAt) || Number(record.localUpdatedAt) || Date.now()
    };
  }

  function sortRecords(a, b) {
    const aDate = dateKey(a.date);
    const bDate = dateKey(b.date);
    if (aDate !== bDate) {
      return bDate.localeCompare(aDate);
    }
    if (a.projectName !== b.projectName) {
      return a.projectName.localeCompare(b.projectName);
    }
    if (a.blockName !== b.blockName) {
      return a.blockName.localeCompare(b.blockName);
    }
    return a.pilingPointNumber.localeCompare(b.pilingPointNumber, undefined, { numeric: true });
  }

  function recordId(projectName, blockName, pilingPointNumber, date) {
    return [projectName, blockName, pilingPointNumber, date].map(slug).join("__");
  }

  function slug(value) {
    const text = cleanText(value).toLowerCase();
    const asciiSlug = text
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

    if (asciiSlug) {
      return asciiSlug;
    }

    const encoded = Array.from(text)
      .map((char) => char.codePointAt(0).toString(36))
      .join("-");
    return `x-${encoded}`.slice(0, 80);
  }

  function intValue(value) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number) || number < 0) {
      return 0;
    }
    return number;
  }

  function weldingCount(totalPieces) {
    return Math.max(intValue(totalPieces) - 1, 0);
  }

  function canDeleteRecord(record) {
    return !record.ownerDeviceId || record.ownerDeviceId === currentDeviceId;
  }

  function formatPilingPointField() {
    const formatted = formatPilingPoint(els.pilingPointNumber.value);
    if (formatted) {
      els.pilingPointNumber.value = formatted;
    }
  }

  function formatPilingPoint(value) {
    const text = cleanText(value).toUpperCase();
    const match = text.match(/^(?:P\s*-?\s*)?(\d{1,})$/);
    if (!match) {
      return "";
    }
    return `P-${match[1].padStart(3, "0")}`;
  }

  function cleanText(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
  }

  function todayValue() {
    const date = new Date();
    return `${twoDigit(date.getDate())}.${twoDigit(date.getMonth() + 1)}.${date.getFullYear()}`;
  }

  function todayInputValue() {
    return dateInputValue(todayValue());
  }

  function dateInputValue(value) {
    const date = normalizeDateInput(value);
    if (!date) {
      return "";
    }
    const [day, month, year] = date.split(".");
    return `${year}-${month}-${day}`;
  }

  function normalizeDateInput(value) {
    const text = cleanText(value);
    let day;
    let month;
    let year;

    const displayMatch = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);

    if (displayMatch) {
      day = Number(displayMatch[1]);
      month = Number(displayMatch[2]);
      year = Number(displayMatch[3]);
    } else if (isoMatch) {
      year = Number(isoMatch[1]);
      month = Number(isoMatch[2]);
      day = Number(isoMatch[3]);
    } else {
      return "";
    }

    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return "";
    }

    return `${twoDigit(day)}.${twoDigit(month)}.${year}`;
  }

  function dateKey(value) {
    const date = normalizeDateInput(value);
    if (!date) {
      return "";
    }
    const [day, month, year] = date.split(".");
    return `${year}-${month}-${day}`;
  }

  function twoDigit(value) {
    return String(value).padStart(2, "0");
  }

  function getDeviceId() {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored) {
      return stored;
    }

    const generated =
      window.crypto && typeof window.crypto.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_KEY, generated);
    return generated;
  }

  function filenamePart(value) {
    return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "report";
  }

  function csvCell(value) {
    const text = String(value ?? "");
    if (/[",\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
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
