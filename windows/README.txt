SURE Walk Texts - Windows
=========================

Runs the texting server and the iPhone bridge on this laptop. Installs nothing system-wide, needs no admin.
The Excel texts panel (Script Lab) talks to this server directly on the laptop (no GroupMe needed; ride data never leaves this computer).

BEFORE THE FIRST START
  - Only ONE computer may run texting at a time. Stop the texting server and phone bridge on the
    other dispatch PC first (two would fight over the iPhone).
  - The iPhone is paired with this laptop and "Show Notifications" is ON for it
    (iPhone: Settings > Bluetooth > (i) next to this laptop).

INSTALL     Double-click INSTALL.cmd. It copies the app to %LOCALAPPDATA%\Programs\SURE Walk Texts (just for you,
            no admin) and adds Start menu shortcuts: SURE Walk Texts, Stop, Check for updates, Test a call,
            Test the phone bridge, Start at login, Uninstall. After that this downloaded folder can be deleted.
            (You can also run everything straight from this folder without installing.)
START       Start menu > SURE Walk Texts (or START-TEXTING.cmd). The dashboard opens at http://127.0.0.1:8787
            First time only: click the Sync pill on the dashboard and copy the laptop key, then in the Excel
            panel click Connect > This laptop and paste it. Texting starts with Auto-text OFF - turn it on in the bar.
STOP        Start menu > Stop SURE Walk Texts (or STOP-TEXTING.cmd).
UPDATES     When it starts, it checks GitHub for a newer release and asks in a popup (30 s, no answer = not now).
            Or: Start menu > Check for updates (UPDATE.cmd). Updates keep your settings and message log.
CALLS       The dashboard's Call button makes the iPhone dial the rider. The call and its audio stay on the
            iPhone - pick it up there. Test it: Start menu > Test a call (TEST-CALL.cmd) dials a number you type.
TEST        Test the phone bridge (TEST-BRIDGE.cmd) checks the bridge with a pretend phone; safe any time.

Where things are (all on this laptop only, never uploaded):
  %LOCALAPPDATA%\surewalk-texts     server data: settings, message log (transcripts), server.log
  %LOCALAPPDATA%\surewalk-bridge    bridge state and bridge.log (no message text or numbers in the log)
