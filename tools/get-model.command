#!/bin/sh
# macOS: double-click in Finder to download the Kindgleam assistant model for this user.
cd "$(dirname "$0")"
if [ -w ../model ]; then sh ./get-model.sh; else echo "Kindgleam is installed for all users; enter your password to continue."; sudo sh ./get-model.sh; fi
echo; echo "You can close this window."
