"""WhatsApp Candidate Outreach — a Streamlit app.

Builds WhatsApp Web click-to-chat links with a pre-filled message for each
candidate. It NEVER sends anything: you press Send yourself in WhatsApp Web.
Progress lives only in the visitor's own session (keyed by normalized phone
number). Visitors keep it by exporting the CSV and re-uploading it later.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import pandas as pd
import streamlit as st

PROGRESS_KEY = "progress"
SEEDED_FILE_KEY = "seeded_file"
EXPORT_STATUS_COL = "Status"
EXPORT_NOTES_COL = "Notes"

WHATSAPP_URL = "https://web.whatsapp.com/send?phone={phone}&text={text}"
WHATSAPP_APP_URL = "whatsapp://send?phone={phone}&text={text}"
OPEN_IN_APP = "WhatsApp Desktop / phone app (fast)"
OPEN_IN_WEB = "WhatsApp Web in the browser (slow, reloads every time)"
LINK_FORMATS = {OPEN_IN_APP: WHATSAPP_APP_URL, OPEN_IN_WEB: WHATSAPP_URL}
PK_MOBILE_PATTERN = re.compile(r"^923\d{9}$")  # 92 + 3XX + 7 digits
PHONE_SEPARATORS = re.compile(r"[/;,|\n]|\bor\b", re.IGNORECASE)
PAGE_STEP = 50
CHECKBOX_PREFIX = "contacted_"
NOTE_PREFIX = "note_"
NOTE_MAX_CHARS = 500

STATUS_CONTACTED = "Contacted"
STATUS_PENDING = "Pending"
STATUS_INVALID = "Invalid number"
STATUS_FILTERS = ("All", STATUS_PENDING, STATUS_CONTACTED)

NAME_HINTS = ("name",)
PHONE_HINTS = ("phone", "mobile", "whatsapp", "number", "contact", "cell")

DEFAULT_TEMPLATE = (
    "Assalam o Alaikum {name},\n\n"
    "We came across your profile and would like to discuss a job opportunity "
    "that matches your experience. Would you be available for a short call "
    "this week?\n\n"
    "Thank you!"
)


@dataclass(frozen=True)
class PreparedData:
    candidates: pd.DataFrame  # unique valid candidates: name, phone
    normalized: pd.Series  # normalized phone per original row (None = invalid)
    invalid_rows: pd.DataFrame  # row, name, raw phone
    duplicates: pd.DataFrame  # phone, count, names
    other_phones: pd.Series  # extra numbers per original row, e.g. "+923001234567"


# --------------------------------------------------------------------------
# Pure helpers (unit-tested in tests/)
# --------------------------------------------------------------------------


def normalize_phone(raw: object) -> str | None:
    """Return a Pakistani mobile number as 923XXXXXXXXX, or None if invalid."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text or text.lower() in {"nan", "none", "<na>"}:
        return None
    text = re.sub(r"\.0+$", "", text)  # numeric Excel cell read as "3001234567.0"
    digits = re.sub(r"\D", "", text)
    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("920") and len(digits) == 13:  # +92 0300 1234567
        digits = "92" + digits[3:]
    if digits.startswith("0"):
        digits = "92" + digits[1:]
    elif len(digits) == 10 and digits.startswith("3"):
        digits = "92" + digits
    return digits if PK_MOBILE_PATTERN.match(digits) else None


def extract_phones(raw: object) -> list[str]:
    """All valid numbers in a cell, in order, e.g. '0300-1234567 / 0321-7654321'."""
    single = normalize_phone(raw)
    if single:
        return [single]
    if raw is None:
        return []
    parts = PHONE_SEPARATORS.split(str(raw))
    found = [p for p in (normalize_phone(part) for part in parts) if p]
    return list(dict.fromkeys(found))  # de-duplicate, keep order


def clean_name(raw: object) -> str:
    if raw is None:
        return ""
    name = str(raw).strip()
    return "" if name.lower() in {"nan", "none", "<na>"} else name


