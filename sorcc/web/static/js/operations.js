/* SORCC-PI Dashboard — Operations Tab Controller */

(function () {
    "use strict";

    // ── State ───────────────────────────────────────────────
    var activeSubTab = "live";
    var activeFilter = "all";
    var activeSort = "signal";
    var searchQuery = "";
    var lastDevices = [];
    var huntInterval = null;
    var rssiHistory = [];
    var prevSignal = -100;
    var MAX_HISTORY = 120; // 60 seconds at 500ms polling
    var devicePollTimer = null;
    var prevDeviceCount = 0;
    var newPerMinute = 0;
    var lastCountTime = Date.now();
    var deviceMap = {};  // MAC → device object, for detail panel lookups
    var signalHistory = {};  // MAC → array of last N signal readings for sparklines
    var SPARKLINE_MAX = 12;  // 60 seconds at 5s polling

    // ── Sub-tab Navigation ──────────────────────────────────

    function initSubTabs() {
        document.querySelectorAll(".sub-tab").forEach(function (tab) {
            tab.addEventListener("click", function () {
                var target = this.dataset.subtab;
                document.querySelectorAll(".sub-tab").forEach(function (t) {
                    t.classList.remove("active");
                });
                document.querySelectorAll(".sub-content").forEach(function (tc) {
                    tc.classList.remove("active");
                });
                this.classList.add("active");
                var panel = document.getElementById("subtab-" + target);
                if (panel) panel.classList.add("active");
                activeSubTab = target;
                // Immediately render spectrum with cached data when switching to tab
                if (target === "spectrum" && lastDevices.length > 0) {
                    renderSpectrum(lastDevices);
                }
            });
        });
    }

    // ── Device Filter / Sort / Search ─────────────────────

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

        var sortSelect = document.getElementById("device-sort");
        if (sortSelect) {
            sortSelect.addEventListener("change", function () {
                activeSort = this.value;
                renderDevices(lastDevices);
            });
        }

        var searchInput = document.getElementById("device-search");
        if (searchInput) {
            searchInput.addEventListener("input", function () {
                searchQuery = this.value.toLowerCase().trim();
                renderDevices(lastDevices);
            });
        }
    }

    // ── Device List (Live View) ─────────────────────────────

    var deviceFetchInFlight = false;

    function fetchDevices() {
        if (window.SORCC.getActiveTab() !== "operations") return;
        if (activeSubTab !== "live" && activeSubTab !== "spectrum") return;
        if (deviceFetchInFlight) return;
        deviceFetchInFlight = true;

        fetch("/api/devices", {
            signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
        })
            .then(function (r) { return r.json(); })
            .then(function (devices) {
                deviceFetchInFlight = false;
                lastDevices = devices;
                updateSignalHistory(devices);
                renderDevices(devices);
                updateStats(devices);
                renderSpectrum(devices);
            })
            .catch(function () {
                deviceFetchInFlight = false;
                var list = document.getElementById("device-list");
                if (list) {
                    list.innerHTML = '<div class="loading">Cannot reach dashboard. Check connection.</div>';
                }
            });
    }

    function updateStats(devices) {
        var wifi = 0, bt = 0, other = 0, strong = 0;
        devices.forEach(function (d) {
            var phy = (d.phy || "").toLowerCase();
            if (phy.indexOf("802.11") !== -1) wifi++;
            else if (phy.indexOf("bluetooth") !== -1) bt++;
            else other++;
            if (d.signal && d.signal !== 0 && d.signal > -50) strong++;
        });

        // New devices per minute
        var now = Date.now();
        var elapsed = (now - lastCountTime) / 60000; // minutes
        if (elapsed > 0.5 && devices.length !== prevDeviceCount) {
            var diff = devices.length - prevDeviceCount;
            newPerMinute = Math.max(0, Math.round(diff / elapsed));
            prevDeviceCount = devices.length;
            lastCountTime = now;
        }

        setStatValue("stat-total", devices.length);
        setStatValue("stat-wifi", wifi);
        setStatValue("stat-bt", bt);
        setStatValue("stat-other", other);
        setStatValue("stat-strong", strong);
        var newEl = document.getElementById("stat-new");
        if (newEl) newEl.textContent = newPerMinute > 0 ? "+" + newPerMinute : "--";
    }

    function setStatValue(id, value) {
        var el = document.getElementById(id);
        if (!el) return;
        var current = parseInt(el.textContent, 10);
        if (isNaN(current) || current === value) {
            el.textContent = value;
            return;
        }
        // Animate the number change
        el.textContent = value;
        el.style.transform = "scale(1.15)";
        el.style.color = "var(--sorcc-muted)";
        setTimeout(function () {
            el.style.transform = "";
            el.style.color = "";
        }, 200);
    }

    var signalHistoryLastSeen = {};  // MAC → timestamp of last update
    var HISTORY_PRUNE_AGE = 300000;  // 5 minutes in ms

    function updateSignalHistory(devices) {
        var now = Date.now();
        var activeKeys = {};

        devices.forEach(function (d) {
            var key = d.mac || d.key;
            if (!key) return;
            activeKeys[key] = true;
            var sig = (d.signal === 0 || d.signal == null) ? null : d.signal;
            if (!signalHistory[key]) signalHistory[key] = [];
            signalHistory[key].push(sig);
            if (signalHistory[key].length > SPARKLINE_MAX) {
                signalHistory[key].shift();
            }
            signalHistoryLastSeen[key] = now;
        });

        // Prune history for devices not seen in 5+ minutes
        Object.keys(signalHistory).forEach(function (key) {
            if (!activeKeys[key] && (now - (signalHistoryLastSeen[key] || 0)) > HISTORY_PRUNE_AGE) {
                delete signalHistory[key];
                delete signalHistoryLastSeen[key];
            }
        });
    }

    function buildSparklineSVG(mac) {
        var history = signalHistory[mac];
        if (!history || history.length < 2) return "";

        // Filter out nulls for drawing but keep positions
        var w = 80, h = 24;
        var minDbm = -100, maxDbm = -20;
        var range = maxDbm - minDbm;
        var points = [];
        var lastValid = null;

        var denom = Math.max(history.length - 1, 1);
        for (var i = 0; i < history.length; i++) {
            var val = history[i];
            if (val === null) continue;
            var x = (i / denom) * w;
            var y = h - ((val - minDbm) / range) * h;
            y = Math.max(1, Math.min(h - 1, y));
            points.push(Math.round(x * 10) / 10 + "," + Math.round(y * 10) / 10);
            lastValid = val;
        }

        if (points.length < 2) return "";

        // Color based on trend (last vs first valid reading)
        var firstValid = null;
        for (var j = 0; j < history.length; j++) {
            if (history[j] !== null) { firstValid = history[j]; break; }
        }
        var trending = (lastValid !== null && firstValid !== null) ? lastValid - firstValid : 0;
        var color = trending > 3 ? "var(--signal-hot)" : trending < -3 ? "var(--signal-cold)" : "var(--sorcc-green-light, #A6BC92)";

        return '<svg class="sparkline" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
            '<polyline points="' + points.join(" ") + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
            '</svg>';
    }

    function renderDevices(devices) {
        var list = document.getElementById("device-list");
        var count = document.getElementById("device-count");
        if (!list) return;

        var escapeHtml = window.SORCC.escapeHtml;
        var signalToPercent = window.SORCC.signalToPercent;

        // Filter by type
        var filtered = devices;
        if (activeFilter !== "all") {
            filtered = devices.filter(function (d) {
                return d.phy && d.phy.toLowerCase().indexOf(activeFilter.toLowerCase()) !== -1;
            });
        }

        // Filter by search query
        if (searchQuery) {
            filtered = filtered.filter(function (d) {
                var haystack = ((d.name || "") + " " + (d.mac || "") + " " + (d.ssid || "")).toLowerCase();
                return haystack.indexOf(searchQuery) !== -1;
            });
        }

        // Sort
        filtered = filtered.slice().sort(function (a, b) {
            switch (activeSort) {
                case "signal":
                    // Put 0/null/undefined (unknown) at the bottom
                    var sa = (a.signal === 0 || a.signal == null) ? -999 : a.signal;
                    var sb = (b.signal === 0 || b.signal == null) ? -999 : b.signal;
                    return sb - sa;
                case "signal-asc":
                    var sa2 = (a.signal === 0 || a.signal == null) ? 1 : a.signal;
                    var sb2 = (b.signal === 0 || b.signal == null) ? 1 : b.signal;
                    return sa2 - sb2;
                case "name":
                    return (a.name || a.mac || "").localeCompare(b.name || b.mac || "");
                case "packets":
                    return (b.packets || 0) - (a.packets || 0);
                case "last-seen":
                    return (b.last_seen || 0) - (a.last_seen || 0);
                default:
                    return 0;
            }
        });

        if (count) count.textContent = filtered.length;

        if (filtered.length === 0) {
            list.innerHTML = '<div class="loading">No devices detected yet.</div>';
            return;
        }

        // Build lookup map for detail panel
        deviceMap = {};

        var html = "";
        filtered.forEach(function (d) {
            var key = d.mac || d.key || ("dev-" + (d.name || "") + "-" + (d.phy || "") + "-" + (d.channel || ""));
            deviceMap[key] = d;

            var sig = d.signal || -100;
            var pct = signalToPercent(sig);
            var noSignal = (d.signal === 0 || d.signal === undefined || d.signal === null);
            var cls = noSignal ? "weak" : sig > -50 ? "strong" : sig > -70 ? "medium" : "weak";
            var barColor = noSignal ? "var(--text-secondary)" : sig > -50 ? "var(--signal-hot)" : sig > -70 ? "var(--signal-warm)" : "var(--signal-cold)";
            var name = d.name || d.ssid || d.mac || "Unknown";
            var meta = d.mac;
            if (d.channel) meta += " | Ch " + d.channel;
            if (d.packets) meta += " | " + d.packets + " pkts";

            var sparkSvg = buildSparklineSVG(key);

            html += '<div class="device-row" data-phy="' + escapeHtml(d.phy || "") + '" data-device-key="' + escapeHtml(key) + '">';
            html += '  <div class="device-signal ' + cls + '">' + (noSignal ? "N/A" : sig) + '</div>';
            html += '  <div class="device-sparkline-wrap">';
            if (sparkSvg) {
                html += sparkSvg;
            } else {
                // Fallback to bar when no history yet
                html += '    <div class="device-bar-container"><div class="device-bar" style="width:' + pct + '%;background:' + barColor + '"></div></div>';
            }
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
                ssidInput.style.borderColor = "var(--danger)";
                window.SORCC.showToast("Enter a target SSID to hunt", "error");
                setTimeout(function () { ssidInput.style.borderColor = ""; }, 2000);
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
        huntPollInFlight = false;
        huntConsecutiveErrors = 0;

        // Stop audio
        if (audioGain) audioGain.gain.value = 0;

        var startBtn = document.getElementById("hunt-start");
        var stopBtn = document.getElementById("hunt-stop");
        var ssidInput = document.getElementById("target-ssid");

        if (startBtn) startBtn.style.display = "";
        if (stopBtn) stopBtn.style.display = "none";
        if (ssidInput) ssidInput.disabled = false;
    }

    var huntPollInFlight = false;
    var huntConsecutiveErrors = 0;

    function pollTarget(ssid) {
        if (huntPollInFlight) return;  // prevent stacking over slow connections
        huntPollInFlight = true;
        fetch("/api/target/" + encodeURIComponent(ssid), {
            signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                huntPollInFlight = false;
                huntConsecutiveErrors = 0;
                var sigHint = document.getElementById("signal-hint");
                if (sigHint) sigHint.classList.remove("stale");
                updateHuntDisplay(data);
            })
            .catch(function () {
                huntPollInFlight = false;
                huntConsecutiveErrors++;
                if (huntConsecutiveErrors >= 3) {
                    var sigHint = document.getElementById("signal-hint");
                    if (sigHint) {
                        sigHint.textContent = "SIGNAL STALE — CONNECTION LOST";
                        sigHint.className = "signal-hint stale";
                    }
                    if (audioGain) audioGain.gain.value = 0;
                }
            });
    }

    // Audio context for hunt mode tone
    var audioCtx = null;
    var audioOsc = null;
    var audioGain = null;

    function initAudio() {
        if (audioCtx) return;
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            audioOsc = audioCtx.createOscillator();
            audioGain = audioCtx.createGain();
            audioOsc.type = "sine";
            audioOsc.frequency.value = 200;
            audioGain.gain.value = 0;
            audioOsc.connect(audioGain);
            audioGain.connect(audioCtx.destination);
            audioOsc.start();
        } catch (e) { audioCtx = null; }
    }

    function playTone(sig) {
        var audioToggle = document.getElementById("hunt-audio-toggle");
        if (!audioToggle || !audioToggle.checked) {
            if (audioGain) audioGain.gain.value = 0;
            return;
        }
        if (!audioCtx) initAudio();
        if (!audioCtx) return;

        // Map signal to frequency: -100 dBm = 200Hz, -20 dBm = 1200Hz
        var pct = Math.max(0, Math.min(1, (sig + 100) / 80));
        var freq = 200 + pct * 1000;
        audioOsc.frequency.value = freq;
        audioGain.gain.value = 0.08 + pct * 0.12; // quiet to moderate
    }

    function updateGaugeArc(pct) {
        var arc = document.getElementById("gauge-arc");
        var needle = document.getElementById("gauge-needle");
        if (!arc) return;

        // Arc total length is ~251.33 (half circle r=80)
        var totalLen = 251.33;
        var fillLen = (pct / 100) * totalLen;
        arc.setAttribute("stroke-dasharray", fillLen + " " + totalLen);

        // Rotate needle: -90deg (left) to +90deg (right) based on pct
        if (needle) {
            var angle = -90 + (pct / 100) * 180;
            needle.setAttribute("transform", "rotate(" + angle + ", 100, 100)");
        }
    }

    function updateHuntDisplay(data) {
        var sigValue = document.getElementById("signal-value");
        var sigHint = document.getElementById("signal-hint");
        var status = document.getElementById("hunt-status");
        var channel = document.getElementById("hunt-channel");
        var mac = document.getElementById("hunt-mac");
        var peak = document.getElementById("hunt-peak");

        if (!sigValue || !sigHint) return;

        if (!data.found) {
            updateGaugeArc(0);
            sigValue.textContent = "-- dBm";
            sigHint.textContent = "Searching...";
            sigHint.className = "signal-hint searching";
            if (status) status.textContent = "Not Found";
            if (audioGain) audioGain.gain.value = 0;
            return;
        }

        var sig = data.signal;
        var pct = window.SORCC.signalToPercent(sig);
        var delta = sig - prevSignal;

        // Update arc gauge
        updateGaugeArc(pct);
        sigValue.textContent = sig + " dBm";

        // Audio feedback
        playTone(sig);

        // Color and hint based on signal + trend
        if (sig > -40) {
            sigHint.textContent = "ON TARGET";
            sigHint.className = "signal-hint hot";
        } else if (sig > -60) {
            sigHint.textContent = delta > 1 ? "WARMER" : delta < -1 ? "COOLER" : "WARM";
            sigHint.className = "signal-hint hot";
        } else if (sig > -75) {
            sigHint.textContent = delta > 1 ? "GETTING WARMER" : delta < -1 ? "GETTING COOLER" : "LUKEWARM";
            sigHint.className = "signal-hint warm";
        } else {
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

    // ── Device Detail Panel ───────────────────────────────

    function initDeviceDetail() {
        var overlay = document.getElementById("device-detail-overlay");
        var closeBtn = document.getElementById("detail-close");
        var list = document.getElementById("device-list");

        if (!overlay || !list) return;

        // Event delegation — single listener survives re-renders
        list.addEventListener("click", function (e) {
            var row = e.target.closest(".device-row");
            if (!row) return;
            var key = row.dataset.deviceKey;
            if (!key || !deviceMap[key]) return;
            openDeviceDetail(deviceMap[key]);
        });

        // Close panel
        if (closeBtn) {
            closeBtn.addEventListener("click", closeDeviceDetail);
        }

        // Click overlay backdrop to close
        overlay.addEventListener("click", function (e) {
            if (e.target === overlay) closeDeviceDetail();
        });

        // Escape key to close
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && overlay.classList.contains("active")) {
                closeDeviceDetail();
            }
        });

        // "Hunt This Device" button
        var huntBtn = document.getElementById("detail-hunt-btn");
        if (huntBtn) {
            huntBtn.addEventListener("click", function () {
                var ssid = this.dataset.ssid;
                if (!ssid) return;
                closeDeviceDetail();
                // Switch to Hunt sub-tab
                var huntTab = document.querySelector('.sub-tab[data-subtab="hunt"]');
                if (huntTab) huntTab.click();
                // Populate SSID and start hunt
                var ssidInput = document.getElementById("target-ssid");
                if (ssidInput) {
                    ssidInput.value = ssid;
                    startHunt(ssid);
                }
            });
        }

        // "Show on Map" button
        var locateBtn = document.getElementById("detail-locate-btn");
        if (locateBtn) {
            locateBtn.addEventListener("click", function () {
                var lat = parseFloat(this.dataset.lat);
                var lon = parseFloat(this.dataset.lon);
                closeDeviceDetail();
                // Switch to Map sub-tab
                var mapTab = document.querySelector('.sub-tab[data-subtab="map"]');
                if (mapTab) mapTab.click();
                // Center map on device if coordinates exist
                if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0 && window.SORCC.centerMap) {
                    window.SORCC.centerMap(lat, lon);
                }
            });
        }
    }

    function openDeviceDetail(d) {
        var overlay = document.getElementById("device-detail-overlay");
        if (!overlay) return;

        var name = d.name || d.ssid || d.mac || "Unknown";
        var noSignal = (d.signal === 0 || d.signal === undefined || d.signal === null);

        // Populate fields
        setText("detail-name", name);
        setText("detail-mac", d.mac || "--");
        setText("detail-type", d.phy || d.type || "--");
        setText("detail-signal", noSignal ? "N/A" : d.signal + " dBm");
        setText("detail-channel", d.channel || "--");
        setText("detail-packets", d.packets != null ? d.packets.toLocaleString() : "--");
        setText("detail-last-seen", d.last_seen ? formatTimestamp(d.last_seen) : "--");

        // Store data on action buttons for handlers
        var huntBtn = document.getElementById("detail-hunt-btn");
        if (huntBtn) {
            var ssid = d.ssid || d.name || "";
            huntBtn.dataset.ssid = ssid;
            huntBtn.disabled = !ssid;
            huntBtn.textContent = ssid ? "Hunt This Device" : "No SSID Available";
        }

        var locateBtn = document.getElementById("detail-locate-btn");
        if (locateBtn) {
            var hasLoc = d.lat && d.lon && d.lat !== 0 && d.lon !== 0;
            locateBtn.dataset.lat = d.lat || 0;
            locateBtn.dataset.lon = d.lon || 0;
            locateBtn.disabled = !hasLoc;
            locateBtn.textContent = hasLoc ? "Show on Map" : "No Location Data";
        }

        overlay.classList.add("active");
    }

    function closeDeviceDetail() {
        var overlay = document.getElementById("device-detail-overlay");
        if (overlay) overlay.classList.remove("active");
    }

    function setText(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    function formatTimestamp(epoch) {
        if (!epoch) return "--";
        var d = new Date(epoch * 1000);
        var now = new Date();
        var diff = Math.floor((now - d) / 1000);
        if (diff < 5) return "Just now";
        if (diff < 60) return diff + "s ago";
        if (diff < 3600) return Math.floor(diff / 60) + "m ago";
        return d.toLocaleTimeString();
    }

    // ── Spectrum Visualization ────────────────────────────

    // WiFi channel → center frequency (MHz) mapping
    var WIFI_CHANNELS_24 = {1:2412,2:2417,3:2422,4:2427,5:2432,6:2437,7:2442,8:2447,9:2452,10:2457,11:2462,12:2467,13:2472,14:2484};
    var WIFI_CHANNELS_5 = {36:5180,40:5200,44:5220,48:5240,52:5260,56:5280,60:5300,64:5320,100:5500,104:5520,108:5540,112:5560,116:5580,120:5600,124:5620,128:5640,132:5660,136:5680,140:5700,144:5720,149:5745,153:5765,157:5785,161:5805,165:5825};

    var BAND_DEFS = [
        { id: "2.4ghz", label: "2.4 GHz WiFi", color: "#4ade80", min: 2400, max: 2500 },
        { id: "5ghz",   label: "5 GHz WiFi",   color: "#42a5f5", min: 5150, max: 5850 },
        { id: "bt",     label: "Bluetooth",     color: "#a78bfa", min: 2402, max: 2480, phyMatch: "bluetooth" },
        { id: "433mhz", label: "433 MHz ISM",   color: "#f59e0b", min: 430, max: 440 },
        { id: "adsb",   label: "1090 ADS-B",    color: "#ef5350", min: 1088, max: 1092 },
        { id: "other",  label: "Other",         color: "#6b7280", min: 0, max: 0 }
    ];

    function classifyBand(device) {
        var phy = (device.phy || "").toLowerCase();
        // BT devices: classify by phy name since frequency may not be set
        if (phy.indexOf("bluetooth") !== -1) return "bt";
        var freq = device.frequency || 0;
        if (freq === 0) {
            // Try to infer from channel string
            var ch = parseInt(device.channel, 10);
            if (!isNaN(ch)) {
                if (WIFI_CHANNELS_24[ch]) freq = WIFI_CHANNELS_24[ch];
                else if (WIFI_CHANNELS_5[ch]) freq = WIFI_CHANNELS_5[ch];
            }
        }
        // Kismet reports frequency in kHz (2412000 = 2412 MHz)
        var mhz = freq > 100000 ? freq / 1000 : freq;
        if (mhz >= 2400 && mhz <= 2500) return "2.4ghz";
        if (mhz >= 5150 && mhz <= 5850) return "5ghz";
        if (mhz >= 430 && mhz <= 440) return "433mhz";
        if (mhz >= 1088 && mhz <= 1092) return "adsb";
        if (mhz > 0) return "other";
        // Last resort: classify by phy type
        if (phy.indexOf("802.11") !== -1) return "2.4ghz";
        if (phy.indexOf("rtl433") !== -1) return "433mhz";
        if (phy.indexOf("adsb") !== -1) return "adsb";
        return "other";
    }

    function renderSpectrum(devices) {
        if (activeSubTab !== "spectrum") return;
        renderChannelChart(devices);
        renderBandDonut(devices);
        renderSignalHeatmap(devices);
    }

    // ── Channel Utilization Bar Chart ──

    function renderChannelChart(devices) {
        var svg = document.getElementById("channel-chart");
        if (!svg) return;

        // Count devices per channel (WiFi only)
        var channelCounts = {};
        var channelSignals = {};
        devices.forEach(function (d) {
            var ch = d.channel;
            if (!ch) return;
            var phy = (d.phy || "").toLowerCase();
            if (phy.indexOf("802.11") === -1) return;
            if (!channelCounts[ch]) { channelCounts[ch] = 0; channelSignals[ch] = []; }
            channelCounts[ch]++;
            if (d.signal && d.signal !== 0) channelSignals[ch].push(d.signal);
        });

        // Sort channels numerically
        var channels = Object.keys(channelCounts).sort(function (a, b) {
            return parseInt(a, 10) - parseInt(b, 10);
        });

        var badge = document.getElementById("spec-ch-count");
        if (badge) badge.textContent = channels.length + " channels";

        if (channels.length === 0) {
            svg.innerHTML = '<text x="360" y="110" text-anchor="middle" fill="var(--text-dim)" font-size="14" font-family="var(--font-mono)">No WiFi channels detected</text>';
            return;
        }

        var maxCount = Math.max.apply(null, channels.map(function (ch) { return channelCounts[ch]; }));
        if (maxCount === 0) maxCount = 1;

        var W = 720, H = 220;
        var padL = 40, padR = 10, padT = 10, padB = 30;
        var chartW = W - padL - padR;
        var chartH = H - padT - padB;
        var barW = Math.min(32, Math.floor(chartW / channels.length) - 4);
        var gap = (chartW - barW * channels.length) / (channels.length + 1);

        var html = '';
        // Grid lines
        for (var g = 0; g <= 4; g++) {
            var gy = padT + (g / 4) * chartH;
            var gVal = Math.round(maxCount * (1 - g / 4));
            html += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '" stroke="rgba(56,87,35,0.15)" stroke-width="1" stroke-dasharray="3,6"/>';
            html += '<text x="' + (padL - 6) + '" y="' + (gy + 4) + '" text-anchor="end" fill="var(--text-dim)" font-size="10" font-family="var(--font-mono)">' + gVal + '</text>';
        }

        channels.forEach(function (ch, i) {
            var count = channelCounts[ch];
            var barH = (count / maxCount) * chartH;
            var x = padL + gap + i * (barW + gap);
            var y = padT + chartH - barH;

            // Color by density
            var color = count > 8 ? "var(--signal-hot)" : count > 3 ? "var(--signal-warm)" : "var(--signal-cold)";
            var glowColor = count > 8 ? "rgba(239,83,80,0.4)" : count > 3 ? "rgba(255,152,0,0.3)" : "rgba(66,165,245,0.2)";

            // Glow filter effect via shadow rect
            html += '<rect x="' + (x - 2) + '" y="' + (y - 2) + '" width="' + (barW + 4) + '" height="' + (barH + 4) + '" rx="3" fill="' + glowColor + '" filter="url(#spec-blur)"/>';
            // Main bar with gradient
            html += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + barH + '" rx="2" fill="' + color + '" opacity="0.85">';
            html += '<animate attributeName="height" from="0" to="' + barH + '" dur="0.4s" fill="freeze"/>';
            html += '<animate attributeName="y" from="' + (padT + chartH) + '" to="' + y + '" dur="0.4s" fill="freeze"/>';
            html += '</rect>';
            // Count label on top of bar
            if (barH > 16) {
                html += '<text x="' + (x + barW / 2) + '" y="' + (y + 14) + '" text-anchor="middle" fill="#fff" font-size="10" font-weight="700" font-family="var(--font-mono)">' + count + '</text>';
            }
            // Channel label
            html += '<text x="' + (x + barW / 2) + '" y="' + (H - 8) + '" text-anchor="middle" fill="var(--text-secondary)" font-size="10" font-family="var(--font-mono)">Ch' + ch + '</text>';
        });

        // Blur filter definition
        html = '<defs><filter id="spec-blur"><feGaussianBlur stdDeviation="3"/></filter></defs>' + html;

        svg.innerHTML = html;
    }

    // ── Frequency Band Donut Chart ──

    function renderBandDonut(devices) {
        var svg = document.getElementById("band-donut");
        var listEl = document.getElementById("band-list");
        var totalEl = document.getElementById("donut-total");
        if (!svg) return;

        // Classify devices into bands
        var bandCounts = {};
        BAND_DEFS.forEach(function (b) { bandCounts[b.id] = 0; });
        devices.forEach(function (d) {
            var band = classifyBand(d);
            bandCounts[band] = (bandCounts[band] || 0) + 1;
        });

        var total = devices.length;
        if (totalEl) totalEl.textContent = total;

        // Build donut segments
        var cx = 120, cy = 120, r = 85, strokeW = 22;
        var circumference = 2 * Math.PI * r;
        var html = '';
        var offset = 0;

        // Sort bands by count descending for visual impact
        var sortedBands = BAND_DEFS.filter(function (b) { return bandCounts[b.id] > 0; });
        sortedBands.sort(function (a, b) { return bandCounts[b.id] - bandCounts[a.id]; });

        if (sortedBands.length === 0) {
            html += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="rgba(56,87,35,0.15)" stroke-width="' + strokeW + '"/>';
        } else {
            // Background ring
            html += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="rgba(38,38,38,0.8)" stroke-width="' + strokeW + '"/>';

            sortedBands.forEach(function (band) {
                var count = bandCounts[band.id];
                var pct = total > 0 ? count / total : 0;
                var segLen = pct * circumference;
                var gapLen = circumference - segLen;
                html += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" ' +
                    'stroke="' + band.color + '" stroke-width="' + strokeW + '" ' +
                    'stroke-dasharray="' + segLen.toFixed(1) + ' ' + gapLen.toFixed(1) + '" ' +
                    'stroke-dashoffset="' + (-offset).toFixed(1) + '" ' +
                    'stroke-linecap="round" opacity="0.85" ' +
                    'transform="rotate(-90 ' + cx + ' ' + cy + ')">' +
                    '<animate attributeName="stroke-dasharray" from="0 ' + circumference + '" to="' + segLen.toFixed(1) + ' ' + gapLen.toFixed(1) + '" dur="0.6s" fill="freeze"/>' +
                    '</circle>';
                offset += segLen;
            });
        }

        svg.innerHTML = html;

        // Band list breakdown
        if (listEl) {
            var listHtml = '';
            BAND_DEFS.forEach(function (band) {
                var count = bandCounts[band.id];
                if (count === 0) return;
                var pct = total > 0 ? Math.round((count / total) * 100) : 0;
                listHtml += '<div class="band-row">';
                listHtml += '<span class="band-dot" style="background:' + band.color + '"></span>';
                listHtml += '<span class="band-label">' + band.label + '</span>';
                listHtml += '<span class="band-count">' + count + '</span>';
                listHtml += '<span class="band-pct">' + pct + '%</span>';
                listHtml += '</div>';
            });
            listEl.innerHTML = listHtml;
        }
    }

    // ── Signal Heatmap Grid ──

    function renderSignalHeatmap(devices) {
        var svg = document.getElementById("signal-heatmap");
        if (!svg) return;

        // Group WiFi devices by channel and signal bucket
        var sigBuckets = [
            { label: ">-30", min: -30, max: 0 },
            { label: "-30 to -50", min: -50, max: -30 },
            { label: "-50 to -70", min: -70, max: -50 },
            { label: "-70 to -90", min: -90, max: -70 },
            { label: "<-90", min: -120, max: -90 }
        ];

        // Collect unique WiFi channels
        var channelSet = {};
        devices.forEach(function (d) {
            if (!d.channel) return;
            var phy = (d.phy || "").toLowerCase();
            if (phy.indexOf("802.11") === -1) return;  // WiFi channels only
            channelSet[d.channel] = true;
        });
        var channels = Object.keys(channelSet).sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });

        if (channels.length === 0) {
            svg.innerHTML = '<text x="200" y="100" text-anchor="middle" fill="var(--text-dim)" font-size="14" font-family="var(--font-mono)">No channel data</text>';
            return;
        }

        // Build count grid
        var grid = {};
        var maxCell = 0;
        channels.forEach(function (ch) {
            grid[ch] = {};
            sigBuckets.forEach(function (b) { grid[ch][b.label] = 0; });
        });
        devices.forEach(function (d) {
            if (!d.channel || !grid[d.channel]) return;
            var sig = d.signal;
            if (sig === 0 || sig == null) return;
            for (var i = 0; i < sigBuckets.length; i++) {
                if (sig > sigBuckets[i].min && sig <= sigBuckets[i].max) {
                    grid[d.channel][sigBuckets[i].label]++;
                    if (grid[d.channel][sigBuckets[i].label] > maxCell) maxCell = grid[d.channel][sigBuckets[i].label];
                    break;
                }
            }
        });
        if (maxCell === 0) maxCell = 1;

        var W = 400, H = 200;
        var padL = 80, padR = 10, padT = 10, padB = 35;
        var gridW = W - padL - padR;
        var gridH = H - padT - padB;
        var cellW = Math.min(28, gridW / channels.length);
        var cellH = gridH / sigBuckets.length;

        var html = '';

        // Row labels (signal buckets)
        sigBuckets.forEach(function (b, row) {
            var y = padT + row * cellH;
            html += '<text x="' + (padL - 6) + '" y="' + (y + cellH / 2 + 4) + '" text-anchor="end" fill="var(--text-dim)" font-size="9" font-family="var(--font-mono)">' + b.label + '</text>';
        });

        // Cells
        channels.forEach(function (ch, col) {
            var x = padL + col * cellW;
            // Column label
            html += '<text x="' + (x + cellW / 2) + '" y="' + (H - 10) + '" text-anchor="middle" fill="var(--text-secondary)" font-size="9" font-family="var(--font-mono)">' + ch + '</text>';

            sigBuckets.forEach(function (b, row) {
                var y = padT + row * cellH;
                var count = grid[ch][b.label];
                var intensity = count / maxCell;
                // Green-to-hot color interpolation
                var r_val, g_val, b_val;
                if (intensity === 0) {
                    r_val = 26; g_val = 26; b_val = 26; // empty cell
                } else if (intensity < 0.5) {
                    r_val = 56; g_val = Math.round(87 + intensity * 200); b_val = 35; // green range
                } else {
                    r_val = Math.round(56 + (intensity - 0.5) * 2 * 183); g_val = Math.round(187 - (intensity - 0.5) * 2 * 100); b_val = 35; // green → red
                }
                var cellColor = "rgb(" + r_val + "," + g_val + "," + b_val + ")";

                html += '<rect x="' + (x + 1) + '" y="' + (y + 1) + '" width="' + (cellW - 2) + '" height="' + (cellH - 2) + '" rx="2" fill="' + cellColor + '" opacity="' + (intensity === 0 ? 0.3 : 0.85) + '">';
                if (count > 0) {
                    html += '<animate attributeName="opacity" from="0" to="0.85" dur="0.5s" fill="freeze"/>';
                }
                html += '</rect>';

                // Count text in cell if non-zero
                if (count > 0) {
                    html += '<text x="' + (x + cellW / 2) + '" y="' + (y + cellH / 2 + 3) + '" text-anchor="middle" fill="#fff" font-size="9" font-weight="700" font-family="var(--font-mono)">' + count + '</text>';
                }
            });
        });

        svg.innerHTML = html;
    }

    // ── Profile Selector ────────────────────────────────────

    function initProfiles() {
        var container = document.getElementById("profile-list");
        if (!container) return;

        // Bind click handlers to the static HTML profile cards
        bindProfileCards(container);

        // Then try to fetch dynamic profiles from the API
        fetchProfiles();
    }

    function bindProfileCards(container) {
        container.querySelectorAll(".profile-card").forEach(function (card) {
            card.addEventListener("click", function () {
                var id = this.dataset.profileId || this.dataset.profile;
                if (!id) return;

                // Update active state visually
                container.querySelectorAll(".profile-card").forEach(function (c) {
                    c.classList.remove("active");
                });
                this.classList.add("active");

                switchProfile(id);
            });
        });
    }

    function fetchProfiles() {
        var container = document.getElementById("profile-list");
        if (!container) return;

        fetch("/api/profiles")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                // API may return an array directly or {profiles: [], active: ""}
                var profiles = Array.isArray(data) ? data : (data.profiles || []);
                var active = Array.isArray(data) ? "" : (data.active || "");
                if (profiles.length > 0) {
                    renderProfiles(profiles, active);
                }
            })
            .catch(function () {
                // Static cards are already in the HTML, just leave them
            });
    }

    function renderProfiles(profiles, activeId) {
        var container = document.getElementById("profile-list");
        if (!container) return;

        // Build cards using DOM methods (safe from XSS)
        while (container.firstChild) container.removeChild(container.firstChild);

        profiles.forEach(function (p) {
            var isActive = p.id === activeId;
            var card = document.createElement("div");
            card.className = "profile-card" + (isActive ? " active" : "");
            card.dataset.profile = p.id;

            var name = document.createElement("div");
            name.className = "profile-card-name";
            name.textContent = p.name || p.id;
            card.appendChild(name);

            if (p.description) {
                var desc = document.createElement("div");
                desc.className = "profile-card-desc";
                desc.textContent = p.description;
                card.appendChild(desc);
            }

            container.appendChild(card);
        });

        bindProfileCards(container);
    }

    function switchProfile(id) {
        fetch("/api/profiles/switch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: id })
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.status === "ok" || data.status === "partial" || data.ok || data.success) {
                    window.SORCC.showToast("Switched to profile: " + id, "success");
                    fetchProfiles();
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
        initDeviceDetail();
        initProfiles();
        initExport();

        // Start device polling
        fetchDevices();
        devicePollTimer = setInterval(fetchDevices, 5000);
    });

})();
