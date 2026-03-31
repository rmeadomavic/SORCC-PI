/* SORCC-PI Dashboard — Operations Tab Controller */

(function () {
    "use strict";

    // ── State ───────────────────────────────────────────────
    var activeSubTab = "liveview";
    var activeFilter = "all";
    var lastDevices = [];
    var huntInterval = null;
    var rssiHistory = [];
    var prevSignal = -100;
    var MAX_HISTORY = 120; // 60 seconds at 500ms polling
    var devicePollTimer = null;

    // ── Sub-tab Navigation ──────────────────────────────────

    function initSubTabs() {
        document.querySelectorAll(".ops-sub-tab").forEach(function (tab) {
            tab.addEventListener("click", function () {
                var target = this.dataset.subtab;
                document.querySelectorAll(".ops-sub-tab").forEach(function (t) {
                    t.classList.remove("active");
                });
                document.querySelectorAll(".ops-sub-content").forEach(function (tc) {
                    tc.classList.remove("active");
                });
                this.classList.add("active");
                var panel = document.getElementById("subtab-" + target);
                if (panel) panel.classList.add("active");
                activeSubTab = target;
            });
        });
    }

    // ── Device Filter Buttons ───────────────────────────────

    function initFilters() {
        document.querySelectorAll(".filter-btn").forEach(function (btn) {
            btn.addEventListener("click", function () {
                document.querySelectorAll(".filter-btn").forEach(function (b) {
                    b.classList.remove("active");
                });
                this.classList.add("active");
                activeFilter = this.dataset.filter;
                renderDevices(lastDevices);
            });
        });
    }

    // ── Device List (Live View) ─────────────────────────────

    function fetchDevices() {
        if (window.SORCC.getActiveTab() !== "operations") return;
        if (activeSubTab !== "liveview") return;

        fetch("/api/devices")
            .then(function (r) { return r.json(); })
            .then(function (devices) {
                lastDevices = devices;
                renderDevices(devices);
            })
            .catch(function () {
                var list = document.getElementById("device-list");
                if (list) {
                    list.innerHTML = '<div class="loading">Cannot reach Kismet. Is it running?</div>';
                }
            });
    }

    function renderDevices(devices) {
        var list = document.getElementById("device-list");
        var count = document.getElementById("device-count");
        if (!list) return;

        var escapeHtml = window.SORCC.escapeHtml;
        var signalToPercent = window.SORCC.signalToPercent;

        // Filter
        var filtered = devices;
        if (activeFilter !== "all") {
            filtered = devices.filter(function (d) {
                return d.phy && d.phy.toLowerCase().indexOf(activeFilter.toLowerCase()) !== -1;
            });
        }

        if (count) count.textContent = filtered.length;

        if (filtered.length === 0) {
            list.innerHTML = '<div class="loading">No devices detected yet.</div>';
            return;
        }

        var html = "";
        filtered.forEach(function (d) {
            var sig = d.signal || -100;
            var pct = signalToPercent(sig);
            var cls = sig > -50 ? "strong" : sig > -70 ? "medium" : "weak";
            var barColor = sig > -50 ? "var(--signal-hot)" : sig > -70 ? "var(--signal-warm)" : "var(--signal-cold)";
            var name = d.name || d.ssid || d.mac || "Unknown";
            var meta = d.mac;
            if (d.channel) meta += " | Ch " + d.channel;
            if (d.packets) meta += " | " + d.packets + " pkts";

            html += '<div class="device-row" data-phy="' + (d.phy || "") + '">';
            html += '  <div class="device-signal ' + cls + '">' + sig + '</div>';
            html += '  <div class="device-bar-container">';
            html += '    <div class="device-bar" style="width:' + pct + '%;background:' + barColor + '"></div>';
            html += '  </div>';
            html += '  <div class="device-info">';
            html += '    <div class="device-name">' + escapeHtml(name) + '</div>';
            html += '    <div class="device-meta">' + escapeHtml(meta) + '</div>';
            html += '  </div>';
            html += '  <div class="device-type">' + escapeHtml(d.phy || d.type || "") + '</div>';
            html += '</div>';
        });

        list.innerHTML = html;
    }

    // ── Hunt Mode ───────────────────────────────────────────

    function initHunt() {
        var startBtn = document.getElementById("hunt-start");
        var stopBtn = document.getElementById("hunt-stop");
        var ssidInput = document.getElementById("target-ssid");

        if (!startBtn || !stopBtn || !ssidInput) return;

        startBtn.addEventListener("click", function () {
            var ssid = ssidInput.value.trim();
            if (!ssid) {
                ssidInput.focus();
                return;
            }
            startHunt(ssid);
        });

        ssidInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter") startBtn.click();
        });

        stopBtn.addEventListener("click", stopHunt);
    }

    function startHunt(ssid) {
        var startBtn = document.getElementById("hunt-start");
        var stopBtn = document.getElementById("hunt-stop");
        var ssidInput = document.getElementById("target-ssid");
        var huntDisplay = document.getElementById("hunt-display");

        if (startBtn) startBtn.style.display = "none";
        if (stopBtn) stopBtn.style.display = "";
        if (ssidInput) ssidInput.disabled = true;
        if (huntDisplay) huntDisplay.style.display = "";
        rssiHistory = [];
        prevSignal = -100;

        huntInterval = setInterval(function () {
            pollTarget(ssid);
        }, 500);
    }

    function stopHunt() {
        if (huntInterval) clearInterval(huntInterval);
        huntInterval = null;

        var startBtn = document.getElementById("hunt-start");
        var stopBtn = document.getElementById("hunt-stop");
        var ssidInput = document.getElementById("target-ssid");

        if (startBtn) startBtn.style.display = "";
        if (stopBtn) stopBtn.style.display = "none";
        if (ssidInput) ssidInput.disabled = false;
    }

    function pollTarget(ssid) {
        fetch("/api/target/" + encodeURIComponent(ssid))
            .then(function (r) { return r.json(); })
            .then(function (data) {
                updateHuntDisplay(data);
            })
            .catch(function () {});
    }

    function updateHuntDisplay(data) {
        var sigBar = document.getElementById("signal-bar");
        var sigValue = document.getElementById("signal-value");
        var sigHint = document.getElementById("signal-hint");
        var status = document.getElementById("hunt-status");
        var channel = document.getElementById("hunt-channel");
        var mac = document.getElementById("hunt-mac");
        var peak = document.getElementById("hunt-peak");

        if (!sigBar || !sigValue || !sigHint) return;

        if (!data.found) {
            sigBar.style.width = "0%";
            sigBar.style.background = "var(--text-secondary)";
            sigValue.textContent = "-- dBm";
            sigHint.textContent = "Searching...";
            sigHint.className = "signal-hint searching";
            if (status) status.textContent = "Not Found";
            return;
        }

        var sig = data.signal;
        var pct = window.SORCC.signalToPercent(sig);
        var delta = sig - prevSignal;

        // Update gauge
        sigBar.style.width = pct + "%";
        sigValue.textContent = sig + " dBm";

        // Color and hint based on signal + trend
        if (sig > -40) {
            sigBar.style.background = "var(--signal-hot)";
            sigHint.textContent = "ON TARGET";
            sigHint.className = "signal-hint hot";
        } else if (sig > -60) {
            sigBar.style.background = "var(--signal-hot)";
            sigHint.textContent = delta > 1 ? "WARMER" : delta < -1 ? "COOLER" : "WARM";
            sigHint.className = "signal-hint hot";
        } else if (sig > -75) {
            sigBar.style.background = "var(--signal-warm)";
            sigHint.textContent = delta > 1 ? "GETTING WARMER" : delta < -1 ? "GETTING COOLER" : "LUKEWARM";
            sigHint.className = "signal-hint warm";
        } else {
            sigBar.style.background = "var(--signal-cold)";
            sigHint.textContent = delta > 1 ? "WARMING UP" : "COLD";
            sigHint.className = "signal-hint cold";
        }

        // Stats
        if (status) status.textContent = "Tracking";
        if (channel) channel.textContent = data.channel || "--";
        if (mac) mac.textContent = data.mac || "--";
        if (peak) peak.textContent = (data.max_signal || sig) + " dBm";

        // RSSI history chart
        rssiHistory.push(sig);
        if (rssiHistory.length > MAX_HISTORY) rssiHistory.shift();
        drawRssiChart();

        prevSignal = sig;
    }

    function drawRssiChart() {
        var line = document.getElementById("rssi-line");
        if (!line || rssiHistory.length < 2) return;

        var points = [];
        var w = 600;
        var h = 200;
        var minDbm = -100;
        var maxDbm = -20;
        var range = maxDbm - minDbm;

        for (var i = 0; i < rssiHistory.length; i++) {
            var x = (i / (MAX_HISTORY - 1)) * w;
            var y = h - ((rssiHistory[i] - minDbm) / range) * h;
            y = Math.max(5, Math.min(h - 5, y));
            points.push(Math.round(x) + "," + Math.round(y));
        }

        line.setAttribute("points", points.join(" "));
    }

    // ── Profile Selector ────────────────────────────────────

    function initProfiles() {
        var container = document.getElementById("profile-list");
        if (!container) return;

        fetchProfiles();
    }

    function fetchProfiles() {
        var container = document.getElementById("profile-list");
        if (!container) return;

        fetch("/api/profiles")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                renderProfiles(data.profiles || [], data.active || "");
            })
            .catch(function () {
                if (container) {
                    container.innerHTML = '<div class="loading">Could not load profiles.</div>';
                }
            });
    }

    function renderProfiles(profiles, activeId) {
        var container = document.getElementById("profile-list");
        if (!container) return;

        var escapeHtml = window.SORCC.escapeHtml;

        if (profiles.length === 0) {
            container.innerHTML = '<div class="loading">No profiles configured.</div>';
            return;
        }

        var html = "";
        profiles.forEach(function (p) {
            var isActive = p.id === activeId;
            html += '<div class="profile-card' + (isActive ? " active" : "") + '" data-profile-id="' + escapeHtml(p.id) + '">';
            html += '  <div class="profile-name">' + escapeHtml(p.name || p.id) + '</div>';
            if (p.description) {
                html += '  <div class="profile-desc">' + escapeHtml(p.description) + '</div>';
            }
            if (isActive) {
                html += '  <div class="profile-badge">Active</div>';
            }
            html += '</div>';
        });

        container.innerHTML = html;

        // Bind click handlers
        container.querySelectorAll(".profile-card").forEach(function (card) {
            card.addEventListener("click", function () {
                var id = this.dataset.profileId;
                switchProfile(id);
            });
        });
    }

    function switchProfile(id, force) {
        var payload = { id: id };
        if (force) payload.force = true;

        fetch("/api/profiles/switch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        })
            .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
            .then(function (result) {
                var data = result.data;
                if (result.status === 409 && data.status === "blocked") {
                    // WiFi interface conflict — ask the user before forcing
                    if (confirm(data.detail + "\n\nForce switch anyway? This WILL disconnect WiFi.")) {
                        switchProfile(id, true);
                    }
                    return;
                }
                if (data.status === "ok" || data.status === "partial") {
                    window.SORCC.showToast("Switched to profile: " + id, "success");
                    fetchProfiles();
                    if (data.errors && data.errors.length) {
                        window.SORCC.showToast("Warning: " + data.errors[0], "info");
                    }
                } else {
                    window.SORCC.showToast("Failed to switch profile: " + (data.detail || data.error || "Unknown error"), "error");
                }
            })
            .catch(function (err) {
                window.SORCC.showToast("Profile switch failed: " + err.message, "error");
            });
    }

    // ── Export ───────────────────────────────────────────────

    function initExport() {
        var kmlBtn = document.getElementById("export-kml");
        if (kmlBtn) {
            kmlBtn.addEventListener("click", function () {
                var btn = this;
                btn.textContent = "Exporting...";
                btn.disabled = true;

                fetch("/api/export/kml")
                    .then(function (r) {
                        if (!r.ok) {
                            return r.json().then(function (err) {
                                throw new Error(err.detail || "Export failed");
                            });
                        }
                        return r.blob();
                    })
                    .then(function (blob) {
                        var url = URL.createObjectURL(blob);
                        var a = document.createElement("a");
                        a.href = url;
                        a.download = "sorcc-survey.kml";
                        a.click();
                        URL.revokeObjectURL(url);
                        btn.textContent = "Download KML File";
                        btn.disabled = false;
                        window.SORCC.showToast("KML export complete", "success");
                    })
                    .catch(function (err) {
                        window.SORCC.showToast("Export failed: " + err.message, "error");
                        btn.textContent = "Download KML File";
                        btn.disabled = false;
                    });
            });
        }

        var csvBtn = document.getElementById("export-csv");
        if (csvBtn) {
            csvBtn.addEventListener("click", function () {
                var btn = this;
                btn.textContent = "Exporting...";
                btn.disabled = true;

                fetch("/api/export/csv")
                    .then(function (r) {
                        if (!r.ok) {
                            return r.json().then(function (err) {
                                throw new Error(err.detail || "Export failed");
                            });
                        }
                        return r.blob();
                    })
                    .then(function (blob) {
                        var url = URL.createObjectURL(blob);
                        var a = document.createElement("a");
                        a.href = url;
                        a.download = "sorcc-survey.csv";
                        a.click();
                        URL.revokeObjectURL(url);
                        btn.textContent = "Download CSV File";
                        btn.disabled = false;
                        window.SORCC.showToast("CSV export complete", "success");
                    })
                    .catch(function (err) {
                        window.SORCC.showToast("Export failed: " + err.message, "error");
                        btn.textContent = "Download CSV File";
                        btn.disabled = false;
                    });
            });
        }
    }

    // ── Init ────────────────────────────────────────────────

    document.addEventListener("DOMContentLoaded", function () {
        initSubTabs();
        initFilters();
        initHunt();
        initProfiles();
        initExport();

        // Start device polling
        fetchDevices();
        devicePollTimer = setInterval(fetchDevices, 5000);
    });

})();
