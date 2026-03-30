#!/bin/bash

# Pfade absolut definieren
BASE_DIR="/home/wsl/testbackend"
INFRA_PATH="$BASE_DIR/infrastructure"

# 1. Umgebungs-Setup (Peer-CLI Konfiguration)
export PATH=${BASE_DIR}/bin:$PATH
export FABRIC_CFG_PATH=${INFRA_PATH}/config/
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ROOTCERT_FILE=${INFRA_PATH}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
export CORE_PEER_MSPCONFIGPATH=${INFRA_PATH}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
export CORE_PEER_ADDRESS=localhost:7051

echo "--- ⛓️  BLOCKCHAIN LEDGER ABFRAGE ---"

if [ -z "$1" ]; then
    echo "Nutze: ./check-ledger.sh [GetAllAssets | GetBySupplier]"
    echo "Standard: Zeige alle Assets..."
    peer chaincode query -C mychannel -n basic -c '{"Args":["GetAllAssets"]}' | jq .
else
    # Beispiel für gezielte Abfrage eines Suppliers: ./check-ledger.sh Logistik_Pro_A
    peer chaincode query -C mychannel -n basic -c '{"Args":["GetAssetsBySupplier", "'$1'"]}' | jq .
fi
