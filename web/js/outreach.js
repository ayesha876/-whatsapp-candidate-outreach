// Pure logic for WhatsApp Candidate Outreach (no DOM). Mirrors app.py.
// Unit-tested in web/tests/outreach.test.mjs.

export const WHATSAPP_WEB_URL = "https://web.whatsapp.com/send?phone={phone}&text={text}";
export const WHATSAPP_APP_URL = "whatsapp://send?phone={phone}&text={text}";

export const STATUS_CONTACTED = "Contacted";
export const STATUS_PENDING = "Pending";
export const STATUS_INVALID = "Invalid number";
export const NOTE_MAX_CHARS = 500;

export const EXPORT_COLUMNS = Object.freeze({
  normalized: "Normalized Phone",
  others: "Other Phones",
  status: "Status",
  notes: "Notes",
});

export const DEFAULT_TEMPLATE =
  "Assalam o Alaikum {name},\n\n" +
  "We came across your profile and would like to discuss a job opportunity " +
  "that matches your experience. Would you be available for a short call " +
  "this week?\n\n" +
  "Thank you!";

const PK_MOBILE_PATTERN = /^923\d{9}$/;
const PHONE_SEPARATORS = /[/;,|\n]|\bor\b/i;
const EMPTY_WORDS = new Set(["nan", "none", "<na>", "null", "undefined"]);
const NAME_HINTS = ["name"];
const PHONE_HINTS = ["phone", "mobile", "whatsapp", "number", "contact", "cell"];

// ---------------------------------------------------------------- phones

export function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).trim();
  if (!text || EMPTY_WORDS.has(text.toLowerCase())) return null;
  text = text.replace(/\.0+$/, ""); // numeric spreadsheet cell, e.g. "3001234567.0"
  let digits = text.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("920") && digits.length === 13) digits = "92" + digits.slice(3);
  if (digits.startsWith("0")) digits = "92" + digits.slice(1);
  else if (digits.length === 10 && digits.startsWith("3")) digits = "92" + digits;
  return PK_MOBILE_PATTERN.test(digits) ? digits : null;
}

/** All valid numbers in a cell, in order, e.g. "0300-1234567 / 0321-7654321". */
export function extractPhones(raw) {
  const single = normalizePhone(raw);
  if (single) return [single];
  if (raw === null || raw === undefined) return [];
  const found = String(raw)
    .split(PHONE_SEPARATORS)
    .map(normalizePhone)
    .filter(Boolean);
  return [...new Set(found)];
}

// ---------------------------------------------------------------- text

export function cleanName(raw) {
  if (raw === null || raw === undefined) return "";
  const name = String(raw).trim();
  return EMPTY_WORDS.has(name.toLowerCase()) ? "" : name;
}

/** Fill {name}; when the name is blank, tidy the leftover spacing. */
export function buildMessage(template, name) {
  const person = cleanName(name);
  let message = template.split("{name}").join(person);
  if (!person) {
    message = message
      .replace(/[ \t]+([,.!?;:])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+$/gm, "");
  }
  return message;
}

export function whatsappLink(phone, message, format = WHATSAPP_WEB_URL) {
  return format.replace("{phone}", phone).replace("{text}", encodeURIComponent(message));
}

// ---------------------------------------------------------------- columns

export function guessColumn(columns, hints, fallback) {
  for (const hint of hints) {
    const index = columns.findIndex((col) => col.toLowerCase().includes(hint));
    if (index !== -1) return index;
  }
  return Math.max(0, Math.min(fallback, columns.length - 1));
}

export const guessNameColumn = (columns) => guessColumn(columns, NAME_HINTS, 0);
export const guessPhoneColumn = (columns) => guessColumn(columns, PHONE_HINTS, 1);

/** Turn a header row into unique, non-empty column names. */
export function uniqueHeaders(header) {
  const seen = new Map();
  return header.map((raw, i) => {
    const base = String(raw ?? "").trim() || `Column ${i + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base} (${count + 1})` : base;
  });
}

/** Array-of-arrays (first row = header) -> { columns, rows: [{col: text}] }. */
export function tableFromMatrix(matrix) {
  const nonEmpty = matrix.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  if (nonEmpty.length === 0) return { columns: [], rows: [] };
  const columns = uniqueHeaders(nonEmpty[0]);
  const rows = nonEmpty.slice(1).map((r) =>
    Object.freeze(Object.fromEntries(columns.map((c, i) => [c, String(r[i] ?? "").trim()])))
  );
  return { columns, rows };
}

// ---------------------------------------------------------------- candidates

