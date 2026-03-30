#!/bin/bash

# Pfade definieren (Absolut)
BASE_DIR="/home/wsl/testbackend"
STARTUP_INFRA="$BASE_DIR/scripts/startup.sh"
APP_PATH="$BASE_DIR/application/app.js"
SEED_PATH="$BASE_DIR/scripts/seed.js"
LOG_FILE="$BASE_DIR/backend.log"

echo "--------------------------------------------------"
echo "Start all-startup Skript; 1: startup.sh 2. app.js 3. seed.js"
echo "--------------------------------------------------"

# 1. Infrastruktur über dein bestehendes Skript starten
echo "[1/4] Starte Blockchain-Infrastruktur (startup.sh)..."
if [ -f "$STARTUP_INFRA" ]; then
    bash "$STARTUP_INFRA"
else
    echo "FEHLER: startup.sh nicht unter $STARTUP_INFRA gefunden!"
    exit 1
fi

# 2. Port 3000 bereinigen (Sicherheitshalber)
echo "[2/4] Bereinige Port 3000..."
fuser -k 3000/tcp > /dev/null 2>&1
sleep 10

# 3. Backend im Hintergrund starten
echo "[3/4] Starte Backend: $APP_PATH"
# Wir wechseln ins Verzeichnis, damit Node relative Pfade (Wallet/DB) korrekt findet
cd "$BASE_DIR/application" || exit
nohup node "app.js" > "$LOG_FILE" 2>&1 &
BACKEND_PID=$!

# 4. Warten bis der Server & die Blockchain-Verbindung stehen
echo -n "[4/4] Warte auf System-Bereitschaft (Health-Check)"
MAX_RETRIES=30 
COUNT=0

# Wichtig: Wir prüfen auf den String "ready", den deine app.js nach initBlockchain() sendet
while ! curl -sf http://127.0.0.1:3000/api/dev/health | grep -q "ready"; do
    echo -n "."
    sleep 3
    COUNT=$((COUNT+1))
    if [ $COUNT -ge $MAX_RETRIES ]; then
        echo -e "\n FEHLER: Timeout! Backend konnte keine Verbindung zur Blockchain aufbauen."
        echo "Letzte Zeilen aus $LOG_FILE:"
        tail -n 20 "$LOG_FILE"
        kill $BACKEND_PID 2>/dev/null
        exit 1
    fi
done

echo -e "\n System ist ONLINE (PID: $BACKEND_PID)"
echo "gRPC-Stabilisierung"
sleep 10

# 5. Seeding ausführen
echo "--------------------------------------------------"
echo "Starte Daten-Seeding (Szenarien für BASF)..."
node "$SEED_PATH"
echo "System bereit für die Demo."
echo "Monitoring mit: tail -f $LOG_FILE"