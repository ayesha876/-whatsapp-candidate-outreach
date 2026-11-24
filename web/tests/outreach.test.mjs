import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WHATSAPP_APP_URL,
  buildExportCsv,
  buildMessage,
  countContacted,
  extractPhones,
  filterCandidates,
  guessNameColumn,
  guessPhoneColumn,
  normalizePhone,
  prepareCandidates,
  progressFromExport,
  statusOf,
  tableFromMatrix,
  whatsappLink,
  withContacted,
  withNote,
} from "../js/outreach.js";

const rowsOf = (pairs) => pairs.map(([Name, Phone]) => ({ Name, Phone }));

/** Parse our own CSV output back into a table (handles quoted cells). */
function parseCsv(text) {
  const body = text.replace(/^﻿/, "");
  const matrix = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); matrix.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  return tableFromMatrix(matrix);
}

test("normalizePhone accepts common Pakistani formats", () => {
  for (const raw of [
    "0300-1234567", "03001234567", "+92 300 1234567", "3001234567", "00923001234567",
    "(0300) 123-4567", "92-300-1234567", "+92 0300 1234567", "3001234567.0", " 0300 1234567 ",
    3001234567,
  ]) {
    assert.equal(normalizePhone(raw), "923001234567", String(raw));
  }
});

test("normalizePhone rejects empty or invalid numbers", () => {
  for (const raw of ["", "   ", null, undefined, "nan", "abc", "12345", "030012345",
    "030012345678", "04235761234", "+44 7700 900123"]) {
    assert.equal(normalizePhone(raw), null, String(raw));
  }
});

test("extractPhones handles several numbers in one cell", () => {
  const cases = [
    ["0303-5885837 / 0332-7283727", ["923035885837", "923327283727"]],
    ["+92 303 3765771 / +92 334 8594441", ["923033765771", "923348594441"]],
    ["+971 52 737 0223 / 0308-4908977 / 0329-3534088", ["923084908977", "923293534088"]],
    ["+60 11-2830 8375 (Malaysia); file name suggests 0329-4176522", ["923294176522"]],
    ["0300-1234567 or 0300 1234567", ["923001234567"]],
    ["Not on CV", []],
    ["+92 302 ?459887 (unclear - check CV)", []],
  ];
  for (const [raw, expected] of cases) assert.deepEqual(extractPhones(raw), expected, raw);
});

test("buildMessage fills the name and tidies a blank one", () => {
  assert.equal(buildMessage("Hi {name}, welcome", "Ali"), "Hi Ali, welcome");
  assert.equal(
    buildMessage("Assalam o Alaikum {name},\nHow are you?", "  "),
    "Assalam o Alaikum,\nHow are you?"
  );
  assert.equal(buildMessage("Dear {name}\nThanks", null), "Dear\nThanks");
});

test("links encode the message for WhatsApp Web and the app", () => {
  const web = new URL(whatsappLink("923001234567", "Hi Ali & co,\nline 2"));
  assert.equal(web.host, "web.whatsapp.com");
  assert.equal(web.searchParams.get("phone"), "923001234567");
  assert.equal(web.searchParams.get("text"), "Hi Ali & co,\nline 2");

  const app = whatsappLink("923001234567", "Hi Ali & co,\nline 2", WHATSAPP_APP_URL);
  assert.ok(app.startsWith("whatsapp://send?phone=923001234567&text="));
  assert.equal(new URL(app).searchParams.get("text"), "Hi Ali & co,\nline 2");
});

test("duplicates and invalid rows are reported", () => {
  const prepared = prepareCandidates(
    rowsOf([["A", "03001234567"], ["B", "+92 300 1234567"], ["C", ""], ["D", "123"]]),
    "Name",
    "Phone"
  );
  assert.deepEqual(prepared.candidates.map((c) => c.name), ["A"]);
  assert.equal(prepared.invalidRows.length, 2);
  assert.equal(prepared.invalidRows[0].row, 4); // header + 1-based numbering
  assert.deepEqual(prepared.duplicates, [{ phone: "923001234567", count: 2, names: "A, B" }]);
});

