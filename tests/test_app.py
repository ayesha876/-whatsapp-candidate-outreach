import io
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import (  # noqa: E402
    WHATSAPP_APP_URL,
    build_export,
    build_message,
    extract_phones,
    filter_candidates,
    normalize_phone,
    prepare_candidates,
    progress_from_export,
    read_table,
    status_of,
    whatsapp_link,
    with_contacted,
    with_note,
)

SAMPLE = Path(__file__).resolve().parents[1] / "sample_candidates.csv"


@pytest.mark.parametrize(
    "raw",
    [
        "0300-1234567",
        "03001234567",
        "+92 300 1234567",
        "3001234567",
        "00923001234567",
        "(0300) 123-4567",
        "92-300-1234567",
        "+92 0300 1234567",
        "3001234567.0",  # numeric Excel cell read as text
        " 0300 1234567 ",
    ],
)
def test_normalize_phone_valid_formats(raw):
    assert normalize_phone(raw) == "923001234567"


@pytest.mark.parametrize(
    "raw",
    ["", "   ", None, "nan", "abc", "12345", "030012345", "030012345678", "04235761234", "+44 7700 900123"],
)
def test_normalize_phone_rejects_empty_or_invalid(raw):
    assert normalize_phone(raw) is None


def test_build_message_fills_name():
    assert build_message("Hi {name}, welcome", "Ali") == "Hi Ali, welcome"


def test_build_message_blank_name_is_tidy():
    assert build_message("Assalam o Alaikum {name},\nHow are you?", "  ") == "Assalam o Alaikum,\nHow are you?"
    assert build_message("Dear {name}\nThanks", None) == "Dear\nThanks"


def test_whatsapp_link_encodes_message():
    url = whatsapp_link("923001234567", "Hi Ali & co,\nline 2")
    parsed = urlparse(url)
    assert parsed.netloc == "web.whatsapp.com" and parsed.path == "/send"
    query = parse_qs(parsed.query)
    assert query["phone"] == ["923001234567"]
    assert query["text"] == ["Hi Ali & co,\nline 2"]


def test_app_link_opens_desktop_app_with_same_message():
    url = whatsapp_link("923001234567", "Hi Ali & co,\nline 2", WHATSAPP_APP_URL)
    assert url.startswith("whatsapp://send?")
    query = parse_qs(urlparse(url).query)
    assert query["phone"] == ["923001234567"]
    assert query["text"] == ["Hi Ali & co,\nline 2"]


@pytest.mark.skipif(not SAMPLE.exists(), reason="sample_candidates.csv not in folder")
def test_sample_file_parses_all_rows():
    df = read_table(SAMPLE.read_bytes(), SAMPLE.name)
    prepared = prepare_candidates(df, "Name", "Phone")
    assert len(prepared.candidates) == 5
    assert prepared.invalid_rows.empty
    assert set(prepared.candidates["phone"]) == {
        "923001234567", "923217654321", "923451112233", "923331234567", "923129876543",
    }


def test_duplicates_and_invalid_rows_are_reported():
    df = pd.DataFrame(
        {"Name": ["A", "B", "C", "D"], "Phone": ["03001234567", "+92 300 1234567", "", "123"]}
    )
    prepared = prepare_candidates(df, "Name", "Phone")
    assert list(prepared.candidates["name"]) == ["A"]
    assert len(prepared.invalid_rows) == 2
    assert prepared.duplicates.iloc[0]["count"] == 2


def test_progress_toggle_and_export():
    progress = with_contacted({}, "923001234567", "A", True)
    assert "923001234567" in progress
    assert with_contacted(progress, "923001234567", "A", False) == {}
    assert "923001234567" in progress  # original not mutated

    df = pd.DataFrame({"Name": ["A", "B", "C"], "Phone": ["03001234567", "03011234567", "x"]})
    prepared = prepare_candidates(df, "Name", "Phone")
    csv = build_export(df, prepared, progress).decode("utf-8-sig")
    assert "Contacted" in csv and "Pending" in csv and "Invalid number" in csv

    pending = filter_candidates(prepared.candidates, progress, "", "Pending")
    assert list(pending["name"]) == ["B"]
    assert list(filter_candidates(prepared.candidates, progress, "a", "All")["name"]) == ["A"]


