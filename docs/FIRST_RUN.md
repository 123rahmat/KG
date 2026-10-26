# First run

## 1. Check the download (optional, recommended)

Each package has `SHA256SUMS` and `VERIFY.txt`. Following `VERIFY.txt` confirms that every file is exactly as
packaged.

## 2. Start it

Kindgleam packages are not signed with a paid certificate, so Windows and macOS show a one-time warning the
first time. This is normal for software from small developers.

| System | What you see | What to do |
| --- | --- | --- |
| Windows | "Windows protected your PC" (SmartScreen) | Click **More info**, then **Run anyway** |
| macOS | "cannot be opened because it is from an unidentified developer" | Right-click (or Control-click) the launcher, choose **Open**, then **Open** again |
| Linux | nothing | - |

Kindgleam never asks for administrator rights, installs no services, downloads nothing and changes nothing
outside its own folder, your projects and `~/.kindgleam`.

If Microsoft Defender ever reports a Kindgleam file, check it against `SHA256SUMS` first. If it matches, it is a
false alarm; you can report it for free at Microsoft's file submission page (search for "Microsoft submit a file
for malware analysis") and choose "Incorrectly detected as malware".

Each package is built for one system. Opening the wrong one (for example the Windows package on a Mac) stops
with a message naming the package to download instead.

## 3. Set up this computer (once)

The desktop app does this itself on first start: it asks once, then creates your signing key in
`~/.kindgleam/keys` and seals the installed tools. After installing an update, use **Settings > This computer >
Seal the installed tools**. From the command line the same steps are `kindgleam keygen` and `kindgleam baseline`.

## 4. The assistant (optional)

If the installer includes the model, open the app, go to **Code**, and press **Check and seal the model** in the
assistant panel. Otherwise run the one-click helper once on a computer with internet: `tools\get-model.cmd`
(Windows, double-click), `tools/get-model.command` (macOS, double-click) or `sh tools/get-model.sh` (Linux). It
downloads the official file, checks its fingerprint and puts it in `~/.kindgleam/model`.
Then turn the assistant on in **Settings** and accept the acceptable-use terms.
