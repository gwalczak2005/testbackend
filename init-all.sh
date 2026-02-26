#!/bin/bash

# Pfade definieren
PROJECT_ROOT=$HOME/testbackend
INFRA_PATH=$PROJECT_ROOT/infrastructure
APP_WALLET=$PROJECT_ROOT/application/wallet/org1-admin

echo "🧼 STARTE RADIKALEN REINIGUNGSPROZESS..."

# 1. Infrastruktur stoppen
cd $INFRA_PATH
./network.sh down

# 2. Docker komplett aufräumen
echo "🗑️  Lösche verwaiste Docker-Container und Volumes..."
docker rm -f $(docker ps -aq) 2>/dev/null
docker volume prune -f
docker network prune -f

# 3. Wallet zurücksetzen
echo "🔐 Lösche altes Wallet..."
rm -rf $APP_WALLET/*

# 4. Netzwerk neu starten
echo "🚀 Starte Netzwerk und erstelle Channel..."
./network.sh up createChannel -c mychannel -ca

# 5. Chaincode deployen (Lokaler Pfad)
echo "📦 Installiere Smart Contract..."
./network.sh deployCC -ccn basic -ccp ../chaincode -ccl javascript

# 6. Zertifikate für das Backend synchronisieren
echo "🔑 Synchronisiere neue Zertifikate..."
mkdir -p $APP_WALLET/msp/signcerts
mkdir -p $APP_WALLET/msp/keystore
mkdir -p $APP_WALLET/tls

cp organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt $APP_WALLET/tls/
cp organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/signcerts/cert.pem $APP_WALLET/msp/signcerts/
cp organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/keystore/* $APP_WALLET/msp/keystore/

echo "⏳ Kurze Pause für den Chaincode-Container (15s)..."
sleep 15

echo "--------------------------------------------------"
echo "✅ SYSTEM IST JETZT ABSOLUT SAUBER UND BEREIT"
echo "👉 Starte Backend mit: node $PROJECT_ROOT/application/app.js"
echo "--------------------------------------------------"