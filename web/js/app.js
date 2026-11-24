// UI for WhatsApp Candidate Outreach. All data stays in the browser:
// the uploaded file is parsed locally and progress is kept in localStorage.
import * as O from "./outreach.js";

const PAGE_STEP = 50;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ["csv", "xlsx", "xls"];
const STORAGE_KEYS = Object.freeze({
  progress: "outreach.progress.v1",
  template: "outreach.template.v1",
  openIn: "outreach.openIn.v1",
});
const OPEN_IN = Object.freeze({
  app: { format: O.WHATSAPP_APP_URL, newTab: false },
  web: { format: O.WHATSAPP_WEB_URL, newTab: true },
});

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ storage

const storage = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

function loadProgress() {
  const saved = storage.read(STORAGE_KEYS.progress, {});
  return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
}

// ------------------------------------------------------------ state

let state = Object.freeze({
  fileName: "",
  columns: [],
  rows: [],
  nameCol: "",
  phoneCol: "",
  prepared: null,
  template: storage.read(STORAGE_KEYS.template, O.DEFAULT_TEMPLATE),
  openIn: storage.read(STORAGE_KEYS.openIn, "app") === "web" ? "web" : "app",
  progress: loadProgress(),
  search: "",
  status: "All",
  visible: PAGE_STEP,
  notices: [],
});

function setState(changes) {
  state = Object.freeze({ ...state, ...changes });
}

function setProgress(progress) {
  setState({ progress });
  if (!storage.write(STORAGE_KEYS.progress, progress)) {
    showNotice("err", "Could not save progress in this browser (private mode or storage full). Export the CSV to keep it.");
  }
}

// ------------------------------------------------------------ file reading

function fileExtension(name) {
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
}

function decodeCsv(buffer) {
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  const text = utf8.includes("�") ? new TextDecoder("windows-1252").decode(buffer) : utf8;
  return text.replace(/^﻿/, "");
}

async function readTable(file) {
  const ext = fileExtension(file.name);
  if (!ALLOWED_EXTENSIONS.includes(ext)) throw new Error("Please choose a .csv, .xlsx or .xls file.");
  if (file.size > MAX_FILE_BYTES) throw new Error("The file is larger than 10 MB.");
  if (typeof XLSX === "undefined") throw new Error("The spreadsheet reader did not load. Reload the page.");
  const buffer = await file.arrayBuffer();
  const workbook = ext === "csv"
    ? XLSX.read(decodeCsv(buffer), { type: "string", raw: true })
    : XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  // raw:true keeps 12-digit numbers like 923001234567 out of scientific notation.
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
  return O.tableFromMatrix(matrix);
}

async function handleFile(file) {
  if (!file) return;
  setState({ notices: [] });
  let table;
  try {
    table = await readTable(file);
  } catch (error) {
    showNotice("err", `Could not read the file: ${error instanceof Error ? error.message : error}`);
    return;
  }
  if (table.rows.length === 0) {
    showNotice("err", "The file has no rows.");
    return;
  }
  const nameCol = table.columns[O.guessNameColumn(table.columns)];
  const phoneCol = table.columns[O.guessPhoneColumn(table.columns)];
  setState({ fileName: file.name, ...table, nameCol, phoneCol, search: "", status: "All", visible: PAGE_STEP });
  $("search").value = "";
  prepare();
  restoreFromExport();
  renderAll();
}

function prepare() {
  setState({ prepared: O.prepareCandidates(state.rows, state.nameCol, state.phoneCol), visible: PAGE_STEP });
}

function restoreFromExport() {
  const restored = O.progressFromExport(state.rows, state.columns, state.prepared, state.nameCol);
  const count = Object.keys(restored).length;
  if (count === 0) return;
  setProgress({ ...state.progress, ...restored });
  showNotice("ok", `Restored status and notes for ${count} candidate(s) from this file.`);
}

// ------------------------------------------------------------ notices

function showNotice(kind, text, details = null) {
  setState({ notices: [...state.notices, { kind, text, details }] });
  renderNotices();
}