def build_message(template: str, name: object) -> str:
    """Fill {name}; when the name is blank, tidy the leftover spacing."""
    person = clean_name(name)
    message = template.replace("{name}", person)
    if not person:
        message = re.sub(r"[ \t]+([,.!?;:])", r"\1", message)  # "Hi ," -> "Hi,"
        message = re.sub(r"[ \t]{2,}", " ", message)
        message = re.sub(r"[ \t]+$", "", message, flags=re.MULTILINE)
    return message


def whatsapp_link(phone: str, message: str, link_format: str = WHATSAPP_URL) -> str:
    return link_format.format(phone=phone, text=quote(message, safe=""))


def read_table(data: bytes, filename: str) -> pd.DataFrame:
    """Read CSV/Excel bytes with every column as text."""
    suffix = Path(filename).suffix.lower()
    if suffix == ".csv":
        try:
            df = pd.read_csv(io.BytesIO(data), dtype=str, keep_default_na=False, encoding="utf-8-sig")
        except UnicodeDecodeError:
            df = pd.read_csv(io.BytesIO(data), dtype=str, keep_default_na=False, encoding="cp1252")
    elif suffix in (".xlsx", ".xls"):
        engine = "openpyxl" if suffix == ".xlsx" else "xlrd"
        df = pd.read_excel(io.BytesIO(data), dtype=str, keep_default_na=False, engine=engine)
    else:
        raise ValueError(f"Unsupported file type '{suffix}'. Use .csv, .xlsx or .xls.")
    return df.rename(columns=lambda c: str(c).strip())


def guess_column(columns: list[str], hints: tuple[str, ...], fallback: int) -> int:
    for hint in hints:
        for i, col in enumerate(columns):
            if hint in col.lower():
                return i
    return min(fallback, len(columns) - 1)


def prepare_candidates(df: pd.DataFrame, name_col: str, phone_col: str) -> PreparedData:
    phone_lists = df[phone_col].map(extract_phones)
    normalized = phone_lists.map(lambda found: found[0] if found else None)
    other_phones = phone_lists.map(lambda found: ", ".join(f"+{p}" for p in found[1:]))
    names = df[name_col].map(clean_name)
    valid = normalized.notna()

    invalid_rows = pd.DataFrame(
        {
            "row": df.index.to_numpy()[(~valid).to_numpy()] + 2,  # +2 = header line + 1-based numbering
            "name": names[~valid],
            "phone (as in file)": df.loc[~valid, phone_col],
        }
    )

    table = pd.DataFrame(
        {"name": names[valid], "phone": normalized[valid], "other_phones": other_phones[valid]}
    )
    counts = table["phone"].value_counts()
    dup_counts = counts[counts > 1]
    duplicates = (
        table[table["phone"].isin(dup_counts.index)]
        .groupby("phone")["name"]
        .agg(lambda s: ", ".join(n or "(no name)" for n in s))
        .reset_index(name="names")
        .assign(count=lambda d: d["phone"].map(dup_counts))
    )
    candidates = table.drop_duplicates("phone", keep="first").reset_index(drop=True)
    return PreparedData(
        candidates, normalized, invalid_rows.reset_index(drop=True), duplicates, other_phones
    )


def is_missing(phone: object) -> bool:
    return phone is None or (not isinstance(phone, str) and bool(pd.isna(phone)))


def status_of(phone: str | None, progress: dict) -> str:
    if is_missing(phone):
        return STATUS_INVALID
    return STATUS_CONTACTED if is_contacted(progress, phone) else STATUS_PENDING


def is_contacted(progress: dict, phone: str) -> bool:
    entry = progress.get(phone)
    # Entries saved before notes existed have no "contacted" field and meant contacted.
    return isinstance(entry, dict) and bool(entry.get("contacted", True))


def note_of(progress: dict, phone: str | None) -> str:
    entry = None if is_missing(phone) else progress.get(phone)
    return str(entry.get("notes", "")) if isinstance(entry, dict) else ""


def filter_candidates(candidates: pd.DataFrame, progress: dict, search: str, status: str) -> pd.DataFrame:
    result = candidates
    term = search.strip().lower()
    if term:
        result = result[result["name"].str.lower().str.contains(term, regex=False)]
    if status != "All":
        result = result[result["phone"].map(lambda p: status_of(p, progress)) == status]
    return result


