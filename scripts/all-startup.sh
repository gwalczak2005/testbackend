#!/bin/bash

# Pfade definieren (Absolut)
BASE_DIR="/home/wsl/testbackend"
APP_PATH="$BASE_DIR/application/app.js"
SEED_PATH="$BASE_DIR/scripts/seed.js"
LOG_FILE="$BASE_DIR/backend.log"

echo "--------------------------------------------------"
echo "🚀 Starte IoT-System Setup"
echo "--------------------------------------------------"

# 1. Alte Prozesse sauber beenden
echo "[1/4] Bereinige Port 3000..."
fuser -k 3000/tcp > /dev/null 2>&1
sleep 1

# 2. Backend im Hintergrund starten
echo "[2/4] Starte Backend: $APP_PATH"
# Wir nutzen nohup, damit der Prozess weiterläuft, wenn das Skript endet
nohup node "$APP_PATH" > "$LOG_FILE" 2>&1 &
BACKEND_PID=$!

# 3. Warten bis der Server wirklich ANTWORTET
echo -n "[3/4] Warte auf Server-Bereitschaft"
MAX_RETRIES=20
COUNT=0

# Loop: Prüfe alle 2 Sekunden, ob der Port 3000 antwortet
while ! curl -sf http://127.0.0.1:3000/api/dev/health > /dev/null; do
    echo -n "."
    sleep 2
    COUNT=$((COUNT+1))
    if [ $COUNT -ge $MAX_RETRIES ]; then
        echo -e "\n❌ FEHLER: Blockchain nicht erreichbar! Prüfe die Logs mit: tail -n 20 $LOG_FILE"
        kill $BACKEND_PID 2>/dev/null
        exit 1
    fi
done

echo -e "\n✅ Backend ist ONLINE (PID: $BACKEND_PID)"

# 4. Seeding ausführen
echo "[4/4] Starte Seeding..."
node "$SEED_PATH"

echo "--------------------------------------------------"
echo "✅ ALLES ERLEDIGT!"