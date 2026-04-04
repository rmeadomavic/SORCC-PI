/* Argus Dashboard — Operations Tab Controller */

(function () {
    "use strict";

    // ── State ───────────────────────────────────────────────
    var activeSubTab = "live";
    var activeFilter = "all";
    var activeSort = "packets";
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
                // Fetch logs when switching to logs tab
                if (target === "logs") {
                    fetchLogs();
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
        if (window.ARGUS.getActiveTab() !== "operations") return;
        if (activeSubTab !== "live" && activeSubTab !== "spectrum") return;
        if (deviceFetchInFlight) return;
        deviceFetchInFlight = true;

        fetch("/api/devices", {
            signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
        })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .then(function (devices) {
                if (!Array.isArray(devices)) throw new Error("Invalid response");
                deviceFetchInFlight = false;
                lastDevices = devices;
                updateSignalHistory(devices);
                renderDevices(devices);
                updateStats(devices);
                renderSpectrum(devices);
            })
            .catch(function () {
                deviceFetchInFlight = false;
                // Keep last-known-good data — don't blank the list
                // Only show error if we've NEVER had data
                if (lastDevices.length === 0) {
                    var list = document.getElementById("device-list");
                    if (list) {
                        var el = document.createElement("div");
                        el.className = "loading";
                        el.textContent = "Connecting to Kismet...";
                        list.textContent = "";
                        list.appendChild(el);
                    }
                }
            });
    }

    // Rolling average for new/min smoothing
    var newPerMinSamples = [];
    var NEW_PER_MIN_WINDOW = 5; // average over 5 samples

    function updateStats(devices) {
        var wifi = 0, bt = 0, other = 0, active = 0;
        var categories = {};
        devices.forEach(function (d) {
            var phy = (d.phy || "").toLowerCase();
            if (phy.indexOf("802.11") !== -1) wifi++;
            else if (phy.indexOf("bluetooth") !== -1) bt++;
            else other++;
            // "Active" = devices with any packets (being tracked by Kismet)
            if (d.packets && d.packets > 0) active++;
            // Category breakdown
            var cat = d.category || "other";
            categories[cat] = (categories[cat] || 0) + 1;
        });

        // New devices per minute — smoothed with rolling average
        var now = Date.now();
        var elapsed = (now - lastCountTime) / 60000;
        if (elapsed > 0.25) {
            var diff = Math.max(0, devices.length - prevDeviceCount);
            var rate = Math.round(diff / elapsed);
            newPerMinSamples.push(rate);
            if (newPerMinSamples.length > NEW_PER_MIN_WINDOW) newPerMinSamples.shift();
            var sum = 0;
            for (var i = 0; i < newPerMinSamples.length; i++) sum += newPerMinSamples[i];
            newPerMinute = Math.round(sum / newPerMinSamples.length);
            prevDeviceCount = devices.length;
            lastCountTime = now;
        }

        setStatValue("stat-total", devices.length);
        setStatValue("stat-wifi", wifi);
        setStatValue("stat-bt", bt);
        setStatValue("stat-other", other);
        setStatValue("stat-strong", active);
        // Update strong label to say "Tracked" (devices with packets)
        var strongLabel = document.querySelector("#stat-strong")
        if (strongLabel) {
            var labelEl = strongLabel.parentElement && strongLabel.parentElement.querySelector(".stat-card-label");
            if (labelEl) labelEl.textContent = "Tracked";
        }
        var newEl = document.getElementById("stat-new");
        if (newEl) newEl.textContent = newPerMinute > 0 ? "+" + newPerMinute : "0";

        // Update leaderboard — top 8 by packet count
        renderLeaderboard(devices);

        // Update export tab status bar
        var exportCount = document.getElementById("export-device-count");
        if (exportCount) exportCount.textContent = devices.length;
        var exportLocated = document.getElementById("export-located-count");
        if (exportLocated) {
            var located = devices.filter(function (d) { return d.lat && d.lon && d.lat !== 0; });
            exportLocated.textContent = located.length;
        }
        var exportGps = document.getElementById("export-gps-state");
        if (exportGps) {
            // GPS state comes from status polling — just show device-based info
            var hasLocated = devices.some(function (d) { return d.lat && d.lon && d.lat !== 0; });
            exportGps.textContent = hasLocated ? "Fix available" : "No fix (indoor)";
            exportGps.style.color = hasLocated ? "var(--argus-green-light)" : "var(--signal-warm)";
        }
    }

    function renderLeaderboard(devices) {
        var listEl = document.getElementById("leaderboard-list");
        var badgeEl = document.getElementById("leaderboard-count");
        if (!listEl) return;

        var top = devices.slice().sort(function (a, b) {
            return (b.packets || 0) - (a.packets || 0);
        }).slice(0, 8);

        if (badgeEl) badgeEl.textContent = "Top " + top.length;

        if (top.length === 0) {
            listEl.textContent = "";
            var empty = document.createElement("div");
            empty.className = "leaderboard-empty";
            empty.textContent = "Waiting for data...";
            listEl.appendChild(empty);
            return;
        }

        var maxPkts = top[0].packets || 1;
        listEl.textContent = "";

        top.forEach(function (d, i) {
            var row = document.createElement("div");
            row.className = "leaderboard-row";
            if (d.activity && d.activity >= 2) row.classList.add("leaderboard-hot");

            var rank = document.createElement("span");
            rank.className = "leaderboard-rank";
            rank.textContent = "#" + (i + 1);
            row.appendChild(rank);

            var icon = document.createElement("span");
            icon.className = "leaderboard-device-icon";
            icon.textContent = d.icon || "\uD83D\uDCE1";
            row.appendChild(icon);

            var info = document.createElement("span");
            info.className = "leaderboard-info";
            var fullName = d.manufacturer && d.manufacturer !== "Random BLE" ? d.manufacturer : (d.name || d.mac || "Unknown");
            var name = fullName.length > 18 ? fullName.substring(0, 16) + "\u2026" : fullName;
            info.textContent = name;
            info.title = fullName + (d.mac ? " (" + d.mac + ")" : "");
            row.appendChild(info);

            var bar = document.createElement("span");
            bar.className = "leaderboard-bar";
            var fill = document.createElement("span");
            fill.className = "leaderboard-bar-fill";
            fill.style.width = Math.round(((d.packets || 0) / maxPkts) * 100) + "%";
            bar.appendChild(fill);
            row.appendChild(bar);

            var pkts = document.createElement("span");
            pkts.className = "leaderboard-pkts";
            pkts.textContent = (d.packets || 0).toLocaleString();
            row.appendChild(pkts);

            listEl.appendChild(row);
        });
    }

    // Animated count-up with easing + pulse glow on change
    var statAnimations = {};  // id → current animation frame

    function setStatValue(id, value) {
        var el = document.getElementById(id);
        if (!el) return;
        var current = parseInt(el.textContent, 10);
        if (isNaN(current)) current = 0;
        if (current === value) return;

        // Cancel any running animation for this element
        if (statAnimations[id]) {
            cancelAnimationFrame(statAnimations[id]);
            statAnimations[id] = null;
        }

        // Pulse the card on change
        var card = el.closest(".stat-card");
        if (card) {
            card.classList.remove("stat-pulse");
            void card.offsetWidth; // force reflow to restart animation
            card.classList.add("stat-pulse");
        }

        // Animate count from current → value
        var start = current;
        var diff = value - start;
        var duration = Math.min(600, Math.max(200, Math.abs(diff) * 3));
        var startTime = null;

        function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

        function step(ts) {
            if (!startTime) startTime = ts;
            var progress = Math.min(1, (ts - startTime) / duration);
            var eased = easeOutCubic(progress);
            el.textContent = Math.round(start + diff * eased);
            if (progress < 1) {
                statAnimations[id] = requestAnimationFrame(step);
            } else {
                el.textContent = value;
                statAnimations[id] = null;
            }
        }
        statAnimations[id] = requestAnimationFrame(step);
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
        var color = trending > 3 ? "var(--signal-hot)" : trending < -3 ? "var(--signal-cold)" : "var(--argus-green-light, #A6BC92)";

        return '<svg class="sparkline" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
            '<polyline points="' + points.join(" ") + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
            '</svg>';
    }

    function renderDevices(devices) {
        var list = document.getElementById("device-list");
        var count = document.getElementById("device-count");
        if (!list) return;

        var escapeHtml = window.ARGUS.escapeHtml;
        var signalToPercent = window.ARGUS.signalToPercent;

        // Filter by PHY type or frequency band
        var filtered = devices;
        if (activeFilter !== "all") {
            if (activeFilter.indexOf("band:") === 0) {
                // Frequency band filter — use classifyBand
                var bandFilter = activeFilter.substring(5);
                filtered = devices.filter(function (d) {
                    var band = classifyBand(d);
                    if (bandFilter === "fpv") {
                        return band === "915mhz" || band === "868mhz" || band === "5.8fpv" || band === "2.4elrs";
                    }
                    return band === bandFilter;
                });
            } else {
                // PHY type filter (legacy: Bluetooth, IEEE802.11, etc.)
                filtered = devices.filter(function (d) {
                    return d.phy && d.phy.toLowerCase().indexOf(activeFilter.toLowerCase()) !== -1;
                });
            }
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
                    var sa2 = (a.signal === 0 || a.signal == null) ? 999 : a.signal;
                    var sb2 = (b.signal === 0 || b.signal == null) ? 999 : b.signal;
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

        // Build lookup map from ALL devices (not just filtered) so detail panel works across filters
        deviceMap = {};
        devices.forEach(function (d) {
            var key = d.mac || d.key || ("dev-" + (d.name || "") + "-" + (d.phy || "") + "-" + (d.channel || ""));
            deviceMap[key] = d;
        });

        var html = "";
        filtered.forEach(function (d) {
            var key = d.mac || d.key || ("dev-" + (d.name || "") + "-" + (d.phy || "") + "-" + (d.channel || ""));

            var sig = d.signal || 0;
            var noSignal = (sig === 0 || sig === undefined || sig === null);
            var packets = d.packets || 0;
            var activity = d.activity || 0;
            var manufacturer = d.manufacturer || "";
            var category = d.category || "other";
            var icon = d.icon || "";

            // Display name: prefer manufacturer + type, then device name, then MAC
            var displayName = "";
            if (manufacturer && manufacturer !== "Random BLE") {
                displayName = manufacturer;
                if (d.name && d.name !== d.mac && d.name.indexOf(":") === -1) {
                    displayName += " — " + d.name;
                }
            } else if (d.name && d.name !== d.mac && d.name.indexOf(":") === -1) {
                displayName = d.name;
            } else {
                displayName = d.mac || "Unknown";
            }

            // Meta line: MAC + category + packets
            var meta = d.mac || "";
            if (category !== "other" && category !== "unknown") meta += " | " + category;
            if (d.channel && d.channel !== "FHSS") meta += " | Ch " + d.channel;
            meta += " | " + packets + " pkts";
            if (d.is_new) meta += " | NEW";

            // Activity bar instead of signal bar
            // Map packets logarithmically: 1→5%, 10→25%, 100→50%, 1000→75%, 10000→100%
            var pktPct = packets > 0 ? Math.min(100, Math.max(5, Math.log10(packets) * 25)) : 0;
            var actColor = activity >= 3 ? "var(--signal-hot)" : activity >= 2 ? "var(--signal-warm)" : activity >= 1 ? "var(--argus-green-light)" : "var(--text-dim)";
            var actCls = activity >= 2 ? "strong" : activity >= 1 ? "medium" : "weak";

            // For WiFi devices with real signal, use signal display
            var signalDisplay = "";
            if (!noSignal) {
                signalDisplay = sig + "";
                actCls = sig > -50 ? "strong" : sig > -70 ? "medium" : "weak";
                var sigPct = ((sig + 100) / 80) * 100;
                pktPct = Math.max(0, Math.min(100, sigPct));
                actColor = sig > -50 ? "var(--signal-hot)" : sig > -70 ? "var(--signal-warm)" : "var(--signal-cold)";
            } else {
                signalDisplay = packets > 0 ? packets + "" : "—";
            }

            var sparkSvg = buildSparklineSVG(key);

            html += '<div class="device-row' + (d.is_new ? ' device-new' : '') + '" data-phy="' + escapeHtml(d.phy || "") + '" data-device-key="' + escapeHtml(key) + '">';
            html += '  <div class="device-signal ' + actCls + '">' + (icon ? '<span class="device-icon">' + icon + '</span>' : '') + '<span>' + escapeHtml(signalDisplay) + '</span></div>';
            html += '  <div class="device-sparkline-wrap">';
            if (sparkSvg) {
                html += sparkSvg;
            } else {
                html += '    <div class="device-bar-container"><div class="device-bar" style="width:' + Math.round(pktPct) + '%;background:' + actColor + '"></div></div>';
            }
            html += '  </div>';
            html += '  <div class="device-info">';
            html += '    <div class="device-name">' + escapeHtml(displayName) + '</div>';
            html += '    <div class="device-meta">' + escapeHtml(meta) + '</div>';
            html += '  </div>';
            html += '  <div class="device-type">' + escapeHtml(d.type || d.phy || "") + '</div>';
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
            var query = ssidInput.value.trim();
            if (!query) {
                ssidInput.focus();
                ssidInput.style.borderColor = "var(--danger)";
                window.ARGUS.showToast("Enter a target SSID or MAC address", "error");
                setTimeout(function () { ssidInput.style.borderColor = ""; }, 2000);
                return;
            }
            startHunt(query);
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
        var huntIdle = document.getElementById("hunt-idle");
        if (huntIdle) huntIdle.style.display = "none";
        rssiHistory = [];
        prevSignal = -100;
        huntDeltaHistory = [];

        // Clear any existing hunt interval to prevent parallel hunts
        if (huntInterval) clearInterval(huntInterval);
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
        var huntIdle = document.getElementById("hunt-idle");
        if (huntIdle) huntIdle.style.display = "";
        var huntDisplay = document.getElementById("hunt-display");
        if (huntDisplay) huntDisplay.style.display = "none";
    }

    var huntPollInFlight = false;
    var huntConsecutiveErrors = 0;
    var huntDeltaHistory = [];

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
            sigValue.textContent = data.mode === "mac" ? "-- pkts" : "-- dBm";
            sigHint.textContent = "Searching...";
            sigHint.className = "signal-hint searching";
            if (status) status.textContent = "Not Found";
            if (audioGain) audioGain.gain.value = 0;
            return;
        }

        var sig = data.signal;
        var isBtHunt = (data.mode === "mac" && (sig === 0 || sig === -100));

        if (isBtHunt) {
            // BT hunt: packet delta rate as proximity indicator
            var pkts = data.packets || 0;
            var delta = data.packet_delta || 0;
            var act = data.activity || 0;
            var mfr = data.manufacturer || "";

            // Track delta history for trend detection
            if (!huntDeltaHistory) huntDeltaHistory = [];
            huntDeltaHistory.push(delta);
            if (huntDeltaHistory.length > 10) huntDeltaHistory.shift();

            // Calculate trend: compare recent vs older deltas
            var recentAvg = 0, olderAvg = 0;
            var mid = Math.floor(huntDeltaHistory.length / 2);
            if (huntDeltaHistory.length >= 4) {
                for (var hi = mid; hi < huntDeltaHistory.length; hi++) recentAvg += huntDeltaHistory[hi];
                recentAvg /= (huntDeltaHistory.length - mid);
                for (var lo = 0; lo < mid; lo++) olderAvg += huntDeltaHistory[lo];
                olderAvg /= mid;
            }
            var trending = recentAvg - olderAvg;

            // Map activity level to gauge percentage (more responsive)
            var pct = act >= 3 ? 85 : act >= 2 ? 60 : act >= 1 ? 35 : (pkts > 0 ? 10 : 0);
            updateGaugeArc(pct);
            sigValue.textContent = delta > 0 ? "+" + delta + " pkts/s" : pkts + " pkts";

            // Audio based on activity
            if (act >= 2) playTone(-40);
            else if (act >= 1) playTone(-65);
            else { if (audioGain) audioGain.gain.value = 0; }

            // Proximity hint with trend arrows
            var arrow = trending > 2 ? " \u2191\u2191" : trending > 0.5 ? " \u2191" : trending < -2 ? " \u2193\u2193" : trending < -0.5 ? " \u2193" : "";
            if (act >= 3) {
                sigHint.textContent = "HIGH ACTIVITY — VERY CLOSE" + arrow;
                sigHint.className = "signal-hint hot";
            } else if (act >= 2) {
                sigHint.textContent = (trending > 0 ? "GETTING CLOSER" : "NEARBY") + arrow;
                sigHint.className = "signal-hint hot";
            } else if (act >= 1) {
                sigHint.textContent = (trending > 0 ? "WARMING UP" : "LOW ACTIVITY") + arrow;
                sigHint.className = "signal-hint warm";
            } else {
                sigHint.textContent = pkts > 0 ? "IDLE — DEVICE QUIET" : "NO PACKETS YET";
                sigHint.className = "signal-hint cold";
            }

            if (peak) peak.textContent = pkts.toLocaleString() + " total" + (mfr ? " | " + mfr : "");
            // Track activity level as chart value
            rssiHistory.push(act >= 3 ? -30 : act >= 2 ? -50 : act >= 1 ? -70 : -100);
        } else {
            // WiFi hunt: use signal strength as before
            var pct = window.ARGUS.signalToPercent(sig);
            var sigDelta = sig - prevSignal;
            updateGaugeArc(pct);
            sigValue.textContent = sig + " dBm";
            playTone(sig);

            if (sig > -40) {
                sigHint.textContent = "ON TARGET";
                sigHint.className = "signal-hint hot";
            } else if (sig > -60) {
                sigHint.textContent = sigDelta > 1 ? "WARMER" : sigDelta < -1 ? "COOLER" : "WARM";
                sigHint.className = "signal-hint hot";
            } else if (sig > -75) {
                sigHint.textContent = sigDelta > 1 ? "GETTING WARMER" : sigDelta < -1 ? "GETTING COOLER" : "LUKEWARM";
                sigHint.className = "signal-hint warm";
            } else {
                sigHint.textContent = sigDelta > 1 ? "WARMING UP" : "COLD";
                sigHint.className = "signal-hint cold";
            }
            if (peak) peak.textContent = (data.max_signal || sig) + " dBm";
            rssiHistory.push(sig);
        }

        // Common stats
        if (status) status.textContent = "Tracking" + (data.manufacturer ? " (" + data.manufacturer + ")" : "");
        if (channel) channel.textContent = data.channel || "--";
        if (mac) mac.textContent = data.mac || "--";

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

        // "Hunt This Device" button — supports SSID or MAC
        var huntBtn = document.getElementById("detail-hunt-btn");
        if (huntBtn) {
            huntBtn.addEventListener("click", function () {
                var query = this.dataset.query;
                if (!query) return;
                closeDeviceDetail();
                // Switch to Hunt sub-tab
                var huntTab = document.querySelector('.sub-tab[data-subtab="hunt"]');
                if (huntTab) huntTab.click();
                // Populate query and start hunt
                var ssidInput = document.getElementById("target-ssid");
                if (ssidInput) {
                    ssidInput.value = query;
                    startHunt(query);
                }
            });
        }

        // "Copy MAC" button
        var copyBtn = document.getElementById("detail-copy-mac");
        if (copyBtn) {
            copyBtn.addEventListener("click", function () {
                var mac = document.getElementById("detail-mac");
                if (mac && mac.textContent !== "--") {
                    navigator.clipboard.writeText(mac.textContent).then(function () {
                        window.ARGUS.showToast("MAC copied: " + mac.textContent, "success");
                    }).catch(function () {
                        window.ARGUS.showToast("Copy failed — use Ctrl+C", "error");
                    });
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
                if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0 && window.ARGUS.centerMap) {
                    window.ARGUS.centerMap(lat, lon);
                }
            });
        }
    }

    function openDeviceDetail(d) {
        var overlay = document.getElementById("device-detail-overlay");
        if (!overlay) return;

        var name = d.name || d.ssid || d.mac || "Unknown";
        var noSignal = (d.signal === 0 || d.signal === undefined || d.signal === null);
        var key = d.mac || d.key;

        // Populate fields
        var displayName = d.icon ? d.icon + " " : "";
        displayName += d.manufacturer && d.manufacturer !== "Random BLE" ? d.manufacturer : name;
        setText("detail-name", displayName);
        setText("detail-mac", d.mac || "--");
        setText("detail-type", (d.manufacturer || "") + (d.manufacturer ? " \u00B7 " : "") + (d.phy || d.type || "--"));
        setText("detail-signal", noSignal ? (d.packets ? d.packets + " pkts" : "N/A") : d.signal + " dBm");
        setText("detail-channel", d.channel || "--");
        setText("detail-packets", d.packets != null ? d.packets.toLocaleString() : "--");
        setText("detail-last-seen", d.last_seen ? formatTimestamp(d.last_seen) : "--");
        setText("detail-first-seen", d.first_seen ? formatTimestamp(d.first_seen) : "--");
        setText("detail-activity", d.activity >= 2 ? "High" : d.activity >= 1 ? "Active" : d.packets > 0 ? "Idle" : "None");

        // Draw signal history sparkline
        var history = key ? signalHistory[key] : null;
        var sparkLine = document.getElementById("detail-spark-line");
        var trendEl = document.getElementById("detail-trend");
        if (sparkLine && history && history.length >= 2) {
            var w = 280, h = 50, minD = -100, maxD = -20, rng = maxD - minD;
            var pts = [];
            var validVals = history.filter(function (v) { return v !== null; });
            var denom = Math.max(history.length - 1, 1);
            for (var si = 0; si < history.length; si++) {
                if (history[si] === null) continue;
                var sx = (si / denom) * w;
                var sy = h - ((history[si] - minD) / rng) * h;
                sy = Math.max(1, Math.min(h - 1, sy));
                pts.push(Math.round(sx * 10) / 10 + "," + Math.round(sy * 10) / 10);
            }
            sparkLine.setAttribute("points", pts.join(" "));
            // Trend indicator
            if (trendEl && validVals.length >= 2) {
                var first = validVals[0], last = validVals[validVals.length - 1];
                var diff = last - first;
                trendEl.textContent = diff > 3 ? "\u2191 Stronger" : diff < -3 ? "\u2193 Weaker" : "\u2194 Stable";
                trendEl.style.color = diff > 3 ? "var(--signal-hot)" : diff < -3 ? "var(--signal-cold)" : "var(--text-dim)";
            }
        } else if (sparkLine) {
            sparkLine.setAttribute("points", "");
            if (trendEl) { trendEl.textContent = noSignal ? "No RSSI (BT)" : "Collecting..."; trendEl.style.color = ""; }
        }

        // Store data on action buttons for handlers
        var huntBtn = document.getElementById("detail-hunt-btn");
        if (huntBtn) {
            // For WiFi: hunt by SSID. For BT: hunt by MAC address.
            var isBt = (d.phy || "").toLowerCase().indexOf("bluetooth") !== -1;
            var huntQuery = isBt ? d.mac : (d.ssid || d.name || d.mac || "");
            huntBtn.dataset.query = huntQuery;
            huntBtn.disabled = !huntQuery;
            huntBtn.textContent = huntQuery ? "Hunt This Device" : "Cannot Hunt";
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
        { id: "2.4ghz",  label: "2.4 GHz WiFi",     color: "#4ade80", min: 2400, max: 2500 },
        { id: "5ghz",    label: "5 GHz WiFi",        color: "#42a5f5", min: 5150, max: 5850 },
        { id: "bt",      label: "Bluetooth",          color: "#a78bfa", min: 2402, max: 2480, phyMatch: "bluetooth" },
        { id: "433mhz",  label: "433 MHz ISM/TPMS",  color: "#f59e0b", min: 430, max: 440 },
        { id: "868mhz",  label: "868 MHz (EU CRSF)",  color: "#f97316", min: 863, max: 870 },
        { id: "915mhz",  label: "915 MHz (FPV/LoRa)", color: "#fb923c", min: 902, max: 928 },
        { id: "adsb",    label: "1090 ADS-B",         color: "#ef5350", min: 1088, max: 1092 },
        { id: "2.4elrs", label: "2.4 GHz ELRS/FPV",  color: "#22d3ee", min: 2400, max: 2500, phyMatch: "elrs" },
        { id: "5.8fpv",  label: "5.8 GHz FPV Video", color: "#e879f9", min: 5650, max: 5950 },
        { id: "other",   label: "Other",              color: "#6b7280", min: 0, max: 0 }
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
        if (mhz >= 5650 && mhz <= 5950) return "5.8fpv";
        if (mhz >= 902 && mhz <= 928) return "915mhz";
        if (mhz >= 863 && mhz <= 870) return "868mhz";
        if (mhz >= 430 && mhz <= 440) return "433mhz";
        if (mhz >= 1088 && mhz <= 1092) return "adsb";
        if (mhz > 0) return "other";
        // Last resort: classify by phy type
        if (phy.indexOf("802.11") !== -1) return "2.4ghz";
        if (phy.indexOf("rtl433") !== -1) return "433mhz";
        if (phy.indexOf("adsb") !== -1) return "adsb";
        return "other";
    }

    var spectrumMode = "auto";

    function getEffectiveSpectrumMode(devices) {
        if (spectrumMode !== "auto") return spectrumMode;
        // Auto-detect: prefer whichever data source has the most devices
        var btCount = 0, wifiCount = 0, otherCount = 0;
        devices.forEach(function (d) {
            var phy = (d.phy || "").toLowerCase();
            if (phy.indexOf("bluetooth") !== -1) btCount++;
            else if (phy.indexOf("802.11") !== -1) wifiCount++;
            else otherCount++;
        });
        if (wifiCount > btCount && wifiCount > 0) return "wifi-channels";
        if (btCount > 0) return "bt-activity";
        return "all-bands";
    }

    function renderSpectrum(devices) {
        if (activeSubTab !== "spectrum") return;
        var mode = getEffectiveSpectrumMode(devices);
        var titleEl = document.getElementById("spec-chart-title");
        if (titleEl) {
            var titles = {
                "bt-activity": "Bluetooth Activity",
                "wifi-channels": "WiFi Channel Utilization",
                "fpv-bands": "FPV / ISM Band Activity",
                "all-bands": "All Frequency Bands"
            };
            titleEl.textContent = titles[mode] || "Spectrum Activity";
        }
        renderChannelChart(devices, mode);
        renderBandDonut(devices);
        renderCategoryDonut(devices);
        renderSignalHeatmap(devices);
    }

    // ── Channel Utilization Bar Chart ──

    function renderChannelChart(devices, viewMode) {
        var svg = document.getElementById("channel-chart");
        if (!svg) return;

        var channelCounts = {};
        var chartMode = "category"; // default: show categories as bars

        if (viewMode === "wifi-channels") {
            // WiFi channels only
            devices.forEach(function (d) {
                var ch = d.channel;
                if (!ch) return;
                var phy = (d.phy || "").toLowerCase();
                if (phy.indexOf("802.11") === -1) return;
                channelCounts[ch] = (channelCounts[ch] || 0) + 1;
            });
            chartMode = "wifi";
        } else if (viewMode === "fpv-bands") {
            // Group by FPV-relevant bands
            var fpvBands = { "915 MHz": 0, "868 MHz": 0, "2.4 GHz": 0, "5.8 GHz": 0, "433 MHz": 0, "BT (telem)": 0 };
            devices.forEach(function (d) {
                var band = classifyBand(d);
                if (band === "915mhz") fpvBands["915 MHz"]++;
                else if (band === "868mhz") fpvBands["868 MHz"]++;
                else if (band === "2.4ghz" || band === "2.4elrs") fpvBands["2.4 GHz"]++;
                else if (band === "5.8fpv") fpvBands["5.8 GHz"]++;
                else if (band === "433mhz") fpvBands["433 MHz"]++;
                else if (band === "bt") fpvBands["BT (telem)"]++;
            });
            channelCounts = fpvBands;
        } else if (viewMode === "all-bands") {
            // All frequency bands
            devices.forEach(function (d) {
                var band = classifyBand(d);
                var label = band;
                for (var i = 0; i < BAND_DEFS.length; i++) {
                    if (BAND_DEFS[i].id === band) { label = BAND_DEFS[i].label; break; }
                }
                channelCounts[label] = (channelCounts[label] || 0) + 1;
            });
        } else {
            // bt-activity or auto fallback: device categories
            devices.forEach(function (d) {
                var cat = d.category || "other";
                channelCounts[cat] = (channelCounts[cat] || 0) + 1;
            });
        }

        // Sort: wifi numerically, everything else by count
        var channels;
        if (chartMode === "wifi") {
            channels = Object.keys(channelCounts).sort(function (a, b) {
                return parseInt(a, 10) - parseInt(b, 10);
            });
        } else {
            channels = Object.keys(channelCounts).filter(function (k) {
                return channelCounts[k] > 0;
            }).sort(function (a, b) {
                return channelCounts[b] - channelCounts[a];
            });
        }

        var badge = document.getElementById("spec-ch-count");
        if (badge) {
            if (chartMode === "wifi") {
                badge.textContent = channels.length + " channels";
            } else {
                var total = 0;
                channels.forEach(function (c) { total += channelCounts[c]; });
                badge.textContent = total + " devices";
            }
        }

        if (channels.length === 0) {
            svg.textContent = "";
            var noData = document.createElementNS("http://www.w3.org/2000/svg", "text");
            noData.setAttribute("x", "360"); noData.setAttribute("y", "100");
            noData.setAttribute("text-anchor", "middle"); noData.setAttribute("fill", "var(--text-dim)");
            noData.setAttribute("font-size", "14"); noData.textContent = "No devices detected yet";
            svg.appendChild(noData);
            return;
        }

        var maxCount = Math.max.apply(null, channels.map(function (ch) { return channelCounts[ch]; }));
        if (maxCount === 0) maxCount = 1;

        var W = 720, H = 220;
        var padL = 40, padR = 10, padT = 10, padB = 30;
        var chartW = W - padL - padR;
        var chartH = H - padT - padB;
        var maxBarW = chartMode === "bt" ? 60 : 32;
        var barW = Math.min(maxBarW, Math.floor(chartW / channels.length) - 4);
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
            // Channel/category label
            var label = chartMode === "wifi" ? "Ch" + ch : ch.charAt(0).toUpperCase() + ch.slice(1);
            html += '<text x="' + (x + barW / 2) + '" y="' + (H - 8) + '" text-anchor="middle" fill="var(--text-secondary)" font-size="' + (chartMode === "wifi" ? "10" : "9") + '" font-family="var(--font-mono)">' + label + '</text>';
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

    // ── Device Category Donut Chart ──

    var CATEGORY_DEFS = [
        { id: "phone",    label: "Phones",     color: "#4ade80", icon: "\uD83D\uDCF1" },
        { id: "laptop",   label: "Laptops",    color: "#42a5f5", icon: "\uD83D\uDCBB" },
        { id: "wearable", label: "Wearables",  color: "#a78bfa", icon: "\u231A" },
        { id: "speaker",  label: "Speakers",   color: "#f59e0b", icon: "\uD83D\uDD0A" },
        { id: "network",  label: "Network",    color: "#06b6d4", icon: "\uD83D\uDDA7" },
        { id: "tv",       label: "TVs/Display",color: "#ec4899", icon: "\uD83D\uDCFA" },
        { id: "iot",      label: "IoT Devices",color: "#14b8a6", icon: "\uD83D\uDD0C" },
        { id: "vehicle",  label: "Vehicles",   color: "#ef5350", icon: "\uD83D\uDE97" },
        { id: "other",    label: "Other/Unclassified", color: "#6b7280", icon: "\uD83D\uDCE1" }
    ];

    function renderCategoryDonut(devices) {
        var svg = document.getElementById("category-donut");
        var listEl = document.getElementById("category-list");
        var totalEl = document.getElementById("cat-donut-total");
        var badgeEl = document.getElementById("cat-device-count");
        if (!svg) return;

        var catCounts = {};
        CATEGORY_DEFS.forEach(function (c) { catCounts[c.id] = 0; });
        var classified = 0;
        devices.forEach(function (d) {
            var cat = (d.category || "other").toLowerCase();
            if (cat === "unknown") cat = "other";
            if (!catCounts.hasOwnProperty(cat)) cat = "other";
            catCounts[cat]++;
            if (cat !== "other") classified++;
        });

        var total = devices.length;
        if (totalEl) totalEl.textContent = total;
        if (badgeEl) badgeEl.textContent = classified + " classified";

        var cx = 120, cy = 120, r = 85, strokeW = 22;
        var circumference = 2 * Math.PI * r;
        var offset = 0;

        var sortedCats = CATEGORY_DEFS.filter(function (c) { return catCounts[c.id] > 0; });
        sortedCats.sort(function (a, b) { return catCounts[b.id] - catCounts[a.id]; });

        // Build SVG with safe DOM methods
        while (svg.firstChild) svg.removeChild(svg.firstChild);

        if (sortedCats.length === 0) {
            var emptyRing = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            emptyRing.setAttribute("cx", cx); emptyRing.setAttribute("cy", cy);
            emptyRing.setAttribute("r", r); emptyRing.setAttribute("fill", "none");
            emptyRing.setAttribute("stroke", "rgba(56,87,35,0.15)");
            emptyRing.setAttribute("stroke-width", strokeW);
            svg.appendChild(emptyRing);
        } else {
            var bgRing = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            bgRing.setAttribute("cx", cx); bgRing.setAttribute("cy", cy);
            bgRing.setAttribute("r", r); bgRing.setAttribute("fill", "none");
            bgRing.setAttribute("stroke", "rgba(38,38,38,0.8)");
            bgRing.setAttribute("stroke-width", strokeW);
            svg.appendChild(bgRing);

            sortedCats.forEach(function (cat) {
                var count = catCounts[cat.id];
                var pct = total > 0 ? count / total : 0;
                var segLen = pct * circumference;
                var gapLen = circumference - segLen;
                var seg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                seg.setAttribute("cx", cx); seg.setAttribute("cy", cy);
                seg.setAttribute("r", r); seg.setAttribute("fill", "none");
                seg.setAttribute("stroke", cat.color);
                seg.setAttribute("stroke-width", strokeW);
                seg.setAttribute("stroke-dasharray", segLen.toFixed(1) + " " + gapLen.toFixed(1));
                seg.setAttribute("stroke-dashoffset", (-offset).toFixed(1));
                seg.setAttribute("stroke-linecap", "round");
                seg.setAttribute("opacity", "0.85");
                seg.setAttribute("transform", "rotate(-90 " + cx + " " + cy + ")");
                var anim = document.createElementNS("http://www.w3.org/2000/svg", "animate");
                anim.setAttribute("attributeName", "stroke-dasharray");
                anim.setAttribute("from", "0 " + circumference);
                anim.setAttribute("to", segLen.toFixed(1) + " " + gapLen.toFixed(1));
                anim.setAttribute("dur", "0.6s"); anim.setAttribute("fill", "freeze");
                seg.appendChild(anim);
                svg.appendChild(seg);
                offset += segLen;
            });
        }

        // Category list using safe DOM methods
        if (listEl) {
            listEl.textContent = "";
            CATEGORY_DEFS.forEach(function (cat) {
                var count = catCounts[cat.id];
                if (count === 0) return;
                var pct = total > 0 ? Math.round((count / total) * 100) : 0;
                var row = document.createElement("div");
                row.className = "band-row";
                var dot = document.createElement("span");
                dot.className = "band-dot";
                dot.style.background = cat.color;
                row.appendChild(dot);
                var label = document.createElement("span");
                label.className = "band-label";
                label.textContent = cat.icon + " " + cat.label;
                row.appendChild(label);
                var countEl = document.createElement("span");
                countEl.className = "band-count";
                countEl.textContent = count;
                row.appendChild(countEl);
                var pctEl = document.createElement("span");
                pctEl.className = "band-pct";
                pctEl.textContent = pct + "%";
                row.appendChild(pctEl);
                listEl.appendChild(row);
            });
        }
    }

    // ── Signal Heatmap Grid ──

    function renderSignalHeatmap(devices) {
        var svg = document.getElementById("signal-heatmap");
        if (!svg) return;

        // Frequency band heatmap — works with WiFi, BT, SDR, and FPV data
        // Rows = frequency bands, Columns = activity buckets (packet count ranges)
        var actBuckets = [
            { label: "1-10",      min: 1, max: 10 },
            { label: "11-50",     min: 11, max: 50 },
            { label: "51-200",    min: 51, max: 200 },
            { label: "201-1K",    min: 201, max: 1000 },
            { label: "1K+",       min: 1001, max: Infinity }
        ];

        // Count devices per band × activity bucket
        var bandIds = BAND_DEFS.filter(function (b) { return b.id !== "other"; }).map(function (b) { return b.id; });
        var bandLabels = {};
        var bandColors = {};
        BAND_DEFS.forEach(function (b) { bandLabels[b.id] = b.label; bandColors[b.id] = b.color; });

        var grid = {};
        var bandTotals = {};
        bandIds.forEach(function (band) {
            grid[band] = {};
            bandTotals[band] = 0;
            actBuckets.forEach(function (b) { grid[band][b.label] = 0; });
        });

        devices.forEach(function (d) {
            var band = classifyBand(d);
            if (band === "other" || !grid[band]) return;
            var pkts = d.packets || 0;
            bandTotals[band]++;
            for (var i = 0; i < actBuckets.length; i++) {
                if (pkts >= actBuckets[i].min && pkts <= actBuckets[i].max) {
                    grid[band][actBuckets[i].label]++;
                    break;
                }
            }
        });

        // Filter to bands that have devices
        var activeBands = bandIds.filter(function (b) { return bandTotals[b] > 0; });

        if (activeBands.length === 0) {
            svg.textContent = "";
            var noData = document.createElementNS("http://www.w3.org/2000/svg", "text");
            noData.setAttribute("x", "200"); noData.setAttribute("y", "90");
            noData.setAttribute("text-anchor", "middle"); noData.setAttribute("fill", "var(--text-dim)");
            noData.setAttribute("font-size", "14"); noData.textContent = "No device data for heatmap";
            svg.appendChild(noData);
            return;
        }

        var maxCell = 1;
        activeBands.forEach(function (band) {
            actBuckets.forEach(function (b) {
                if (grid[band][b.label] > maxCell) maxCell = grid[band][b.label];
            });
        });

        var W = 400, H = Math.max(160, activeBands.length * 32 + 50);
        var padL = 110, padR = 10, padT = 10, padB = 35;
        var gridW = W - padL - padR;
        var gridH = H - padT - padB;
        var cellW = gridW / actBuckets.length;
        var cellH = Math.min(28, gridH / activeBands.length);

        var html = '';

        // Column headers (activity buckets)
        actBuckets.forEach(function (b, col) {
            var x = padL + col * cellW;
            html += '<text x="' + (x + cellW / 2) + '" y="' + (H - 8) + '" text-anchor="middle" fill="var(--text-dim)" font-size="9" font-family="var(--font-mono)">' + b.label + ' pkts</text>';
        });

        // Rows (frequency bands)
        activeBands.forEach(function (band, row) {
            var y = padT + row * cellH;
            // Band label + total count
            html += '<text x="' + (padL - 6) + '" y="' + (y + cellH / 2 + 3) + '" text-anchor="end" fill="' + (bandColors[band] || '#999') + '" font-size="9" font-weight="600" font-family="var(--font-mono)">' + (bandLabels[band] || band) + ' (' + bandTotals[band] + ')</text>';

            actBuckets.forEach(function (b, col) {
                var x = padL + col * cellW;
                var count = grid[band][b.label];
                var intensity = count / maxCell;

                var r_val, g_val, b_val;
                if (intensity === 0) {
                    r_val = 30; g_val = 30; b_val = 30;
                } else if (intensity < 0.5) {
                    r_val = 56; g_val = Math.round(87 + intensity * 200); b_val = 35;
                } else {
                    r_val = Math.round(56 + (intensity - 0.5) * 2 * 183);
                    g_val = Math.round(187 - (intensity - 0.5) * 2 * 100);
                    b_val = 35;
                }
                var cellColor = "rgb(" + r_val + "," + g_val + "," + b_val + ")";

                html += '<rect x="' + (x + 1) + '" y="' + (y + 1) + '" width="' + (cellW - 2) + '" height="' + (cellH - 2) + '" rx="2" fill="' + cellColor + '" opacity="' + (intensity === 0 ? 0.25 : 0.85) + '"/>';
                if (count > 0) {
                    html += '<text x="' + (x + cellW / 2) + '" y="' + (y + cellH / 2 + 3) + '" text-anchor="middle" fill="#fff" font-size="9" font-weight="700" font-family="var(--font-mono)">' + count + '</text>';
                }
            });
        });

        svg.setAttribute("viewBox", "0 0 " + W + " " + H);
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
                    window.ARGUS.showToast("Switched to profile: " + id, "success");
                    fetchProfiles();
                    if (data.errors && data.errors.length) {
                        window.ARGUS.showToast("Warning: " + data.errors[0], "info");
                    }
                } else {
                    window.ARGUS.showToast("Failed to switch profile: " + (data.detail || data.error || "Unknown error"), "error");
                }
            })
            .catch(function (err) {
                window.ARGUS.showToast("Profile switch failed: " + err.message, "error");
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
                        a.download = "argus-survey.kml";
                        a.click();
                        URL.revokeObjectURL(url);
                        btn.textContent = "Download KML File";
                        btn.disabled = false;
                        window.ARGUS.showToast("KML export complete", "success");
                    })
                    .catch(function (err) {
                        window.ARGUS.showToast("Export failed: " + err.message, "error");
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
                        a.download = "argus-survey.csv";
                        a.click();
                        URL.revokeObjectURL(url);
                        btn.textContent = "Download CSV File";
                        btn.disabled = false;
                        window.ARGUS.showToast("CSV export complete", "success");
                    })
                    .catch(function (err) {
                        window.ARGUS.showToast("Export failed: " + err.message, "error");
                        btn.textContent = "Download CSV File";
                        btn.disabled = false;
                    });
            });
        }
        // Waypoints button
        var wpBtn = document.getElementById("export-waypoints");
        if (wpBtn) {
            wpBtn.addEventListener("click", function () {
                var btn = this;
                btn.textContent = "Exporting..."; btn.disabled = true;
                fetch("/api/waypoints")
                    .then(function (r) {
                        if (!r.ok) return r.json().then(function (err) { throw new Error(err.detail || "No located devices"); });
                        return r.blob();
                    })
                    .then(function (blob) {
                        var url = URL.createObjectURL(blob);
                        var a = document.createElement("a"); a.href = url;
                        a.download = "argus-hunt-waypoints.waypoints"; a.click();
                        URL.revokeObjectURL(url);
                        btn.textContent = "Download Waypoints"; btn.disabled = false;
                        window.ARGUS.showToast("Waypoints export complete", "success");
                    })
                    .catch(function (err) {
                        window.ARGUS.showToast("Export failed: " + err.message, "error");
                        btn.textContent = "Download Waypoints"; btn.disabled = false;
                    });
            });
        }

        // CoT XML button
        var cotBtn = document.getElementById("export-cot");
        if (cotBtn) {
            cotBtn.addEventListener("click", function () {
                var btn = this;
                btn.textContent = "Exporting..."; btn.disabled = true;
                fetch("/api/cot")
                    .then(function (r) {
                        if (!r.ok) return r.json().then(function (err) { throw new Error(err.detail || "No located devices"); });
                        return r.blob();
                    })
                    .then(function (blob) {
                        var url = URL.createObjectURL(blob);
                        var a = document.createElement("a"); a.href = url;
                        a.download = "argus-cot.xml"; a.click();
                        URL.revokeObjectURL(url);
                        btn.textContent = "Download CoT XML"; btn.disabled = false;
                        window.ARGUS.showToast("CoT XML export complete", "success");
                    })
                    .catch(function (err) {
                        window.ARGUS.showToast("Export failed: " + err.message, "error");
                        btn.textContent = "Download CoT XML"; btn.disabled = false;
                    });
            });
        }
    }

    // ── WiFi Capture Toggle ────────────────────────────────

    var wifiCapturePolling = false;

    function updateWifiCaptureUI(data) {
        var statusEl = document.getElementById("wifi-capture-status");
        var btnEl = document.getElementById("wifi-capture-toggle");
        var btnText = document.getElementById("wifi-capture-btn-text");
        var warningEl = document.getElementById("wifi-capture-warning");
        var adapterEl = document.getElementById("wifi-adapter-info");
        var escapeHtml = window.ARGUS.escapeHtml;
        if (!statusEl || !btnEl) return;

        btnEl.disabled = false;

        if (data.active) {
            statusEl.textContent = "CAPTURING";
            statusEl.className = "wifi-capture-status active";
            btnText.textContent = "Disable";
            btnEl.className = "wifi-capture-btn capturing";
            warningEl.style.display = "none";
        } else {
            statusEl.textContent = "Capture OFF";
            statusEl.className = "wifi-capture-status inactive";
            btnText.textContent = "Enable Monitor Mode";
            btnEl.className = "wifi-capture-btn wifi-capture-warn";
            warningEl.style.display = "none";
        }

        // Show adapter detection info
        if (adapterEl) {
            var adapters = data.adapters || [];
            var externals = adapters.filter(function (a) { return !a.is_onboard; });
            var onboard = adapters.filter(function (a) { return a.is_onboard; });

            adapterEl.textContent = "";
            if (externals.length > 0) {
                var ext = externals[0];
                var badge = document.createElement("span");
                badge.className = "adapter-badge adapter-external";
                badge.textContent = (ext.interface || "?") + " (" + (ext.driver || "USB") + ") \u2014 Ready for capture";
                adapterEl.appendChild(badge);
                if (onboard.length > 0 && !data.active) {
                    var ob = document.createElement("span");
                    ob.className = "adapter-badge adapter-onboard";
                    ob.textContent = (onboard[0].interface || "wlan0") + " \u2014 connectivity";
                    adapterEl.appendChild(document.createTextNode(" "));
                    adapterEl.appendChild(ob);
                }
            } else if (onboard.length > 0) {
                var solo = document.createElement("span");
                solo.className = "adapter-badge adapter-onboard-only";
                solo.textContent = "Onboard only (brcmfmac) \u2014 plug in USB adapter for capture";
                adapterEl.appendChild(solo);
            } else {
                var none = document.createElement("span");
                none.className = "adapter-badge adapter-none";
                none.textContent = "No WiFi adapters detected";
                adapterEl.appendChild(none);
            }
        }
    }

    function pollWifiCaptureStatus() {
        if (wifiCapturePolling) return;
        wifiCapturePolling = true;
        fetch("/api/wifi-capture/status", {
            signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                wifiCapturePolling = false;
                updateWifiCaptureUI(data);
            })
            .catch(function () {
                wifiCapturePolling = false;
            });
    }

    function initWifiCapture() {
        var btnEl = document.getElementById("wifi-capture-toggle");
        var warningEl = document.getElementById("wifi-capture-warning");
        if (!btnEl) return;

        // Initial status check
        pollWifiCaptureStatus();

        btnEl.addEventListener("click", function () {
            var statusEl = document.getElementById("wifi-capture-status");
            var isCapturing = btnEl.classList.contains("capturing");

            // Show warning before enabling (not disabling)
            if (!isCapturing && warningEl && warningEl.style.display === "none") {
                warningEl.style.display = "";
                btnEl.querySelector("#wifi-capture-btn-text").textContent = "Confirm Enable";
                return;
            }

            // Do the toggle
            btnEl.disabled = true;
            statusEl.textContent = isCapturing ? "Restoring WiFi..." : "Switching to monitor...";
            statusEl.className = "wifi-capture-status";
            warningEl.style.display = "none";

            fetch("/api/wifi-capture/toggle", { method: "POST" })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (data.status === "ok") {
                        window.ARGUS.showToast(data.detail, "success");
                        updateWifiCaptureUI(data);
                    } else {
                        window.ARGUS.showToast(data.detail || "Toggle failed", "error");
                        btnEl.disabled = false;
                    }
                })
                .catch(function (err) {
                    window.ARGUS.showToast("WiFi capture toggle failed: " + err, "error");
                    btnEl.disabled = false;
                    pollWifiCaptureStatus();
                });
        });

        // Poll status periodically (every 15s) to stay in sync
        setInterval(pollWifiCaptureStatus, 15000);
    }

    // ── Activity Feed ──────────────────────────────────────

    function fetchActivityFeed() {
        if (window.ARGUS.getActiveTab() !== "operations") return;
        if (activeSubTab !== "live") return;

        fetch("/api/activity", {
            signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
        })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .then(function (data) {
                var countEl = document.getElementById("activity-new-count");
                if (countEl) {
                    countEl.textContent = (data.recent_1min || 0) + " new/min";
                }
                var scrollEl = document.getElementById("activity-feed-scroll");
                if (!scrollEl) return;

                var feed = data.feed || [];
                // Build using safe DOM methods
                scrollEl.textContent = "";
                feed.forEach(function (item) {
                    var ago = item.seconds_ago;
                    var timeStr = ago < 60 ? ago + "s" : Math.floor(ago / 60) + "m";
                    var mfr = item.manufacturer || "";
                    var cat = item.category || "";
                    var icon = cat === "phone" ? "\uD83D\uDCF1" : cat === "wearable" ? "\u231A" : cat === "laptop" ? "\uD83D\uDCBB" : cat === "speaker" ? "\uD83D\uDD0A" : cat === "network" ? "\uD83D\uDDA7" : "\uD83D\uDCE1";

                    var row = document.createElement("div");
                    row.className = "activity-feed-item";

                    var timeSpan = document.createElement("span");
                    timeSpan.className = "feed-time";
                    timeSpan.textContent = timeStr + " ago";
                    row.appendChild(timeSpan);

                    var iconSpan = document.createElement("span");
                    iconSpan.className = "feed-icon";
                    iconSpan.textContent = icon;
                    row.appendChild(iconSpan);

                    if (mfr && mfr !== "Random BLE") {
                        var mfrSpan = document.createElement("span");
                        mfrSpan.className = "feed-mfr";
                        mfrSpan.textContent = mfr + " ";
                        row.appendChild(mfrSpan);
                    }

                    var macSpan = document.createElement("span");
                    macSpan.className = "feed-mac";
                    macSpan.textContent = item.mac;
                    row.appendChild(macSpan);

                    scrollEl.appendChild(row);
                });
            })
            .catch(function () {}); // Silent fail — feed is supplementary
    }

    // ── Log Viewer ──────────────────────────────────────────

    var logPaused = false;
    var logPollTimer = null;
    var logRetryTimer = null;

    function initLogViewer() {
        var pauseBtn = document.getElementById("log-pause-btn");
        var refreshBtn = document.getElementById("log-refresh-btn");
        var clearBtn = document.getElementById("log-clear-btn");
        var levelFilter = document.getElementById("log-level-filter");

        if (pauseBtn) {
            pauseBtn.addEventListener("click", function () {
                logPaused = !logPaused;
                this.textContent = logPaused ? "\u25B6 Resume" : "\u23F8 Pause";
                var panel = document.querySelector(".log-panel");
                if (panel) panel.classList.toggle("log-paused", logPaused);
            });
        }

        if (refreshBtn) {
            refreshBtn.addEventListener("click", function () {
                fetchLogs();
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener("click", function () {
                var viewer = document.getElementById("log-viewer");
                if (viewer) viewer.textContent = "";
                var countEl = document.getElementById("log-entry-count");
                if (countEl) countEl.textContent = "0 entries";
            });
        }

        if (levelFilter) {
            levelFilter.addEventListener("change", function () {
                fetchLogs();
            });
        }
    }

    function fetchLogs() {
        if (window.ARGUS.getActiveTab() !== "operations") return;
        if (activeSubTab !== "logs") return;
        if (logPaused) return;

        var levelFilter = document.getElementById("log-level-filter");
        var level = levelFilter ? levelFilter.value : "";
        var url = "/api/logs?n=150" + (level ? "&level=" + level : "");

        fetch(url, {
            signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
        })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .then(function (data) {
                renderLogs(data.entries || data);
            })
            .catch(function (err) {
                var statusEl = document.getElementById("log-status");
                if (statusEl) statusEl.textContent = "Retrying... (" + (err.message || "connection error") + ")";
                // Auto-retry once after 3s — guard against stacking timers
                if (!logRetryTimer) {
                    logRetryTimer = setTimeout(function () {
                        logRetryTimer = null;
                        fetchLogs();
                    }, 3000);
                }
            });
    }

    function renderLogs(entries) {
        var viewer = document.getElementById("log-viewer");
        var statusEl = document.getElementById("log-status");
        var countEl = document.getElementById("log-entry-count");
        if (!viewer) return;

        var wasAtBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 30;

        viewer.textContent = "";

        if (!Array.isArray(entries) || entries.length === 0) {
            var empty = document.createElement("div");
            empty.className = "log-line log-dim";
            empty.textContent = "No log entries";
            viewer.appendChild(empty);
            if (statusEl) statusEl.textContent = "Updated " + new Date().toLocaleTimeString();
            if (countEl) countEl.textContent = "0 entries";
            return;
        }

        entries.forEach(function (entry) {
            var line = document.createElement("div");
            line.className = "log-line";

            // Format timestamp from epoch
            var timeStr = "";
            if (entry.ts) {
                var d = new Date(entry.ts * 1000);
                timeStr = d.toLocaleTimeString();
            } else {
                timeStr = entry.timestamp || entry.time || "";
            }

            var time = document.createElement("span");
            time.className = "log-time";
            time.textContent = timeStr;
            line.appendChild(time);

            var lvl = entry.level || "INFO";
            var level = document.createElement("span");
            level.className = "log-level log-level-" + lvl;
            level.textContent = lvl;
            line.appendChild(level);

            var msg = document.createElement("span");
            msg.className = "log-msg";
            msg.textContent = entry.msg || entry.message || "";
            line.appendChild(msg);

            viewer.appendChild(line);
        });

        // Auto-scroll to bottom if user was already at bottom
        if (wasAtBottom && !logPaused) {
            viewer.scrollTop = viewer.scrollHeight;
        }

        if (statusEl) statusEl.textContent = "Updated " + new Date().toLocaleTimeString();
        if (countEl) countEl.textContent = entries.length + " entries";
    }

    // ── Init ────────────────────────────────────────────────

    document.addEventListener("DOMContentLoaded", function () {
        initSubTabs();
        initFilters();
        initHunt();
        initDeviceDetail();
        initProfiles();
        initExport();
        initWifiCapture();
        initLogViewer();

        // Spectrum view mode selector
        var specDropdown = document.getElementById("spectrum-mode");
        if (specDropdown) {
            specDropdown.addEventListener("change", function () {
                spectrumMode = this.value;
            });
        }

        // Start device polling
        fetchDevices();
        devicePollTimer = setInterval(fetchDevices, 5000);

        // Start activity feed polling
        fetchActivityFeed();
        setInterval(fetchActivityFeed, 10000);

        // Start log polling (slower — every 5s, only when log tab visible)
        setInterval(fetchLogs, 5000);
    });

})();
