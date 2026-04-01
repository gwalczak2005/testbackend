// Authentifikation-Middleware
const { db } = require('./DatabaseService');
const API_KEYS = {                                                          //Schlüssel-Datenbank
    "DEIN_ADMIN_MASTER_KEY": { role: "ADMIN", owner: "Großunternehmen" },
    "KEY_SUPPLIER_A": { role: "SUPPLIER", owner: "Supplier_A" }
};

const supplierAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    const requestedSupplier = req.params.supplier;

    if (!apiKey) {
        return res.status(401).json({ error: "Kein API-Key bereitgestellt." });
    }

    db.get(`SELECT * FROM api_users WHERE api_key = ?`, [apiKey], (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: "Ungültiger Key." });
        }

        // --- VERBESSERTER CHECK ---
        const isAdmin = user.role === "ADMIN";

        // 1. Wenn ein Admin anklopft: Sofort durchlassen
        if (isAdmin) {
            req.user = user;
            return next();
            
        }

        // 2. Wenn ein Supplier anklopft:
        if (user.role === "SUPPLIER") {
            // A) Fall: In der URL steht ein Name (z.B. /api/history/Lieferant1)
            //    Dann MUSS dieser Name exakt dem Owner des Keys entsprechen.
            if (requestedSupplier && requestedSupplier !== user.owner) {
                console.warn(`🔒 ALARM: ${user.owner} wollte auf fremde Daten von [${requestedSupplier}] zugreifen!`);
                return res.status(403).json({ error: "Zugriff verweigert", message: "Du darfst nur deine eigenen Daten sehen." });
            }

            // B) Fall: Keine URL-Parameter (z.B. /api/supplier/onboard)
            //    Hier lassen wir ihn durch, da die Route selbst (z.B. Onboarding) 
            //    im nächsten Schritt sowieso user.owner zur Erstellung nutzt.
            req.user = user;
            return next();
        }

        // 3. Fallback: Unbekannte Rolle
        return res.status(403).json({ error: "Zugriff verweigert", message: "Rolle nicht autorisiert." });
    });
};

module.exports = supplierAuth