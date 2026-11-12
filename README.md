# SURE Walk Texts

The texting / calling side of SURE Walk, for the rides workbook in **Excel on the web**. No Google services.

```
Excel rides sheet ── Excel panel (Script Lab) ──▶ GroupMe sync chat ──▶ texting server (this PC) ──▶ BlueFerry ──▶ UT iPhone
                  ◀── writes Call Time, cancels… ◀─────────────────────── posts its sheet edits back
```

| Part | Folder | What it does |
|---|---|---|
| **Excel panel** | `excel/` | Script Lab snippet. Click a ride's row: **📞 Mark called** (Call Time = now, your name in Dispatcher if blank), **✖ Cancel** with a reason (black row, like dispatch), **⧉ Duplicate** (red row), **✎ Pick-up / drop-off**, **↶ Undo**. Optional **GroupMe sync** (⚙ Settings, off by default). |
| **Texting server** | `server/` | Runs on the texting computer. Reads the sync chat, runs the SURE Walk Texts texting code, serves the texting dashboard at **http://127.0.0.1:8787**, and is the phone bridge's endpoint. |
| Sync protocol | `protocol.js` | One line per ride event in the chat (shared by both sides). |

**Snippet (public gist):** https://gist.github.com/leeisaac991/a38e032d2f024ab5d517cb409ba06414 (Script Lab ▸ Import ▸ paste the link)

## Privacy
- The sync chat only carries what the sheet holds (time, name, phone, pick-up, drop-off, ADA, dispatcher, call /
  arrival time, crew, cancel reason, row color). **Texts with riders never go there.**
- Every text in and out is logged on the texting computer only (`~/.local/state/surewalk-texts/messages.jsonl`,
  readable only by you; the dashboard's Settings ▸ Log downloads it as CSV).
- No tokens in this repo. The Excel panel keeps its GroupMe token in that browser; the server keeps its own in
  `~/.config/surewalk-texts/config.json` (mode 600).
- The server only listens on 127.0.0.1 and refuses requests from other sites or host names.

## Set up
### 1. A sync chat
Make a GroupMe chat just for this (e.g. "SURE Walk Texts sync") with the accounts that need it.

### 2. The Excel panel (one dispatcher's browser)

#### Option A: Real Add-in (Home ▸ Texts button — no Script Lab needed)
1. In Excel on the web, open the rides workbook.
2. **Home ▸ Add-ins ▸ More Add-ins ▸ My Add-ins ▸ Upload My Add-in** ▸ select `manifest.xml`.
3. A **SURE Walk ▸ Texts** button appears on the **Home** tab ribbon. Click it to open the panel.
4. **⚙ Settings**: your name, the rides tab if it isn't the first tab, the GroupMe token ▸ **Check & load chats** ▸ pick the sync chat ▸ turn on **Sync rides with the texting computer** ▸ **Save**.
   Turn sync on in **one** panel at a time (others can still use the buttons with sync off).

The add-in loads the newest panel from the site (`docs/`) each time it opens or restarts (**↻ Restart**).

#### Option B: Script Lab snippet
1. Excel on the web ▸ open the rides workbook ▸ **Home ▸ Add-ins** ▸ add **Script Lab**.
2. **Script Lab ▸ Code ▸ ☰ ▸ Import** ▸ paste the gist link ▸ **Import** ▸ **Run**.
3. **⚙**: your name, the rides tab if it isn't the first tab, the GroupMe token ▸ **Check & load chats** ▸ pick the
   sync chat ▸ turn on **Sync rides with the texting computer** ▸ **Save**.

### 3. The texting computer
```
node server/server.mjs --open        # or: server/start.sh
```
- In the dashboard, the **GroupMe** pill ▸ paste the token ▸ pick the same chat ▸ **Save & start syncing**.
- Point the phone bridge here (keeps its old config as `config.google.json`), then restart it:
  ```
  node server/server.mjs link-bridge
  systemctl --user restart surewalk-bridge
  ```
- As a service: `cp server/surewalk-texts.service ~/.config/systemd/user/ && systemctl --user daemon-reload`, then
  `systemctl --user start surewalk-texts` each shift (`server/start.sh` starts it and opens the dashboard).
- The texting code is read from `~/Documents/surewalk/texting/apps-script` (set `SUREWALK_GS` to change it).

## How the sync works
- The panel reads the sheet every 4 s. A ride the chat doesn't know yet is posted as `ride`; a changed cell as `upd`.
- The server folds the chat into its ride list (that's "the sheet" for the texting code). Its own sheet edits —
  Call Time when a confirmation goes out, cancels, duplicates, place fixes, ADA → No — go back as `upd` with `was`
  (the value it saw).
- The panel writes a server edit only if the cell still holds `was`. If a dispatcher changed it first, the sheet
  wins and the panel posts the sheet's value back, so both sides agree.
- New form responses that arrive with the row above's highlight (Excel copies it) have it cleared, like the dispatch
  panel does, so they aren't mistaken for cancelled rides.

## Update the snippet
`excel/build.sh` ▸ commit and push ▸ `excel/snippet.sh <that commit>` ▸ update the gist with
`excel/scriptlab/SURE-Walk-Texts.yaml`. The snippet loads `excel/dist` at that exact commit (through jsDelivr).

## Test
`test/run.sh` — fake GroupMe + fake Excel in headless Chromium + the real panel, server and texting code + a pretend
phone: auto-text → Call Time in the sheet, rider CANCEL → cancelled row, panel actions → server, undo, copied
highlights, a dispatcher edit beating a stale server edit, and no message content in the chat.