function fileNotices() {
  const { invalidRows, duplicates } = state.prepared;
  const notices = [];
  if (invalidRows.length) {
    notices.push({
      kind: "warn",
      text: `Skipped ${invalidRows.length} row(s) with an empty or invalid phone number.`,
      details: { summary: "Show skipped rows", head: ["Row", "Name", "Phone (as in file)"],
        rows: invalidRows.map((r) => [r.row, r.name, r.raw]) },
    });
  }
  if (duplicates.length) {
    const hidden = duplicates.reduce((sum, d) => sum + d.count, 0) - duplicates.length;
    notices.push({
      kind: "warn",
      text: `${duplicates.length} phone number(s) appear more than once. Only the first row of each is listed (${hidden} duplicate row(s) hidden).`,
      details: { summary: "Show duplicates", head: ["Phone", "Count", "Names"],
        rows: duplicates.map((d) => [`+${d.phone}`, d.count, d.names]) },
    });
  }
  if (state.prepared.candidates.length === 0) {
    notices.push({ kind: "err", text: "No valid phone numbers found. Check that the right Phone column is selected." });
  }
  return notices;
}

function noticeElement({ kind, text, details }) {
  const box = document.createElement("div");
  box.className = `notice notice--${kind}`;
  box.append(text);
  if (details) {
    const more = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = details.summary;
    const table = document.createElement("table");
    const headRow = table.createTHead().insertRow();
    details.head.forEach((h) => { const th = document.createElement("th"); th.textContent = h; headRow.append(th); });
    const body = table.createTBody();
    details.rows.forEach((cells) => {
      const tr = body.insertRow();
      cells.forEach((c) => { tr.insertCell().textContent = String(c); });
    });
    more.append(summary, table);
    box.append(more);
  }
  return box;
}

function renderNotices() {
  const all = [...state.notices, ...(state.prepared ? fileNotices() : [])];
  $("notices").replaceChildren(...all.map(noticeElement));
}

// ------------------------------------------------------------ rendering

function fillSelect(select, columns, selected) {
  select.replaceChildren(...columns.map((c) => new Option(c, c, false, c === selected)));
}

function renderSetup() {
  const loaded = Boolean(state.prepared);
  $("file-label").textContent = loaded ? state.fileName : "Choose a CSV or Excel file";
  $("column-pickers").hidden = !loaded;
  if (loaded) {
    fillSelect($("name-col"), state.columns, state.nameCol);
    fillSelect($("phone-col"), state.columns, state.phoneCol);
  }
  document.querySelectorAll('input[name="open-in"]').forEach((r) => { r.checked = r.value === state.openIn; });
  renderPreview();
}

function renderPreview() {
  const first = state.prepared?.candidates[0];
  $("preview").hidden = !first;
  if (first) $("preview-text").textContent = O.buildMessage(state.template, first.name);
}

function renderStats() {
  const { candidates } = state.prepared;
  const total = candidates.length;
  const done = O.countContacted(candidates, state.progress);
  $("stat-total").textContent = String(total);
  $("stat-contacted").textContent = String(done);
  $("stat-pending").textContent = String(total - done);
  $("meter-fill").style.transform = `scaleX(${total ? done / total : 0})`;
}

function rowElement(candidate) {
  const { name, phone, otherPhones } = candidate;
  const li = $("row-template").content.firstElementChild.cloneNode(true);
  const contacted = O.isContacted(state.progress, phone);
  li.classList.toggle("is-done", contacted);
  li.querySelector(".row__name").textContent = name || "(no name)";
  li.querySelector(".row__phone").textContent = `+${phone}`;
  li.querySelector(".row__also").textContent = otherPhones ? `Also: ${otherPhones}` : "";

  const link = li.querySelector(".row__open");
  const target = OPEN_IN[state.openIn];
  if (contacted) {
    link.textContent = "Already contacted";
    link.setAttribute("aria-disabled", "true");
  } else {
    link.href = O.whatsappLink(phone, O.buildMessage(state.template, name), target.format);
    if (target.newTab) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
    link.setAttribute("aria-label", `Open WhatsApp chat with ${name || phone}`);
  }

  const check = li.querySelector(".row__check");
  check.checked = contacted;
  check.addEventListener("change", () => {
    setProgress(O.withContacted(state.progress, phone, name, check.checked));
    renderResults();
  });

  const note = li.querySelector(".row__note");
  note.value = O.noteOf(state.progress, phone);
  note.addEventListener("change", () => setProgress(O.withNote(state.progress, phone, name, note.value)));
  return li;
}

