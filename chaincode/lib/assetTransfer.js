'use strict';

// Wir nutzen nur die absolut notwendige Bibliothek für deterministisches JSON
const stringify = require('json-stringify-deterministic');
const { Contract } = require('fabric-contract-api');

class AssetTransfer extends Contract {

    async InitLedger(ctx) {
        console.info('============= Ledger Initialisiert ===========');
    }

    async CreateAsset(ctx, id, sensorId, temperature, humidity, supplierName) {
        const exists = await this.AssetExists(ctx, id);
        if (exists) {
            throw new Error(`Der Messpunkt ${id} existiert bereits.`);
        }

        const tempNumber = parseFloat(temperature);
        const humNumber = parseFloat(humidity);

        if (isNaN(tempNumber) || isNaN(humNumber)) {
            throw new Error('Temperatur oder Feuchtigkeit sind keine gültigen Zahlen.');
        }

        // 30-Grad-Wächter
        const isWarning = tempNumber > 30;

        // Zeitstempel sicher aus der Blockchain extrahieren
        const txTimestamp = ctx.stub.getTxTimestamp();
        const timestampDate = new Date(txTimestamp.seconds.low * 1000).toISOString();

        // Ein absolut "sauberes" Objekt erstellen
        const asset = {
            ID: String(id),
            SensorID: String(sensorId),
            Temperature: tempNumber,
            Humidity: humNumber,
            Supplier: String(supplierName),
            IsWarning: Boolean(isWarning),
            Timestamp: String(timestampDate),
            DocType: 'sensor_log'
        };

        // Wir verzichten auf sort-keys-recursive, um den TypeError zu vermeiden
        await ctx.stub.putState(id, Buffer.from(stringify(asset)));
        
        console.info(`✅ Asset ${id} erfolgreich gespeichert. Warnung: ${isWarning}`);
        return JSON.stringify(asset);
    }

    async ReadAsset(ctx, id) {
        const assetJSON = await ctx.stub.getState(id);
        if (!assetJSON || assetJSON.length === 0) {
            throw new Error(`Messpunkt ${id} nicht gefunden.`);
        }
        return assetJSON.toString();
    }

    async AssetExists(ctx, id) {
        const assetJSON = await ctx.stub.getState(id);
        return assetJSON && assetJSON.length > 0;
    }

    async GetAllAssets(ctx) {
        const allResults = [];
        const iterator = await ctx.stub.getStateByRange('', '');
        let result = await iterator.next();
        while (!result.done) {
            const strValue = Buffer.from(result.value.value.toString()).toString('utf8');
            let record;
            try {
                record = JSON.parse(strValue);
            } catch (err) {
                record = strValue;
            }
            allResults.push(record);
            result = await iterator.next();
        }
        return JSON.stringify(allResults);
    }
}

module.exports = AssetTransfer;