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
        // 0 dBm means Kismet has no RSSI data (common for BLE)
        if (dbm === 0) return 0;
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
            container.className = "toast-container";
            document.body.appendChild(container);
        }

        var toast = document.createElement("div");
        toast.className = "toast toast-" + type;
        toast.textContent = message;
        container.appendChild(toast);

        toast.addEventListener("click", function () {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        });

        setTimeout(function () {
            toast.style.opacity = "0";
            toast.style.transform = "translateX(100%)";
            toast.style.transition = "opacity 0.2s ease, transform 0.2s ease";
            setTimeout(function () {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 200);
        }, 3000);
    }

    // ── Tab Navigation ──────────────────────────────────────

    function initTabs() {
        document.querySelectorAll(".tab").forEach(function (tab) {
            tab.addEventListener("click", function () {
                var target = this.dataset.tab;
                document.querySelectorAll(".tab").forEach(function (t) {
                    t.classList.remove("active");
                });
                document.querySelectorAll(".tab-content").forEach(function (tc) {
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

    // ── Export to global namespace ──────────────────────────

    window.SORCC = {
        showToast: showToast,
        escapeHtml: escapeHtml,
        signalToPercent: signalToPercent,
        getActiveTab: function () { return activeTab; },
        setActiveTab: function (tab) { activeTab = tab; }
    };

})();
