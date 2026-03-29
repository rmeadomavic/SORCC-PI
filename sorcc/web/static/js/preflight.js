/* SORCC-PI Dashboard — Preflight Tab Controller */

(function () {
    "use strict";

    // ── State ───────────────────────────────────────────────
    var autoRefreshTimer = null;
    var lastResults = null;

    // Category display order and icons
    var categoryMeta = {
        hardware: { label: "Hardware", icon: "&#9881;" },
        services: { label: "Services", icon: "&#9654;" },
        network:  { label: "Network",  icon: "&#127760;" },
        config:   { label: "Config",   icon: "&#9881;" }
    };

    // Status icons
    var statusIcons = {
        pass: '<span class="check-icon pass">&#10003;</span>',
        warn: '<span class="check-icon warn">&#9888;</span>',
        fail: '<span class="check-icon fail">&#10007;</span>'
    };

    // ── Run Checks ──────────────────────────────────────────

    function runChecks() {
        var container = document.getElementById("preflight-results");
        var banner = document.getElementById("preflight-banner");
        var timestamp = document.getElementById("preflight-timestamp");

        if (container) container.innerHTML = '<div class="loading">Running preflight checks...</div>';

        fetch("/api/preflight")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                lastResults = data;
                renderResults(data);
                if (timestamp) {
                    var now = new Date();
                    timestamp.textContent = "Last checked: " + now.toLocaleTimeString();
                }
            })
            .catch(function (err) {
                if (container) {
                    container.innerHTML = '<div class="loading">Preflight check failed: ' +
                        window.SORCC.escapeHtml(err.message) + '</div>';
                }
                window.SORCC.showToast("Preflight check failed: " + err.message, "error");
            });
    }

    // ── Render Results ──────────────────────────────────────

    function renderResults(data) {
        var container = document.getElementById("preflight-results");
        var banner = document.getElementById("preflight-banner");
        if (!container) return;

        var checks = data.checks || data.results || [];
        if (!Array.isArray(checks)) {
            // If data is an object with category keys
            var flatChecks = [];
            Object.keys(data).forEach(function (key) {
                if (Array.isArray(data[key])) {
                    data[key].forEach(function (check) {
                        check.category = check.category || key;
                        flatChecks.push(check);
                    });
                }
            });
            if (flatChecks.length > 0) checks = flatChecks;
        }

        // Group by category
        var groups = {};
        var hasWarn = false;
        var hasFail = false;

        checks.forEach(function (check) {
            var cat = (check.category || "other").toLowerCase();
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(check);

            var st = (check.status || check.result || "").toLowerCase();
            if (st === "warn" || st === "warning") hasWarn = true;
            if (st === "fail" || st === "failed" || st === "error") hasFail = true;
        });

        // Overall status banner
        if (banner) {
            if (hasFail) {
                banner.className = "preflight-banner fail";
                banner.textContent = "NOT READY";
            } else if (hasWarn) {
                banner.className = "preflight-banner warn";
                banner.textContent = "WARNINGS";
            } else {
                banner.className = "preflight-banner pass";
                banner.textContent = "READY";
            }
            banner.style.display = "";
        }

        // Render category cards
        var html = "";
        var categoryOrder = ["hardware", "services", "network", "config"];

        // Add any categories not in the predefined order
        Object.keys(groups).forEach(function (cat) {
            if (categoryOrder.indexOf(cat) === -1) {
                categoryOrder.push(cat);
            }
        });

        categoryOrder.forEach(function (cat) {
            if (!groups[cat]) return;

            var meta = categoryMeta[cat] || { label: cat.charAt(0).toUpperCase() + cat.slice(1), icon: "&#9679;" };

            html += '<div class="preflight-category">';
            html += '  <div class="preflight-category-header">';
            html += '    <span class="category-icon">' + meta.icon + '</span>';
            html += '    <span class="category-label">' + window.SORCC.escapeHtml(meta.label) + '</span>';
            html += '  </div>';
            html += '  <div class="preflight-checks">';

            groups[cat].forEach(function (check) {
                var st = (check.status || check.result || "unknown").toLowerCase();
                var iconKey = "fail";
                if (st === "pass" || st === "ok" || st === "passed") iconKey = "pass";
                else if (st === "warn" || st === "warning") iconKey = "warn";

                var icon = statusIcons[iconKey] || statusIcons.fail;

                html += '<div class="preflight-check ' + iconKey + '">';
                html += '  ' + icon;
                html += '  <span class="check-name">' + window.SORCC.escapeHtml(check.name || check.check || "Unknown") + '</span>';
                if (check.message || check.detail) {
                    html += '  <span class="check-detail">' + window.SORCC.escapeHtml(check.message || check.detail) + '</span>';
                }
                html += '</div>';
            });

            html += '  </div>';
            html += '</div>';
        });

        container.innerHTML = html;
    }

    // ── Auto-refresh ────────────────────────────────────────

    function initAutoRefresh() {
        var toggle = document.getElementById("preflight-auto-refresh");
        if (!toggle) return;

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

    // ── Init ────────────────────────────────────────────────

    document.addEventListener("DOMContentLoaded", function () {
        initAutoRefresh();

        var runBtn = document.getElementById("preflight-run");
        if (runBtn) {
            runBtn.addEventListener("click", runChecks);
        }

        // Run checks when preflight tab is activated
        document.querySelectorAll(".main-tab").forEach(function (tab) {
            tab.addEventListener("click", function () {
                if (this.dataset.tab === "preflight") {
                    runChecks();
                }
                // Stop auto-refresh when leaving preflight tab
                if (this.dataset.tab !== "preflight" && autoRefreshTimer) {
                    clearInterval(autoRefreshTimer);
                    autoRefreshTimer = null;
                    var toggle = document.getElementById("preflight-auto-refresh");
                    if (toggle) toggle.checked = false;
                }
            });
        });
    });

})();
