#!/bin/bash

# Pfade definieren (Absolut)
BASE_DIR="/home/wsl/testbackend"
STARTUP_INFRA="$BASE_DIR/scripts/startup.sh"
APP_PATH="$BASE_DIR/application/app.js"
SEED_PATH="$BASE_DIR/scripts/seed.js"
LOG_FILE="$BASE_DIR/backend.log"

echo "Start all-startup Skript; 1: startup.sh 2. app.js 3. seed.js"

# 1. Infrastruktur über dein bestehendes Skript starten
echo "[1/4] Starte Blockchain-Infrastruktur (startup.sh)..."
if [ -f "$STARTUP_INFRA" ]; then
    bash "$STARTUP_INFRA"
else
    echo "FEHLER: startup.sh nicht unter $STARTUP_INFRA gefunden!"
    exit 1
fi

# 2. Port 3000 bereinigen
echo "[2/4] Bereinige Port 3000..."
fuser -k 3000/tcp > /dev/null 2>&1
sleep 10

# 3. Backend im Hintergrund starten
echo "[3/4] Starte Backend: $APP_PATH"
#Verzeichniswechsel, damit Node die relativen 'Wallet/DB'-Pfade findet
cd "$BASE_DIR/application" || exit
nohup node "app.js" > "$LOG_FILE" 2>&1 &
BACKEND_PID=$!

# 4. Warten bis Server und Blockchain-Verbindung stehen
echo -n "[4/4] Warte auf System-Bereitschaft (Health-Check)"
MAX_RETRIES=30 
COUNT=0
HEALTH_URL="http://localhost:3000/api/dev/health"

while [ $COUNT -lt $MAX_RETRIES ]; do
    # -s (silent), -o /dev/null (Output verwerfen), -w (nur HTTP Statuscode ausgeben)
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || echo "000")

    if [ "$HTTP_STATUS" -eq 200 ]; then
        echo -e "\n SYSTEM IST ONLINE (PID: $BACKEND_PID)"
        break
    elif [ "$HTTP_STATUS" -eq 503 ]; then
        echo -n "." # Server da, aber Blockchain-Init läuft noch
    else
        echo -n "?" # Server reagiert noch gar nicht (z.B. während Port-Bindung)
    fi

    COUNT=$((COUNT + 1))
    sleep 2
done

if [ $COUNT -eq $MAX_RETRIES ]; then
    echo -e "\n❌ FEHLER: Timeout beim Health-Check!"
    echo "Log-Prüfbefehl: tail -n 20 $LOG_FILE"
    exit 1
fi

echo "gRPC-Stabilisierung abgeschlossen."
sleep 10

# 5. Seeding ausführen
echo "--------------------------------------------------"
echo "Starte Daten-Seeding"
node "$SEED_PATH"
echo "System bereit für die Demo."
echo "Monitoring mit: tail -f $LOG_FILE"