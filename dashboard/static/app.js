/* SORCC RF Survey Dashboard — Client-side application */

(function () {
    "use strict";

    // ── State ───────────────────────────────────────────────
    let activeTab = "live";
    let activeFilter = "all";
    let huntInterval = null;
    let rssiHistory = [];
    const MAX_HISTORY = 120; // 60 seconds at 500ms polling

    // ── Tab Navigation ──────────────────────────────────────
    document.querySelectorAll(".tab").forEach(function (tab) {
        tab.addEventListener("click", function () {
            var target = this.dataset.tab;
            document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
            document.querySelectorAll(".tab-content").forEach(function (tc) { tc.classList.remove("active"); });
            this.classList.add("active");
            document.getElementById("tab-" + target).classList.add("active");
            activeTab = target;
        });
    });

    // ── Device Filter Buttons ───────────────────────────────
    document.querySelectorAll(".filter-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
            document.querySelectorAll(".filter-btn").forEach(function (b) { b.classList.remove("active"); });
            this.classList.add("active");
            activeFilter = this.dataset.filter;
            renderDevices(lastDevices);
        });
    });

    // ── Status Polling ──────────────────────────────────────
    function updateStatus() {
        fetch("/api/status")
            .then(function (r) { return r.json(); })
            .then(function (s) {
                setDot("kismet-dot", s.kismet);
                setDot("gps-dot", s.gps);
                setDot("modem-dot", s.modem);

                var bat = document.getElementById("battery-display");
                if (s.battery !== null && s.battery !== undefined) {
                    bat.textContent = Math.round(s.battery) + "%";
                } else {
                    bat.textContent = "--";
                }

                document.getElementById("footer-uptime").textContent = "Up: " + (s.uptime || "--");
                document.getElementById("footer-tailscale").textContent = "TS: " + (s.tailscale_ip || "n/a");

                if (s.hostname) {
                    document.getElementById("footer-ip").textContent = s.hostname;
                }
            })
            .catch(function () {});
    }

    function setDot(id, active) {
        var dot = document.getElementById(id);
        dot.classList.remove("active", "error");
        dot.classList.add(active ? "active" : "error");
    }

    // ── Device List ─────────────────────────────────────────
    var lastDevices = [];

    function fetchDevices() {
        if (activeTab !== "live") return;

        fetch("/api/devices")
            .then(function (r) { return r.json(); })
            .then(function (devices) {
                lastDevices = devices;
                renderDevices(devices);
            })
            .catch(function () {
                document.getElementById("device-list").innerHTML =
                    '<div class="loading">Cannot reach Kismet. Is it running?</div>';
            });
    }

    function renderDevices(devices) {
        var list = document.getElementById("device-list");
        var count = document.getElementById("device-count");

        // Filter
        var filtered = devices;
        if (activeFilter !== "all") {
            filtered = devices.filter(function (d) {
                return d.phy && d.phy.toLowerCase().indexOf(activeFilter.toLowerCase()) !== -1;
            });
        }

        count.textContent = filtered.length;

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
    var startBtn = document.getElementById("hunt-start");
    var stopBtn = document.getElementById("hunt-stop");
    var ssidInput = document.getElementById("target-ssid");
    var huntDisplay = document.getElementById("hunt-display");
    var prevSignal = -100;

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

    function startHunt(ssid) {
        startBtn.style.display = "none";
        stopBtn.style.display = "";
        ssidInput.disabled = true;
        huntDisplay.style.display = "";
        rssiHistory = [];
        prevSignal = -100;

        huntInterval = setInterval(function () {
            pollTarget(ssid);
        }, 500);
    }

    function stopHunt() {
        if (huntInterval) clearInterval(huntInterval);
        huntInterval = null;
        startBtn.style.display = "";
        stopBtn.style.display = "none";
        ssidInput.disabled = false;
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

        if (!data.found) {
            sigBar.style.width = "0%";
            sigBar.style.background = "var(--text-secondary)";
            sigValue.textContent = "-- dBm";
            sigHint.textContent = "Searching...";
            sigHint.className = "signal-hint searching";
            status.textContent = "Not Found";
            return;
        }

        var sig = data.signal;
        var pct = signalToPercent(sig);
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
        status.textContent = "Tracking";
        channel.textContent = data.channel || "--";
        mac.textContent = data.mac || "--";
        peak.textContent = (data.max_signal || sig) + " dBm";

        // RSSI history chart
        rssiHistory.push(sig);
        if (rssiHistory.length > MAX_HISTORY) rssiHistory.shift();
        drawRssiChart();

        prevSignal = sig;
    }

    function drawRssiChart() {
        var line = document.getElementById("rssi-line");
        if (rssiHistory.length < 2) return;

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

    // ── KML Export ──────────────────────────────────────────
    document.getElementById("export-kml").addEventListener("click", function () {
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
            })
            .catch(function (err) {
                alert("Export failed: " + err.message);
                btn.textContent = "Download KML File";
                btn.disabled = false;
            });
    });

    // ── Utilities ───────────────────────────────────────────
    function signalToPercent(dbm) {
        // Map -100 dBm → 0%, -20 dBm → 100%
        var pct = ((dbm + 100) / 80) * 100;
        return Math.max(0, Math.min(100, pct));
    }

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    // ── Polling Loops ───────────────────────────────────────
    updateStatus();
    fetchDevices();
    setInterval(updateStatus, 10000);
    setInterval(fetchDevices, 5000);
})();
