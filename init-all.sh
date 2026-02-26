#!/bin/bash

# Abbruch bei Fehlern
set -e

# Pfade definieren (Relativ zum Skript-Standort)
PROJECT_ROOT=$(pwd)
INFRA_PATH=$PROJECT_ROOT/infrastructure
APP_WALLET=$PROJECT_ROOT/application/wallet/org1-admin

echo "--------------------------------------------------"
echo "🚀 STARTE HYPERLEDGER FABRIC AUTOMATION"
echo "--------------------------------------------------"

# 1. Altes Netzwerk stoppen
echo "🧹 Räume altes Netzwerk auf..."
cd $INFRA_PATH
./network.sh down

# 2. Netzwerk neu starten (Channel + Certificate Authority)
echo "🌐 Fahre Docker-Container hoch & erstelle Channel..."
./network.sh up createChannel -c mychannel -ca

# 3. Chaincode deployen
# Hinweis: Wir nutzen den Standard-Pfad aus den fabric-samples
echo "📦 Installiere Smart Contract (Chaincode)..."
./network.sh deployCC -ccn basic -ccp ../chaincode/ -ccl javascript

# 4. Wallet-Ordner für das Backend vorbereiten
echo "🔐 Synchronisiere Zertifikate mit dem Application-Wallet..."
mkdir -p $APP_WALLET/msp/signcerts
mkdir -p $APP_WALLET/msp/keystore
mkdir -p $APP_WALLET/tls

# 5. Zertifikate kopieren
cp organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt $APP_WALLET/tls/
cp organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/signcerts/cert.pem $APP_WALLET/msp/signcerts/
cp organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/keystore/* $APP_WALLET/msp/keystore/

echo "⏳ Warte darauf, dass der Chaincode-Container hochfährt (15s)..."
sleep 15

echo "🔍 Führe Health-Check aus..."
if docker ps | grep -q "dev-peer0.org1.example.com-basic"; then
    echo "✅ Chaincode-Container läuft!"
else
    echo "⚠️ Warnung: Chaincode-Container wurde nicht gefunden. "
    echo "   Prüfe die Logs mit: docker logs peer0.org1.example.com"
fi

# 6. Test-Abfrage (Optional, aber genial zur Verifizierung)
echo "📡 Teste Ledger-Verbindung..."
export PATH=${PWD}/infrastructure/bin:$PATH
export FABRIC_CFG_PATH=$PWD/infrastructure/config/

if peer chaincode query -C mychannel -n basic -c '{"Args":["GetAllAssets"]}' > /dev/null 2>&1; then
    echo "✅ Ledger ist bereit für Anfragen!"
else
    echo "❌ Ledger antwortet noch nicht. Starte das Backend trotzdem und warte kurz."
fi

echo "--------------------------------------------------"
echo "✅ SETUP ERFOLGREICH ABGESCHLOSSEN"
echo "👉 Starte dein Backend mit: node application/app.js"
echo "--------------------------------------------------"