function renderList() {
  const filtered = O.filterCandidates(state.prepared.candidates, state.progress, state.search, state.status);
  const shown = filtered.slice(0, state.visible);
  $("list").replaceChildren(...shown.map(rowElement));
  $("showing").textContent = filtered.length
    ? `Showing ${shown.length} of ${filtered.length}`
    : "No candidates match the current filters.";
  $("load-more").hidden = filtered.length <= state.visible;
  document.querySelectorAll("#status-filter button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.status === state.status));
  });
}

function renderResults() {
  const hasCandidates = Boolean(state.prepared?.candidates.length);
  $("empty-state").hidden = Boolean(state.prepared);
  $("workspace").hidden = !hasCandidates;
  if (!hasCandidates) return;
  renderStats();
  renderList();
}

function renderAll() {
  renderSetup();
  renderNotices();
  renderResults();
}

// ------------------------------------------------------------ actions

function exportCsv() {
  const csv = O.buildExportCsv(state.rows, state.columns, state.prepared, state.progress);
  const stem = state.fileName.replace(/\.[^.]+$/, "") || "candidates";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${stem}_status.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resetProgress() {
  const ok = window.confirm(
    "Mark every candidate as Pending again and clear all notes?\nExport the CSV first if you want to keep them."
  );
  if (!ok) return;
  setProgress({});
  renderResults();
}

function updateTemplate(template) {
  setState({ template });
  storage.write(STORAGE_KEYS.template, template);
  renderPreview();
  if (state.prepared) renderList();
}

// ------------------------------------------------------------ wiring

function bindSetup() {
  $("file-input").addEventListener("change", (e) => handleFile(e.target.files[0]));
  const zone = $("dropzone");
  ["dragenter", "dragover"].forEach((t) => zone.addEventListener(t, (e) => {
    e.preventDefault();
    zone.classList.add("is-over");
  }));
  ["dragleave", "drop"].forEach((t) => zone.addEventListener(t, () => zone.classList.remove("is-over")));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    handleFile(e.dataTransfer.files[0]);
  });

  $("name-col").addEventListener("change", (e) => { setState({ nameCol: e.target.value }); prepare(); renderAll(); });
  $("phone-col").addEventListener("change", (e) => { setState({ phoneCol: e.target.value }); prepare(); renderAll(); });
  document.querySelectorAll('input[name="open-in"]').forEach((radio) => radio.addEventListener("change", () => {
    setState({ openIn: radio.value });
    storage.write(STORAGE_KEYS.openIn, radio.value);
    if (state.prepared) renderList();
  }));

  const template = $("template");
  template.value = state.template;
  template.addEventListener("input", () => updateTemplate(template.value));
  $("restore-template").addEventListener("click", () => {
    template.value = O.DEFAULT_TEMPLATE;
    updateTemplate(O.DEFAULT_TEMPLATE);
  });
}

function bindWorkspace() {
  $("search").addEventListener("input", (e) => { setState({ search: e.target.value, visible: PAGE_STEP }); renderList(); });
  $("status-filter").addEventListener("click", (e) => {
    const status = e.target.closest("button")?.dataset.status;
    if (!status) return;
    setState({ status, visible: PAGE_STEP });
    renderList();
  });
  $("load-more").addEventListener("click", () => { setState({ visible: state.visible + PAGE_STEP }); renderList(); });
  $("export").addEventListener("click", exportCsv);
  $("reset").addEventListener("click", resetProgress);
}

bindSetup();
bindWorkspace();
renderAll();