def build_export(df: pd.DataFrame, prepared: PreparedData, progress: dict) -> bytes:
    export = df.assign(
        **{
            "Normalized Phone": prepared.normalized.fillna(""),
            "Other Phones": prepared.other_phones,
            "Status": prepared.normalized.map(lambda p: status_of(p, progress)),
            "Notes": prepared.normalized.map(lambda p: note_of(progress, p)),
        }
    )
    return export.to_csv(index=False).encode("utf-8-sig")  # BOM so Excel shows Urdu names


def progress_from_export(df: pd.DataFrame, prepared: PreparedData, name_col: str) -> dict:
    """Rebuild progress from a previously exported CSV (its Status / Notes columns)."""
    if EXPORT_STATUS_COL not in df.columns and EXPORT_NOTES_COL not in df.columns:
        return {}
    progress: dict = {}
    for idx, phone in prepared.normalized.items():
        if is_missing(phone) or phone in progress:
            continue
        status = str(df.at[idx, EXPORT_STATUS_COL]) if EXPORT_STATUS_COL in df.columns else ""
        note = str(df.at[idx, EXPORT_NOTES_COL]) if EXPORT_NOTES_COL in df.columns else ""
        entry = {
            "name": clean_name(df.at[idx, name_col]),
            "contacted": status.strip() == STATUS_CONTACTED,
            "notes": note.strip()[:NOTE_MAX_CHARS],
        }
        progress = _with_entry(progress, phone, entry)
    return progress


def _with_entry(progress: dict, phone: str, entry: dict) -> dict:
    """Return a new progress dict; entries with no status and no note are dropped."""
    rest = {p: v for p, v in progress.items() if p != phone}
    if not entry.get("contacted") and not entry.get("notes"):
        return rest
    return {**rest, phone: entry}


def with_contacted(progress: dict, phone: str, name: str, contacted: bool) -> dict:
    """Return a new progress dict with this phone marked/unmarked."""
    entry = {"name": name, "contacted": contacted, "notes": note_of(progress, phone)}
    if contacted:
        entry = {**entry, "contacted_at": datetime.now().isoformat(timespec="seconds")}
    return _with_entry(progress, phone, entry)


def with_note(progress: dict, phone: str, name: str, note: str) -> dict:
    """Return a new progress dict with this phone's note replaced."""
    old = progress.get(phone) if isinstance(progress.get(phone), dict) else {}
    entry = {
        **old,
        "name": name,
        "contacted": is_contacted(progress, phone),
        "notes": note.strip()[:NOTE_MAX_CHARS],
    }
    return _with_entry(progress, phone, entry)


# --------------------------------------------------------------------------
# Streamlit UI
# --------------------------------------------------------------------------


def checkbox_key(phone: str) -> str:
    return f"{CHECKBOX_PREFIX}{phone}"


def init_state() -> None:
    st.session_state.setdefault("visible", PAGE_STEP)
    st.session_state.setdefault("confirm_reset", False)
    st.session_state.setdefault("template", DEFAULT_TEMPLATE)
    st.session_state.setdefault(PROGRESS_KEY, {})


def get_progress() -> dict:
    return st.session_state[PROGRESS_KEY]


def set_progress(progress: dict) -> None:
    st.session_state[PROGRESS_KEY] = progress


def reset_visible() -> None:
    st.session_state["visible"] = PAGE_STEP


def on_toggle(phone: str, name: str) -> None:
    contacted = bool(st.session_state[checkbox_key(phone)])
    set_progress(with_contacted(get_progress(), phone, name, contacted))


def note_key(phone: str) -> str:
    return f"{NOTE_PREFIX}{phone}"


def on_note_change(phone: str, name: str) -> None:
    note = str(st.session_state[note_key(phone)])
    set_progress(with_note(get_progress(), phone, name, note))


def clear_widget_state() -> None:
    prefixes = (CHECKBOX_PREFIX, NOTE_PREFIX)
    for key in [k for k in st.session_state if str(k).startswith(prefixes)]:
        del st.session_state[key]


def do_reset() -> None:
    set_progress({})
    clear_widget_state()
    st.session_state["confirm_reset"] = False
    reset_visible()


