/* SORCC-PI Dashboard — Main SPA Controller */

(function () {
    "use strict";

    // ── State ───────────────────────────────────────────────
    var activeTab = "operations";

    // ── Utility Functions ───────────────────────────────────

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    function signalToPercent(dbm) {
        // Map -100 dBm -> 0%, -20 dBm -> 100%
        var pct = ((dbm + 100) / 80) * 100;
        return Math.max(0, Math.min(100, pct));
    }

    // ── Toast Notifications ─────────────────────────────────

    function showToast(message, type) {
        type = type || "info";
        var container = document.getElementById("toast-container");
        if (!container) {
            container = document.createElement("div");
            container.id = "toast-container";
            container.style.cssText = "position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;";
            document.body.appendChild(container);
        }

        var colors = {
            success: { bg: "#2e7d32", border: "#4caf50" },
            info:    { bg: "#1565c0", border: "#42a5f5" },
            error:   { bg: "#c62828", border: "#ef5350" }
        };
        var c = colors[type] || colors.info;

        var toast = document.createElement("div");
        toast.className = "toast toast-" + type;
        toast.style.cssText = "background:" + c.bg + ";border:1px solid " + c.border +
            ";color:#fff;padding:12px 20px;border-radius:6px;font-size:14px;" +
            "box-shadow:0 4px 12px rgba(0,0,0,0.4);opacity:1;transition:opacity 0.3s ease;" +
            "max-width:360px;word-wrap:break-word;";
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(function () {
            toast.style.opacity = "0";
            setTimeout(function () {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 300);
        }, 3000);
    }

    // ── Tab Navigation ──────────────────────────────────────

    function initTabs() {
        document.querySelectorAll(".main-tab").forEach(function (tab) {
            tab.addEventListener("click", function () {
                var target = this.dataset.tab;
                document.querySelectorAll(".main-tab").forEach(function (t) {
                    t.classList.remove("active");
                });
                document.querySelectorAll(".main-tab-content").forEach(function (tc) {
                    tc.classList.remove("active");
                });
                this.classList.add("active");
                var panel = document.getElementById("tab-" + target);
                if (panel) panel.classList.add("active");
                activeTab = target;
            });
        });
    }

    // ── Status Polling ──────────────────────────────────────

    function setDot(id, active) {
        var dot = document.getElementById(id);
        if (!dot) return;
        dot.classList.remove("active", "error");
        dot.classList.add(active ? "active" : "error");
    }

    function updateStatus() {
        fetch("/api/status")
            .then(function (r) { return r.json(); })
            .then(function (s) {
                setDot("kismet-dot", s.kismet);
                setDot("gps-dot", s.gps);
                setDot("modem-dot", s.modem);

                // Battery display
                var bat = document.getElementById("battery-display");
                if (bat) {
                    if (s.battery !== null && s.battery !== undefined) {
                        bat.textContent = Math.round(s.battery) + "%";
                    } else {
                        bat.textContent = "--";
                    }
                }

                // Footer info
                var footerUptime = document.getElementById("footer-uptime");
                if (footerUptime) footerUptime.textContent = "Up: " + (s.uptime || "--");

                var footerTs = document.getElementById("footer-tailscale");
                if (footerTs) footerTs.textContent = "TS: " + (s.tailscale_ip || "n/a");

                var footerIp = document.getElementById("footer-ip");
                if (footerIp && s.hostname) footerIp.textContent = s.hostname;

                // Active profile badge
                var profileBadge = document.getElementById("active-profile-badge");
                if (profileBadge && s.active_profile) {
                    profileBadge.textContent = s.active_profile;
                    profileBadge.style.display = "";
                }

                // Device count badge
                var countBadge = document.getElementById("device-count-badge");
                if (countBadge && s.device_count !== undefined && s.device_count !== null) {
                    countBadge.textContent = s.device_count;
                }
            })
            .catch(function () {});
    }

    // ── Init ────────────────────────────────────────────────

    document.addEventListener("DOMContentLoaded", function () {
        initTabs();
        updateStatus();
        setInterval(updateStatus, 10000);
    });

    // ── Auth-aware fetch wrapper ──────────────────────────

    var _origFetch = window.fetch;
    window.fetch = function (url, opts) {
        return _origFetch(url, opts).then(function (response) {
            // Redirect to login on 401 when X-Login-Required header is set
            if (response.status === 401 && url !== "/api/login" &&
                response.headers.get("X-Login-Required") === "true") {
                window.location.href = "/login";
            }
            return response;
        });
    };

    // ── Logout ─────────────────────────────────────────────

    function logout() {
        _origFetch("/api/logout", { method: "POST" })
            .then(function () { window.location.href = "/login"; })
            .catch(function () { window.location.href = "/login"; });
    }

    // ── Export to global namespace ──────────────────────────

    window.SORCC = {
        showToast: showToast,
        escapeHtml: escapeHtml,
        signalToPercent: signalToPercent,
        getActiveTab: function () { return activeTab; },
        setActiveTab: function (tab) { activeTab = tab; },
        logout: logout
    };

})();