test("first number is used, the others are kept", () => {
  const prepared = prepareCandidates(rowsOf([["A", "0303-5885837 / 0332-7283727"]]), "Name", "Phone");
  assert.equal(prepared.candidates[0].phone, "923035885837");
  assert.equal(prepared.candidates[0].otherPhones, "+923327283727");
});

test("progress updates never mutate and keep notes separate from status", () => {
  const phone = "923001234567";
  const empty = Object.freeze({});
  let progress = withNote(empty, phone, "A", "  Call after 5pm  ");
  assert.equal(progress[phone].notes, "Call after 5pm");
  assert.equal(statusOf(phone, progress), "Pending");

  const noted = Object.freeze(progress);
  progress = withContacted(noted, phone, "A", true);
  assert.equal(statusOf(phone, progress), "Contacted");
  assert.equal(progress[phone].notes, "Call after 5pm");
  assert.equal(statusOf(phone, noted), "Pending"); // original untouched

  progress = withContacted(progress, phone, "A", false);
  assert.equal(progress[phone].notes, "Call after 5pm");
  assert.deepEqual(withNote(progress, phone, "A", ""), {});
});

test("filter by name and status, and count contacted", () => {
  const prepared = prepareCandidates(
    rowsOf([["Ali", "03001234567"], ["Bilal", "03011234567"]]), "Name", "Phone"
  );
  const progress = withContacted({}, "923001234567", "Ali", true);
  assert.deepEqual(filterCandidates(prepared.candidates, progress, "", "Pending").map((c) => c.name), ["Bilal"]);
  assert.deepEqual(filterCandidates(prepared.candidates, progress, "ALI", "All").map((c) => c.name), ["Ali"]);
  assert.equal(countContacted(prepared.candidates, progress), 1);
});

test("export round-trip restores status and notes", () => {
  const rows = rowsOf([
    ["A, Jr.", "03001234567"], ["B", "03011234567"], ["C", "03021234567"], ["D", "x"],
  ]);
  const columns = ["Name", "Phone"];
  const prepared = prepareCandidates(rows, "Name", "Phone");
  const progress = withNote(
    withContacted({}, "923001234567", "A, Jr.", true), "923011234567", "B", 'Said "call later"'
  );
  const csv = buildExportCsv(rows, columns, prepared, progress);
  assert.ok(csv.startsWith("﻿"));

  const table = parseCsv(csv);
  assert.deepEqual(table.columns, ["Name", "Phone", "Normalized Phone", "Other Phones", "Status", "Notes"]);
  assert.deepEqual(table.rows.map((r) => r.Status), ["Contacted", "Pending", "Pending", "Invalid number"]);

  const reloaded = prepareCandidates(table.rows, "Name", "Phone");
  const restored = progressFromExport(table.rows, table.columns, reloaded, "Name");
  assert.equal(statusOf("923001234567", restored), "Contacted");
  assert.equal(restored["923001234567"].name, "A, Jr.");
  assert.equal(restored["923011234567"].notes, 'Said "call later"');
  assert.ok(!("923021234567" in restored));

  // Re-exporting an exported file does not duplicate the status columns.
  const again = parseCsv(buildExportCsv(table.rows, table.columns, reloaded, restored));
  assert.deepEqual(again.columns, table.columns);
});

test("plain file restores nothing", () => {
  const rows = rowsOf([["A", "03001234567"]]);
  assert.deepEqual(progressFromExport(rows, ["Name", "Phone"], prepareCandidates(rows, "Name", "Phone"), "Name"), {});
});

test("tableFromMatrix makes unique headers and skips blank lines", () => {
  const table = tableFromMatrix([["Name", "", "Name"], [], ["A", "x", "B"]]);
  assert.deepEqual(table.columns, ["Name", "Column 2", "Name (2)"]);
  assert.deepEqual(table.rows, [{ Name: "A", "Column 2": "x", "Name (2)": "B" }]);
});

test("column guessing prefers name/phone-like headers", () => {
  const cols = ["Sr", "Full Name", "City", "Contact No"];
  assert.equal(guessNameColumn(cols), 1);
  assert.equal(guessPhoneColumn(cols), 3);
  assert.equal(guessPhoneColumn(["Only"]), 0);
});
