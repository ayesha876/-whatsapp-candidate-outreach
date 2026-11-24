# WhatsApp Candidate Outreach

A small Streamlit app for messaging job candidates on WhatsApp **one at a time, manually**.
It opens a chat with your message already typed in. **Nothing is sent until you press Send yourself.**

## How to use

1. Upload a `.csv`, `.xlsx` or `.xls` file with candidate names and phone numbers.
2. In the sidebar:
   - **Open chats in**: choose **WhatsApp Desktop / phone app (fast)**. The chat opens in about a second in
     the WhatsApp app. The first time, tick **Always allow** in the browser's "Open WhatsApp?" pop-up.
     Choose **WhatsApp Web** only if you don't have the app; it reloads WhatsApp Web for every chat, which is slow.
   - Choose the **Name** and **Phone** columns and edit the message. `{name}` is replaced with each candidate's name.
3. Click **Open WhatsApp** for a candidate, check the message, and press Send.
4. Tick **Contacted** and add **Notes**. That candidate's button is turned off so you don't message them twice.
5. Click **Export CSV with status** to save your work. The file gets `Normalized Phone`, `Status` and `Notes` columns.

### Your data and progress

- Your file and progress stay **only in your browser tab**. Nothing is stored on the server or shared with
  other people using the link, and it's gone when you close the tab.
- To continue later, upload the **exported CSV**. Status and notes are restored automatically.

## Notes

- Phone numbers are converted to Pakistani mobile format `923XXXXXXXXX`. `0300-1234567`, `03001234567`,
  `+92 300 1234567`, `0092 300 1234567` and `3001234567` all work. Cells with several numbers use the first one
  and show the others. Rows with an empty or invalid number are skipped and listed.
- If the same number appears more than once, you get a warning and only the first row is shown.

## Run locally

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
streamlit run app.py --server.address localhost
```

## Deploy (Streamlit Community Cloud)

1. Push this folder to a GitHub repository (`.gitignore` keeps candidate files out).
2. At https://share.streamlit.io click **Create app**, pick the repo, branch `main`, main file `app.py`, and deploy.

## Tests

```bash
pytest -q
```
