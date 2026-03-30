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

    function fetchDevices() {
        if (window.SORCC.getActiveTab() !== "operations") return;
        if (activeSubTab !== "live") return;

        fetch("/api/devices")
            .then(function (r) { return r.json(); })
            .then(function (devices) {
                lastDevices = devices;
                updateSignalHistory(devices);
                renderDevices(devices);
                updateStats(devices);
            })
            .catch(function () {
                var list = document.getElementById("device-list");
                if (list) {
                    list.innerHTML = '<div class="loading">Cannot reach Kismet. Is it running?</div>';
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

    function updateSignalHistory(devices) {
        devices.forEach(function (d) {
            var key = d.mac || d.key;
            if (!key) return;
            var sig = (d.signal === 0 || d.signal == null) ? null : d.signal;
            if (!signalHistory[key]) signalHistory[key] = [];
            signalHistory[key].push(sig);
            if (signalHistory[key].length > SPARKLINE_MAX) {
                signalHistory[key].shift();
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

        for (var i = 0; i < history.length; i++) {
            var val = history[i];
            if (val === null) continue;
            var x = (i / (SPARKLINE_MAX - 1)) * w;
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
                    // Put 0 (unknown) at the bottom
                    var sa = a.signal === 0 ? -999 : a.signal;
                    var sb = b.signal === 0 ? -999 : b.signal;
                    return sb - sa;
                case "signal-asc":
                    var sa2 = a.signal === 0 ? 1 : a.signal;
                    var sb2 = b.signal === 0 ? 1 : b.signal;
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
            var key = d.mac || d.key || ("dev-" + Math.random());
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

            html += '<div class="device-row" data-phy="' + (d.phy || "") + '" data-device-key="' + escapeHtml(key) + '">';
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

        // Stop audio
        if (audioGain) audioGain.gain.value = 0;

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
