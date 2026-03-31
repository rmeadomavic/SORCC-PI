/* SORCC-PI Dashboard — Preflight Tab Controller */

(function () {
    "use strict";

    var autoRefreshTimer = null;

    // Map API check names → HTML element ID prefixes
    var checkMapping = {
        // Hardware
        "SDR (RTL2832U)":    { indicator: "chk-sdr",         detail: "chk-sdr-detail",         cardStatus: "hw-status" },
        "Serial Devices":    { indicator: "chk-serial",      detail: "chk-serial-detail",      cardStatus: "hw-status" },
        "Bluetooth (hci0)":  { indicator: "chk-bt-adapter",  detail: "chk-bt-adapter-detail",  cardStatus: "hw-status" },
        "PiSugar Battery":   { indicator: "chk-battery",     detail: "chk-battery-detail",     cardStatus: "hw-status" },
        // Services
        "Kismet":            { indicator: "chk-kismet",      detail: "chk-kismet-detail",      cardStatus: "svc-status" },
        "sorcc-dashboard":   { indicator: "chk-dashboard",   detail: "chk-dashboard-detail",   cardStatus: "svc-status" },
        "sorcc-boot":        { indicator: "chk-boot-svc",    detail: "chk-boot-svc-detail",    cardStatus: "svc-status" },
        "avahi-daemon":      { indicator: "chk-avahi",       detail: "chk-avahi-detail",       cardStatus: "svc-status" },
        // Network
        "LTE Modem":         { indicator: "chk-lte",         detail: "chk-lte-detail",         cardStatus: "net-status" },
        "Internet":          { indicator: "chk-internet",    detail: "chk-internet-detail",    cardStatus: "net-status" },
        "Tailscale":         { indicator: "chk-tailscale",   detail: "chk-tailscale-detail",   cardStatus: "net-status" },
        "WiFi (wlan0)":      { indicator: "chk-wifi",        detail: "chk-wifi-detail",        cardStatus: "net-status" },
        "GPS Fix":           { indicator: "chk-gps-fix",    detail: "chk-gps-fix-detail",    cardStatus: "net-status" },
        // Config
        "Kismet Config":       { indicator: "chk-kismet-cfg",    detail: "chk-kismet-cfg-detail",    cardStatus: "cfg-status" },
        "Kismet Credentials":  { indicator: "chk-kismet-creds", detail: "chk-kismet-creds-detail", cardStatus: "cfg-status" },
        "Source Config":       { indicator: "chk-source-cfg",   detail: "chk-source-cfg-detail",   cardStatus: "cfg-status" },
        "Disk Space":          { indicator: "chk-disk-space",   detail: "chk-disk-space-detail",   cardStatus: "cfg-status" },
        "Time Sync":           { indicator: "chk-time-sync",    detail: "chk-time-sync-detail",    cardStatus: "cfg-status" },
    };

    // Which card-status elements belong to which category
    var categoryCards = {
        "hw-status":  "hardware",
        "svc-status": "services",
        "net-status": "network",
        "cfg-status": "config"
    };

    function statusClass(st) {
        st = (st || "").toLowerCase();
        if (st === "pass" || st === "ok" || st === "passed") return "pass";
        if (st === "warn" || st === "warning") return "warn";
        return "fail";
    }

    function statusSymbol(cls) {
        if (cls === "pass") return "\u2713";
        if (cls === "warn") return "!";
        return "\u2717";
    }

    // ── Run Checks ──────────────────────────────────────────

    function runChecks() {
        var indicator = document.getElementById("preflight-refresh-indicator");
        if (indicator) indicator.style.display = "";

        // Set all indicators to "running" state
        Object.keys(checkMapping).forEach(function (name) {
            var m = checkMapping[name];
            var el = document.getElementById(m.indicator);
            var det = document.getElementById(m.detail);
            if (el) {
                el.className = "check-indicator pending";
                el.textContent = "...";
            }
            if (det) det.textContent = "Checking...";
        });

        fetch("/api/preflight", {
            signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined
        })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .then(function (data) {
                populateResults(data);
                var ts = document.getElementById("preflight-timestamp");
                if (ts) ts.textContent = "Last checked: " + new Date().toLocaleTimeString();
                if (indicator) indicator.style.display = "none";
            })
            .catch(function (err) {
                window.SORCC.showToast("Preflight check failed: " + err.message, "error");
                if (indicator) indicator.style.display = "none";
                // Reset stuck "Checking..." indicators to show failure
                Object.keys(checkMapping).forEach(function (name) {
                    var m = checkMapping[name];
                    var el = document.getElementById(m.indicator);
                    var det = document.getElementById(m.detail);
                    if (el && el.textContent === "...") {
                        el.className = "check-indicator fail";
                        el.textContent = "?";
                    }
                    if (det && det.textContent === "Checking...") {
                        det.textContent = "Connection lost";
                    }
                });
            });
    }

    // ── Populate Results into static HTML ───────────────────

    function populateResults(data) {
        var checks = data.checks || [];

        // Track category worst-status
        var categoryWorst = {};

        // Optional hardware — downgrade WARN to info/gray for non-critical components
        var optionalChecks = ["SDR (RTL2832U)", "PiSugar Battery"];

        checks.forEach(function (check) {
            var m = checkMapping[check.name];
            if (!m) return;

            var cls = statusClass(check.status);
            // Downgrade optional hardware warnings to neutral "info" state
            var isOptional = optionalChecks.indexOf(check.name) !== -1;
            if (isOptional && cls === "warn") cls = "info";
            var sym = cls === "info" ? "\u2014" : statusSymbol(cls);

            // Update indicator dot
            var el = document.getElementById(m.indicator);
            if (el) {
                el.className = "check-indicator " + cls;
                el.textContent = sym;
            }

            // Update detail text
            var det = document.getElementById(m.detail);
            if (det) det.textContent = check.detail || "";

            // Track worst status per card
            var cardId = m.cardStatus;
            if (!categoryWorst[cardId]) categoryWorst[cardId] = "pass";
            if (cls === "fail") categoryWorst[cardId] = "fail";
            else if (cls === "warn" && categoryWorst[cardId] !== "fail") categoryWorst[cardId] = "warn";
        });

        // Update category card status badges
        Object.keys(categoryWorst).forEach(function (cardId) {
            var el = document.getElementById(cardId);
            if (!el) return;
            var cls = categoryWorst[cardId];
            el.className = "preflight-card-status " + cls;
            el.textContent = cls === "pass" ? "PASS" : cls === "warn" ? "WARN" : "FAIL";
        });

        // Update overall banner
        var banner = document.getElementById("preflight-banner");
        var bannerText = document.getElementById("preflight-status-text");
        var bannerDetail = document.getElementById("preflight-status-detail");
        var overall = (data.status || "fail").toLowerCase();
        var overallCls = statusClass(overall);

        // Smarter banner: green if ≥80%, amber if ≥60%, red below
        var total = checks.length;
        var passed = checks.filter(function (c) { return statusClass(c.status) === "pass"; }).length;
        var failed = checks.filter(function (c) { return statusClass(c.status) === "fail"; }).length;
        var warned = total - passed - failed;
        var pct = total > 0 ? passed / total : 0;

        var bannerCls = failed > 0 ? "fail" : pct >= 0.8 ? "pass" : "warn";
        if (banner) banner.className = "preflight-banner status-" + bannerCls;
        if (bannerText) {
            if (bannerCls === "pass") bannerText.textContent = failed === 0 && warned === 0 ? "ALL CLEAR" : "READY";
            else if (bannerCls === "warn") bannerText.textContent = "READY \u2014 " + warned + " optional";
            else bannerText.textContent = "NOT READY \u2014 " + failed + " failed";
        }
        if (bannerDetail) {
            bannerDetail.textContent = passed + " passed" + (warned > 0 ? " \u00B7 " + warned + " optional offline" : "") + (failed > 0 ? " \u00B7 " + failed + " failed" : "");
        }
    }

    // ── Init ────────────────────────────────────────────────

    document.addEventListener("DOMContentLoaded", function () {
        // Bind run button (HTML id: btn-run-preflight)
        var runBtn = document.getElementById("btn-run-preflight");
        if (runBtn) runBtn.addEventListener("click", runChecks);

        // Auto-refresh toggle
        var toggle = document.getElementById("preflight-auto-refresh");
        if (toggle) {
            toggle.addEventListener("change", function () {
                if (this.checked) {
                    runChecks();
                    autoRefreshTimer = setInterval(runChecks, 10000);
                } else {
                    if (autoRefreshTimer) {
                        clearInterval(autoRefreshTimer);
                        autoRefreshTimer = null;
                    }
                }
            });
        }

        // Run checks when preflight tab is activated
        document.querySelectorAll(".tab").forEach(function (tab) {
            tab.addEventListener("click", function () {
                if (this.dataset.tab === "preflight") {
                    runChecks();
                }
                // Stop auto-refresh when leaving preflight tab
                if (this.dataset.tab !== "preflight" && autoRefreshTimer) {
                    clearInterval(autoRefreshTimer);
                    autoRefreshTimer = null;
                    if (toggle) toggle.checked = false;
                }
            });
        });
    });

})();
