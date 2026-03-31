const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

/**async function generateQualityReport(deliveryId, auditSummary) {
    const doc = new PDFDocument();
    const fileName = `Report_${deliveryId}.pdf`;
    const filePath = path.join(__dirname, 'reports', fileName);

    // Sicherstellen, dass der Ordner existiert
    if (!fs.existsSync('./reports')) fs.mkdirSync('./reports');

    doc.pipe(fs.createWriteStream(filePath));

    // PDF Inhalt
    doc.fontSize(20).text('QUALITÄTS-ZERTIFIKAT: KÜHLKETTE', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Lieferungs-ID: ${deliveryId}`);
    doc.text(`Datum: ${new Date().toLocaleString()}`);
    doc.moveDown();
    doc.text(`Blockchain-Status: VERSIEGELT (Hyperledger Fabric)`);
    doc.text(`Integritäts-Prüfung: ${auditSummary.status}`);
    doc.moveDown();
    doc.text(`Anzahl Messpunkte (Blockchain): ${auditSummary.blockchainTotal}`);
    doc.text(`Warnungen/Alarme: ${auditSummary.anomaliesDetected}`);
    
    doc.end();
    return filePath;
}

/**
 * Generiert ein Revisionssicheres PDF-Zertifikat inkl. QR-Code
 */
async function generateDeliveryReport(deliveryId, supplier, stats, apiKey, host) {
    return new Promise(async (resolve, reject) => {
        try {
            // 1. QR-Code Daten-URL generieren (Asynchron)
            const auditUrl = `http://${host}/api/supplier/${supplier}/audit/${deliveryId}?apiKey=${apiKey}`;
            const qrCodeDataUrl = await QRCode.toDataURL(auditUrl);

            // 2. Pfade vorbereiten
            const fileName = `Report_${deliveryId}.pdf`;
            const reportsDir = path.join(__dirname, '..', 'reports');
            const filePath = path.join(reportsDir, fileName);
            
            if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);

            // 3. PDF Dokument initialisieren
            const doc = new PDFDocument({ margin: 50 });
            const writeStream = fs.createWriteStream(filePath);
            doc.pipe(writeStream);

            // --- HEADER ---
            // WICHTIG: Pfad zum Logo anpassen, da wir jetzt im Unterordner 'services' sind
            const logoPath = path.join(__dirname, '..', '..', 'basf_logo.png');
            if (fs.existsSync(logoPath)) {
                doc.image(logoPath, 50, 45, { width: 60 });
            }

            doc.fillColor('#00417F').fontSize(20).text('Lieferungsnachweiszertifikat', 120, 50, { align: 'right' });
            doc.fontSize(10).fillColor('#000').text(`Zertifikats-ID: ${deliveryId}`, { align: 'right' });
            doc.moveDown(1.5);
            doc.path('M 50 100 L 550 100').stroke('#00417F'); 

            // --- TRANSPORT SUMMARY ---
            doc.moveDown(2);
            doc.fontSize(12).fillColor('#444').text('Transport-Zusammenfassung', { underline: true });
            doc.fontSize(10).fillColor('#000').moveDown(0.5);
            doc.text(`Logistik-Partner:    ${supplier}`);
            doc.text(`Zustellung an:       BASF Zentrallager Ludwigshafen`);
            doc.text(`Start-Zeitpunkt:     ${stats.start_time || 'N/A'}`);
            doc.text(`Abschluss-Zeit:      ${new Date().toLocaleString('de-DE')}`);
            doc.text(`Status:              SICHER VERSIEGELT`);

            // --- COMPLIANCE AUDIT ---
            doc.moveDown(4);
            doc.rect(50, doc.y, 500, 25).fill('#f2f2f2');
            doc.fillColor('#00417F').text('Compliance Audit', 55, doc.y - 18);
            doc.moveDown(1.5);

            if (!stats.alarm_count || stats.alarm_count === 0) {
                doc.fillColor('green').fontSize(12).text('KONFORM: Alle Grenzwerte wurden lückenlos eingehalten.', { align: 'center' });
            } else {
                doc.fillColor('red').fontSize(12).text(`DISKREPANZ: ${stats.alarm_count} Grenzwert-Überschreitungen registriert.`, { align: 'center' });
            }

            // --- QR-CODE & BLOCKCHAIN INFO ---
            doc.moveDown(3);
            const qrY = doc.y;
            doc.fillColor('#000').fontSize(12).text('Digitales Audit-Verfahren', 50, qrY, { underline: true });
            doc.fontSize(9).text('Dieser Bericht ist durch einen kryptografischen Hash auf dem Hyperledger Fabric Ledger geschützt. Scannen Sie den QR-Code für die vollständige Historie.', 50, qrY + 20, { width: 320 });
            
            doc.image(qrCodeDataUrl, 400, qrY, { width: 100 });

            // --- FOOTER ---
            doc.fontSize(8).fillColor('#999').text('BASF Digital Logistics Framework - Automatisierte Blockchain-Verifizierung - Ohne Unterschrift gültig.', 50, 700, { align: 'center' });

            doc.end();

            writeStream.on('finish', () => {
                resolve({ filePath, fileName });
            });

            writeStream.on('error', (err) => {
                reject(err);
            });

        } catch (error) {
            reject(error);
        }
    });
}

module.exports = { generateDeliveryReport };