export function prepareCandidates(rows, nameCol, phoneCol) {
  const phoneLists = rows.map((r) => extractPhones(r[phoneCol]));
  const normalized = phoneLists.map((found) => found[0] ?? null);
  const otherPhones = phoneLists.map((found) => found.slice(1).map((p) => `+${p}`).join(", "));
  const names = rows.map((r) => cleanName(r[nameCol]));

  const invalidRows = [];
  const byPhone = new Map(); // phone -> { first candidate, names[] }
  rows.forEach((row, i) => {
    const phone = normalized[i];
    if (!phone) {
      invalidRows.push({ row: i + 2, name: names[i], raw: row[phoneCol] ?? "" });
      return;
    }
    const existing = byPhone.get(phone);
    if (existing) {
      byPhone.set(phone, { ...existing, names: [...existing.names, names[i]] });
    } else {
      const candidate = { name: names[i], phone, otherPhones: otherPhones[i] };
      byPhone.set(phone, { candidate, names: [names[i]] });
    }
  });

  const entries = [...byPhone.values()];
  return {
    candidates: entries.map((e) => e.candidate),
    normalized,
    otherPhones,
    invalidRows,
    duplicates: entries
      .filter((e) => e.names.length > 1)
      .map((e) => ({
        phone: e.candidate.phone,
        count: e.names.length,
        names: e.names.map((n) => n || "(no name)").join(", "),
      })),
  };
}

// ---------------------------------------------------------------- progress
// progress = { [phone]: { name, contacted, notes, contactedAt? } } — never mutated.

export function isContacted(progress, phone) {
  const entry = progress[phone];
  return Boolean(entry && typeof entry === "object" && (entry.contacted ?? true));
}

export function noteOf(progress, phone) {
  const entry = phone ? progress[phone] : null;
  return entry && typeof entry === "object" ? String(entry.notes ?? "") : "";
}

export function statusOf(phone, progress) {
  if (!phone) return STATUS_INVALID;
  return isContacted(progress, phone) ? STATUS_CONTACTED : STATUS_PENDING;
}

function withEntry(progress, phone, entry) {
  const { [phone]: _old, ...rest } = progress;
  if (!entry.contacted && !entry.notes) return rest;
  return { ...rest, [phone]: entry };
}

export function withContacted(progress, phone, name, contacted, now = new Date()) {
  const entry = { name, contacted, notes: noteOf(progress, phone) };
  return withEntry(progress, phone, contacted ? { ...entry, contactedAt: now.toISOString() } : entry);
}

export function withNote(progress, phone, name, note) {
  const old = progress[phone] && typeof progress[phone] === "object" ? progress[phone] : {};
  return withEntry(progress, phone, {
    ...old,
    name,
    contacted: isContacted(progress, phone),
    notes: String(note).trim().slice(0, NOTE_MAX_CHARS),
  });
}

/** Rebuild progress from a previously exported CSV (its Status / Notes columns). */
export function progressFromExport(rows, columns, prepared, nameCol) {
  const hasStatus = columns.includes(EXPORT_COLUMNS.status);
  const hasNotes = columns.includes(EXPORT_COLUMNS.notes);
  if (!hasStatus && !hasNotes) return {};
  let progress = {};
  prepared.normalized.forEach((phone, i) => {
    if (!phone || phone in progress) return;
    const row = rows[i];
    progress = withEntry(progress, phone, {
      name: cleanName(row[nameCol]),
      contacted: hasStatus && row[EXPORT_COLUMNS.status].trim() === STATUS_CONTACTED,
      notes: hasNotes ? row[EXPORT_COLUMNS.notes].trim().slice(0, NOTE_MAX_CHARS) : "",
    });
  });
  return progress;
}

export function filterCandidates(candidates, progress, search, status) {
  const term = search.trim().toLowerCase();
  return candidates.filter(
    (c) =>
      (!term || c.name.toLowerCase().includes(term)) &&
      (status === "All" || statusOf(c.phone, progress) === status)
  );
}

export function countContacted(candidates, progress) {
  return candidates.filter((c) => isContacted(progress, c.phone)).length;
}

// ---------------------------------------------------------------- export

/**
 * Stop spreadsheet apps from running a cell as a formula (CSV injection).
 * Plain phone numbers such as "+92 300 1234567" are left alone.
 */
export function neutralizeFormula(text) {
  const risky = /^[=@\t\r]/.test(text) || (/^[+-]/.test(text) && /[A-Za-z(]/.test(text));
  return risky ? `'${text}` : text;
}

function csvCell(value) {
  const text = neutralizeFormula(String(value ?? ""));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV text (with BOM so Excel shows Urdu names) of the original rows + status columns. */
export function buildExportCsv(rows, columns, prepared, progress) {
  const added = Object.values(EXPORT_COLUMNS);
  const header = [...columns.filter((c) => !added.includes(c)), ...added];
  const lines = rows.map((row, i) => {
    const phone = prepared.normalized[i];
    const extra = {
      [EXPORT_COLUMNS.normalized]: phone ?? "",
      [EXPORT_COLUMNS.others]: prepared.otherPhones[i],
      [EXPORT_COLUMNS.status]: statusOf(phone, progress),
      [EXPORT_COLUMNS.notes]: noteOf(progress, phone),
    };
    return header.map((col) => csvCell(col in extra ? extra[col] : row[col])).join(",");
  });
  return "﻿" + [header.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
}