def test_note_kept_independently_of_contacted_status():
    phone = "923001234567"
    progress = with_note({}, phone, "A", "  Call after 5pm  ")
    assert progress[phone]["notes"] == "Call after 5pm"
    assert status_of(phone, progress) == "Pending"  # a note alone doesn't mark contacted

    progress = with_contacted(progress, phone, "A", True)
    assert status_of(phone, progress) == "Contacted"
    assert progress[phone]["notes"] == "Call after 5pm"

    progress = with_contacted(progress, phone, "A", False)
    assert status_of(phone, progress) == "Pending"
    assert progress[phone]["notes"] == "Call after 5pm"  # unticking keeps the note

    assert with_note(progress, phone, "A", "") == {}  # no status + no note -> entry removed


def test_old_progress_entries_still_count_as_contacted():
    old_format = {"923001234567": {"name": "A", "contacted_at": "2026-11-23T10:00:00"}}
    assert status_of("923001234567", old_format) == "Contacted"


def test_export_includes_notes_column():
    df = pd.DataFrame({"Name": ["A", "B"], "Phone": ["03001234567", "03011234567"]})
    prepared = prepare_candidates(df, "Name", "Phone")
    progress = with_note({}, "923001234567", "A", "Interested")
    exported = pd.read_csv(io.BytesIO(build_export(df, prepared, progress)), dtype=str, keep_default_na=False)
    assert list(exported["Notes"]) == ["Interested", ""]


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("0303-5885837 / 0332-7283727", ["923035885837", "923327283727"]),
        ("+92 303 3765771 / +92 334 8594441", ["923033765771", "923348594441"]),
        ("+971 52 737 0223 / 0308-4908977 / 0329-3534088", ["923084908977", "923293534088"]),
        ("+60 11-2830 8375 (Malaysia); file name suggests 0329-4176522", ["923294176522"]),
        ("0300-1234567 or 0300 1234567", ["923001234567"]),
        ("Not on CV", []),
        ("+92 302 ?459887 (unclear - check CV)", []),
    ],
)
def test_extract_phones_handles_multiple_numbers(raw, expected):
    assert extract_phones(raw) == expected


def test_exported_csv_restores_status_and_notes():
    df = pd.DataFrame(
        {"Name": ["A", "B", "C", "D"], "Phone": ["03001234567", "03011234567", "03021234567", "x"]}
    )
    prepared = prepare_candidates(df, "Name", "Phone")
    progress = with_note(with_contacted({}, "923001234567", "A", True), "923011234567", "B", "Call later")
    exported = read_table(build_export(df, prepared, progress), "export.csv")

    reloaded = prepare_candidates(exported, "Name", "Phone")
    restored = progress_from_export(exported, reloaded, "Name")

    assert status_of("923001234567", restored) == "Contacted"
    assert status_of("923011234567", restored) == "Pending"
    assert restored["923011234567"]["notes"] == "Call later"
    assert restored["923001234567"]["name"] == "A"
    assert "923021234567" not in restored  # untouched candidate stays out


def test_plain_file_restores_nothing():
    df = pd.DataFrame({"Name": ["A"], "Phone": ["03001234567"]})
    assert progress_from_export(df, prepare_candidates(df, "Name", "Phone"), "Name") == {}


def test_prepare_uses_first_number_and_keeps_others():
    df = pd.DataFrame({"Name": ["A"], "Phone": ["0303-5885837 / 0332-7283727"]})
    prepared = prepare_candidates(df, "Name", "Phone")
    row = prepared.candidates.iloc[0]
    assert row["phone"] == "923035885837"
    assert row["other_phones"] == "+923327283727"
    exported = pd.read_csv(io.BytesIO(build_export(df, prepared, {})), dtype=str, keep_default_na=False)
    assert exported.loc[0, "Other Phones"] == "+923327283727"