def seed_progress_once(file_id: str, df: pd.DataFrame, prepared: PreparedData, name_col: str) -> None:
    """When a previously exported CSV is uploaded, restore its Status/Notes once."""
    seed_id = f"{file_id}:{name_col}"
    if st.session_state.get(SEEDED_FILE_KEY) == seed_id:
        return
    st.session_state[SEEDED_FILE_KEY] = seed_id
    restored = progress_from_export(df, prepared, name_col)
    if restored:
        set_progress({**get_progress(), **restored})
        clear_widget_state()
        st.session_state["restored_count"] = len(restored)


@st.cache_data(show_spinner=False)
def cached_read(data: bytes, filename: str) -> pd.DataFrame:
    return read_table(data, filename)


def render_sidebar_columns(df: pd.DataFrame, file_id: str) -> tuple[str, str]:
    columns = list(df.columns)
    st.sidebar.header("Columns")
    name_col = st.sidebar.selectbox(
        "Name column", columns, index=guess_column(columns, NAME_HINTS, 0), key=f"name_col_{file_id}"
    )
    phone_col = st.sidebar.selectbox(
        "Phone column", columns, index=guess_column(columns, PHONE_HINTS, 1), key=f"phone_col_{file_id}"
    )
    return name_col, phone_col


def render_sidebar_template() -> str:
    st.sidebar.header("Message")
    template = st.sidebar.text_area("Template", key="template", height=220)
    st.sidebar.caption("`{name}` is replaced with each candidate's name.")
    if st.sidebar.button("Restore default template"):
        del st.session_state["template"]
        st.rerun()
    if "{name}" not in template:
        st.sidebar.info("Tip: add `{name}` to personalise the message.")
    return template


def render_sidebar_reset() -> None:
    st.sidebar.divider()
    if not st.session_state["confirm_reset"]:
        st.sidebar.button(
            "Reset all progress", on_click=lambda: st.session_state.update(confirm_reset=True)
        )
        return
    st.sidebar.warning(
        "Mark **every** candidate as Pending again and clear all notes? "
        "Export the CSV first if you want to keep them."
    )
    yes, cancel = st.sidebar.columns(2)
    yes.button("Yes, reset", type="primary", on_click=do_reset)
    cancel.button("Cancel", on_click=lambda: st.session_state.update(confirm_reset=False))


def render_file_notices(prepared: PreparedData) -> None:
    skipped = len(prepared.invalid_rows)
    if skipped:
        st.warning(f"Skipped {skipped} row(s) with an empty or invalid phone number.")
        with st.expander("Show skipped rows"):
            st.dataframe(prepared.invalid_rows, hide_index=True, width="stretch")
    if not prepared.duplicates.empty:
        extra = int(prepared.duplicates["count"].sum() - len(prepared.duplicates))
        st.warning(
            f"{len(prepared.duplicates)} phone number(s) appear more than once in the file. "
            f"Only the first row of each is listed below ({extra} duplicate row(s) hidden)."
        )
        with st.expander("Show duplicates"):
            st.dataframe(prepared.duplicates, hide_index=True, width="stretch")


def render_metrics(candidates: pd.DataFrame, progress: dict) -> None:
    total = len(candidates)
    contacted = int(candidates["phone"].map(lambda p: is_contacted(progress, p)).sum())
    a, b, c = st.columns(3)
    a.metric("Total", total)
    b.metric("Contacted", contacted)
    c.metric("Pending", total - contacted)


def render_sidebar_open_in() -> str:
    st.sidebar.header("Open chats in")
    choice = st.sidebar.radio(
        "Open chats in", list(LINK_FORMATS), key="open_in", label_visibility="collapsed"
    )
    if choice == OPEN_IN_APP:
        st.sidebar.caption(
            "Needs the WhatsApp app installed and logged in (Windows: Microsoft Store). "
            "The first time, tick **Always allow** in the browser's “Open WhatsApp?” pop-up."
        )
    return LINK_FORMATS[choice]


