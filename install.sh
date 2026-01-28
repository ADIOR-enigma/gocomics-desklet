#!/bin/bash

SOURCE="./gocomics@adior"
DEST="$HOME/.local/share/cinnamon/desklets"

echo "Starting desklet move process..."

if [ ! -d "$SOURCE" ]; then
    echo "ERROR: Source folder not found: $SOURCE"
    exit 1
fi

mkdir -p "$DEST"

if [ -d "$DEST/gocomics@adior" ]; then
    echo "ERROR: Destination already contains gocomics@adior"
    echo "Remove it first or rename the folder."
    exit 1
fi

mv "$SOURCE" "$DEST"

#Verify
if [ -d "$DEST/gocomics@adior" ]; then
    echo "SUCCESS: Desklet moved successfully!"
else
    echo "ERROR: Move failed!"
    exit 1
fi
