SURE Walk Texts - Windows
=========================

Runs the texting server and the iPhone bridge on this laptop. Installs nothing, needs no admin.
The Excel texts panel (Script Lab) works exactly as before: it talks to this server through the GroupMe sync chat.

BEFORE THE FIRST START
  - Only ONE computer may run texting at a time. Stop the texting server and phone bridge on the
    other dispatch PC first (two would fight over the iPhone and the GroupMe sync chat).
  - The iPhone is paired with this laptop and "Show Notifications" is ON for it
    (iPhone: Settings > Bluetooth > (i) next to this laptop).

START       Double-click START-TEXTING.cmd. The dashboard opens at http://127.0.0.1:8787
            First time only: click the GroupMe pill on the dashboard and pick the sync chat
            (same chat as the Excel panel). Texting starts with Auto-text OFF - turn it on in the bar.
STOP        Double-click STOP-TEXTING.cmd.
AT LOGIN    Double-click START-AT-LOGIN.cmd to turn starting at login on or off.
TEST        Double-click TEST-BRIDGE.cmd to check the bridge on this laptop (pretend phone; safe any time).

Where things are (all on this laptop only, never uploaded):
  %LOCALAPPDATA%\surewalk-texts     server data: settings, message log (transcripts), server.log
  %LOCALAPPDATA%\surewalk-bridge    bridge state and bridge.log (no message text or numbers in the log)

Not supported on Windows: the dashboard's "call" button (call from the iPhone instead).