def render_row(
    name: str, phone: str, other_phones: str, template: str, progress: dict, link_format: str
) -> None:
    key = checkbox_key(phone)
    st.session_state[key] = is_contacted(progress, phone)
    contacted = st.session_state[key]
    n_key = note_key(phone)
    if n_key not in st.session_state:
        st.session_state[n_key] = note_of(progress, phone)

    c_name, c_phone, c_link, c_check, c_note = st.columns(
        [2.5, 1.8, 1.8, 1.3, 3], vertical_alignment="center"
    )
    c_name.text(name or "(no name)")
    c_phone.text(f"+{phone}")
    if other_phones:
        c_phone.caption(f"Also: {other_phones}")
    c_link.link_button(
        "Already contacted" if contacted else "Open WhatsApp",
        whatsapp_link(phone, build_message(template, name), link_format),
        disabled=contacted,
        width="stretch",
    )
    c_check.checkbox("Contacted", key=key, on_change=on_toggle, args=(phone, name))
    c_note.text_input(
        "Notes",
        key=n_key,
        placeholder="Add a note…",
        max_chars=NOTE_MAX_CHARS,
        label_visibility="collapsed",
        on_change=on_note_change,
        args=(phone, name),
    )


def render_candidate_list(
    candidates: pd.DataFrame, progress: dict, template: str, link_format: str
) -> None:
    search_col, status_col = st.columns([3, 2])
    search = search_col.text_input("Search by name", key="search", on_change=reset_visible)
    status = status_col.selectbox("Status", STATUS_FILTERS, key="status_filter", on_change=reset_visible)

    filtered = filter_candidates(candidates, progress, search, status)
    if filtered.empty:
        st.info("No candidates match the current filters.")
        return

    visible = st.session_state["visible"]
    for row in filtered.head(visible).itertuples(index=False):
        render_row(row.name, row.phone, row.other_phones, template, progress, link_format)

    shown = min(visible, len(filtered))
    st.caption(f"Showing {shown} of {len(filtered)}")
    if len(filtered) > visible:
        st.button(
            f"Load {PAGE_STEP} more",
            on_click=lambda: st.session_state.update(visible=visible + PAGE_STEP),
        )


def main() -> None:
    st.set_page_config(page_title="WhatsApp Candidate Outreach", page_icon="💬", layout="wide")
    init_state()
    st.title("WhatsApp Candidate Outreach")
    st.caption("Opens a pre-filled chat in WhatsApp Web. Nothing is sent until **you** press Send there.")
    st.info(
        "Your file and progress stay in **this browser tab only** and are lost when you close it. "
        "Use **Export CSV with status** to save your progress, and upload that CSV next time to continue.",
        icon="💾",
    )

    uploaded = st.file_uploader("Upload candidates file", type=["csv", "xlsx", "xls"])
    if uploaded is None:
        st.info("Upload a CSV or Excel file with candidate names and phone numbers to begin.")
        return

    try:
        df = cached_read(uploaded.getvalue(), uploaded.name)
    except Exception as exc:  # pandas raises many different parser errors
        st.error(f"Could not read the file: {exc}")
        return
    if df.empty or len(df.columns) == 0:
        st.error("The file has no rows.")
        return

    file_id = f"{uploaded.name}:{uploaded.size}"
    name_col, phone_col = render_sidebar_columns(df, file_id)
    link_format = render_sidebar_open_in()
    template = render_sidebar_template()
    render_sidebar_reset()

    prepared = prepare_candidates(df, name_col, phone_col)
    seed_progress_once(file_id, df, prepared, name_col)
    if restored := st.session_state.pop("restored_count", None):
        st.success(f"Restored status and notes for {restored} candidate(s) from this file.")
    progress = get_progress()
    render_file_notices(prepared)
    if prepared.candidates.empty:
        st.error("No valid phone numbers found. Check that the right Phone column is selected.")
        return
    if not template.strip():
        st.warning("The message template is empty; chats will open without a message.")

    render_metrics(prepared.candidates, progress)
    st.download_button(
        "Export CSV with status",
        data=build_export(df, prepared, progress),
        file_name=f"{Path(uploaded.name).stem}_status.csv",
        mime="text/csv",
    )
    with st.expander("Preview message"):
        st.text(build_message(template, prepared.candidates.iloc[0]["name"]))

    st.divider()
    render_candidate_list(prepared.candidates, progress, template, link_format)


if __name__ == "__main__":
    main()
