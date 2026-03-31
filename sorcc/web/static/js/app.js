/* SORCC-PI Dashboard — Main SPA Controller */

(function () {
    "use strict";

    // ── State ───────────────────────────────────────────────
    var activeTab = "operations";
    var consecutiveFailures = 0;
    var lastSuccessTime = Date.now();

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

    function setDot(id, state) {
        // state: "active" (green), "warn" (amber), "error" (red)
        var dot = document.getElementById(id);
        if (!dot) return;
        dot.classList.remove("active", "warn", "error");
        if (state === true || state === "active") dot.classList.add("active");
        else if (state === "warn") dot.classList.add("warn");
        else dot.classList.add("error");
    }

    function showConnectionBanner(connected) {
        var banner = document.getElementById("connection-banner");
        if (!banner) {
            banner = document.createElement("div");
            banner.id = "connection-banner";
            banner.className = "connection-banner";
            var header = document.querySelector("header");
            if (header && header.nextSibling) {
                header.parentNode.insertBefore(banner, header.nextSibling);
            } else {
                document.body.prepend(banner);
            }
        }
        if (connected) {
            banner.classList.remove("active");
        } else {
            var ago = Math.round((Date.now() - lastSuccessTime) / 1000);
            banner.textContent = "CONNECTION LOST — Last data " + ago + "s ago";
            banner.classList.add("active");
        }
    }

    function updateStatus() {
        fetch("/api/status", { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .then(function (s) {
                consecutiveFailures = 0;
                lastSuccessTime = Date.now();
                showConnectionBanner(true);

                setDot("kismet-dot", s.kismet ? "active" : "error");
                // GPS: green=fix, amber=powered but no fix, red=not available
                setDot("gps-dot", s.gps ? "active" : (s.gps_enabled ? "warn" : (s.modem ? "warn" : "error")));
                setDot("modem-dot", s.modem ? "active" : "error");

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
                if (footerIp) footerIp.textContent = s.callsign || s.hostname || "--";

                // Active profile badge
                var profileBadge = document.getElementById("active-profile");
                if (profileBadge && s.active_profile) {
                    profileBadge.textContent = s.active_profile;
                    profileBadge.style.display = "";
                }

                // Device count badge (in operations tab header)
                var countBadge = document.getElementById("device-count");
                if (countBadge && s.device_count !== undefined && s.device_count !== null) {
                    countBadge.textContent = s.device_count;
                }

                // Header device count
                var headerCount = document.getElementById("header-count-value");
                if (headerCount && s.device_count !== undefined) {
                    headerCount.textContent = s.device_count;
                }
            })
            .catch(function () {
                consecutiveFailures++;
                if (consecutiveFailures >= 3) {
                    showConnectionBanner(false);
                    // Don't grey out dots — keep last-known-good state
                    // Only show connection banner after 3 failures (15s)
                }
            });
    }

    // ── Server-Sent Events ────────────────────────────────

    var eventSource = null;
    var sseReconnectTimer = null;

    function connectSSE() {
        if (eventSource) return;
        try {
            eventSource = new EventSource("/api/events");
        } catch (e) { return; }

        eventSource.addEventListener("device_count", function (e) {
            try {
                var data = JSON.parse(e.data);
                var badge = document.getElementById("device-count");
                if (badge) badge.textContent = data.count;
                var headerCount = document.getElementById("header-count-value");
                if (headerCount) headerCount.textContent = data.count;
                // Only toast for genuine new discoveries (not initial connect)
                if (data.delta > 0 && data.delta < 50) {
                    showToast("+" + data.delta + " new device" + (data.delta > 1 ? "s" : ""), "info");
                }
            } catch (err) {}
        });

        eventSource.addEventListener("heartbeat", function () {
            consecutiveFailures = 0;
            lastSuccessTime = Date.now();
            showConnectionBanner(true);
        });

        eventSource.addEventListener("error", function () {
            if (eventSource) { eventSource.close(); eventSource = null; }
            // Reconnect after 10s
            if (!sseReconnectTimer) {
                sseReconnectTimer = setTimeout(function () {
                    sseReconnectTimer = null;
                    connectSSE();
                }, 10000);
            }
        });
    }

    // ── Init ────────────────────────────────────────────────

    document.addEventListener("DOMContentLoaded", function () {
        initTabs();
        updateStatus();
        setInterval(updateStatus, 10000);
        connectSSE();
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
