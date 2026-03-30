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

        fetch("/api/preflight")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                populateResults(data);
                var ts = document.getElementById("preflight-timestamp");
                if (ts) ts.textContent = "Last checked: " + new Date().toLocaleTimeString();
                if (indicator) indicator.style.display = "none";
            })
            .catch(function (err) {
                window.SORCC.showToast("Preflight check failed: " + err.message, "error");
                if (indicator) indicator.style.display = "none";
            });
    }

    // ── Populate Results into static HTML ───────────────────

    function populateResults(data) {
        var checks = data.checks || [];

        // Track category worst-status
        var categoryWorst = {};

        checks.forEach(function (check) {
            var m = checkMapping[check.name];
            if (!m) return;

            var cls = statusClass(check.status);
            var sym = statusSymbol(cls);

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

        if (banner) banner.className = "preflight-banner status-" + overallCls;
        if (bannerText) {
            if (overallCls === "pass") bannerText.textContent = "READY";
            else if (overallCls === "warn") bannerText.textContent = "WARNINGS";
            else bannerText.textContent = "NOT READY";
        }
        if (bannerDetail) {
            var total = checks.length;
            var passed = checks.filter(function (c) { return statusClass(c.status) === "pass"; }).length;
            bannerDetail.textContent = passed + " / " + total + " checks passed";
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
