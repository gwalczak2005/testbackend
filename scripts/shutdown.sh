#!/bin/bash

# Pfade definieren
PROJECT_ROOT=$HOME/testbackend
INFRA_PATH=$PROJECT_ROOT/infrastructure
APP_WALLET=$PROJECT_ROOT/application/wallet/org1-admin

echo "SHUTDOWN STARTET"

#Zusatz: sensor_data.db entfernen
echo "Lösche SQL sensor_data.db"
rm -f ./application/sensor_data.db

# 1. Hyperledger Fabric Netzwerk stoppen
if [ -d "$INFRA_PATH" ]; then
    echo "Hyperledger wird gestoppt"
    cd $INFRA_PATH
    ./network.sh down
else
    echo "Infrastruktur-Ordner nicht gefunden!"
fi

# 2. Radikale Docker-Reinigung (löscht alle Rückstände)
echo "Entferne Docker-Container, Volumes, Netzwerke"
docker rm -f $(docker ps -aq) 2>/dev/null
docker volume prune -f
docker network prune -f

# 3. Lokales Wallet leeren
# Das ist wichtig, da die Zertifikate morgen nicht mehr gültig wären.
if [ -d "$APP_WALLET" ]; then
    echo "Leere lokales Application-Wallet..."
    rm -rf $APP_WALLET/*
fi

# 4. Optional: Backend-Prozesse killen
#echo "Beende eventuell laufende Node.js Prozesse..."
#pkill -9 node 2>/dev/null

echo "NETZWERK HERUNTERGEFAHREN"