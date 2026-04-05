/* Argus Dashboard — Map View Controller (Enhanced) */

(function () {
    "use strict";

    var map = null;
    var positionMarker = null;
    var positionCircle = null;
    var deviceMarkers = [];
    var deviceRadii = [];
    var trackPoints = [];
    var trackLine = null;
    var trackDotsLayer = null;
    var trackEnabled = true;
    var showRadii = false;
    var showHeatmap = true;
    var heatLayer = null;
    var heatSamples = {};
    var HEAT_CELL_PRECISION = 5; // ~1.1m at equator
    var HEAT_STALE_SECONDS = 15 * 60; // 15 min retention
    var HEAT_MAX_CELLS = 1500;
    var mapPollTimer = null;
    var mapInitialized = false;
    var tileLayer = null;
    var satelliteLayer = null;
    var isSatellite = false;

    // Default center — Fort Campbell area (Argus home base)
    var DEFAULT_LAT = 36.6636;
    var DEFAULT_LON = -87.4731;
    var DEFAULT_ZOOM = 13;
    var HAS_FIRST_FIX = false;

    // Fix Leaflet default icon path for local install
    function fixLeafletIcons() {
        if (typeof L === "undefined") return;
        delete L.Icon.Default.prototype._getIconUrl;
        L.Icon.Default.mergeOptions({
            iconRetinaUrl: "/static/lib/leaflet/marker-icon-2x.png",
            iconUrl: "/static/lib/leaflet/marker-icon.png",
            shadowUrl: "/static/lib/leaflet/marker-shadow.png"
        });
    }

    function signalColor(dbm) {
        if (dbm === 0) return "#888";        // unknown
        if (dbm > -50) return "#ef5350";     // hot/strong
        if (dbm > -70) return "#ff9800";     // warm/medium
        return "#42a5f5";                     // cold/weak
    }

    function signalRadius(dbm) {
        // Approximate coverage radius based on signal strength
        if (dbm === 0) return 15;
        if (dbm > -40) return 10;
        if (dbm > -50) return 20;
        if (dbm > -60) return 35;
        if (dbm > -70) return 50;
        if (dbm > -80) return 75;
        return 100;
    }

    function initMap() {
        if (typeof L === "undefined") return;
        if (mapInitialized) return;

        fixLeafletIcons();

        map = L.map("argus-map", {
            center: [DEFAULT_LAT, DEFAULT_LON],
            zoom: DEFAULT_ZOOM,
            zoomControl: true
        });

        // OpenStreetMap tiles — default
        tileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: "&copy; OpenStreetMap",
            maxZoom: 19
        }).addTo(map);

        // Satellite tiles (Esri) — toggled via button
        satelliteLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
            attribution: "&copy; Esri",
            maxZoom: 18
        });

        // GPS position marker — pulsing green dot
        positionMarker = L.circleMarker([0, 0], {
            radius: 8,
            fillColor: "#385723",
            color: "#A6BC92",
            weight: 3,
            opacity: 1,
            fillOpacity: 0.9
        });

        positionCircle = L.circle([0, 0], {
            radius: 30,
            color: "#385723",
            fillColor: "#385723",
            fillOpacity: 0.08,
            weight: 1,
            dashArray: "4, 4"
        });

        // GPS track line
        trackLine = L.polyline([], {
            color: "#385723",
            weight: 3,
            opacity: 0.7,
            dashArray: "5, 8"
        }).addTo(map);
        trackDotsLayer = L.layerGroup().addTo(map);
        heatLayer = L.layerGroup().addTo(map);

        // Controls
        bindMapControls();
        mapInitialized = true;
    }

    function bindMapControls() {
        var centerBtn = document.getElementById("map-center-gps");
        if (centerBtn) {
            centerBtn.addEventListener("click", function () {
                if (positionMarker && HAS_FIRST_FIX) {
                    map.setView(positionMarker.getLatLng(), 17);
                }
            });
        }

        var trackBtn = document.getElementById("map-toggle-track");
        if (trackBtn) {
            trackBtn.addEventListener("click", function () {
                trackEnabled = !trackEnabled;
                this.textContent = "Track: " + (trackEnabled ? "ON" : "OFF");
                this.classList.toggle("active", trackEnabled);
                if (!trackEnabled) {
                    trackLine.setLatLngs([]);
                    trackDotsLayer.clearLayers();
                    trackPoints = [];
                }
            });
        }

        var radiiBtn = document.getElementById("map-toggle-radii");
        if (radiiBtn) {
            radiiBtn.addEventListener("click", function () {
                showRadii = !showRadii;
                this.textContent = "Range: " + (showRadii ? "ON" : "OFF");
                this.classList.toggle("active", showRadii);
                // Clear existing radii if turning off
                if (!showRadii) {
                    deviceRadii.forEach(function (r) { map.removeLayer(r); });
                    deviceRadii = [];
                }
            });
        }

        var tileBtn = document.getElementById("map-toggle-tiles");
        if (tileBtn) {
            tileBtn.addEventListener("click", function () {
                isSatellite = !isSatellite;
                if (isSatellite) {
                    map.removeLayer(tileLayer);
                    satelliteLayer.addTo(map);
                    this.textContent = "Map: SAT";
                } else {
                    map.removeLayer(satelliteLayer);
                    tileLayer.addTo(map);
                    this.textContent = "Map: STD";
                }
                this.classList.toggle("active", isSatellite);
            });
        }

        var fitBtn = document.getElementById("map-fit-all");
        if (fitBtn) {
            fitBtn.addEventListener("click", function () {
                fitAllMarkers();
            });
        }

        var heatBtn = document.getElementById("map-toggle-heat");
        if (heatBtn) {
            heatBtn.addEventListener("click", function () {
                showHeatmap = !showHeatmap;
                this.textContent = "Heat: " + (showHeatmap ? "ON" : "OFF");
                this.classList.toggle("active", showHeatmap);
                renderHeatmap();
                updateMapStats();
            });
        }

        var clearHeatBtn = document.getElementById("map-clear-heat");
        if (clearHeatBtn) {
            clearHeatBtn.addEventListener("click", function () {
                heatSamples = {};
                renderHeatmap();
                updateMapStats();
            });
        }
    }

    function fitAllMarkers() {
        if (!map || deviceMarkers.length === 0) return;
        var group = L.featureGroup(deviceMarkers);
        if (positionMarker && positionMarker._map) {
            group.addLayer(positionMarker);
        }
        map.fitBounds(group.getBounds().pad(0.1));
    }

    function updateMapPosition() {
        fetch("/api/gps", { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined })
            .then(function (r) { return r.json(); })
            .then(function (gps) {
                if (!gps.lat || !gps.lon || !map) return;

                var latlng = L.latLng(gps.lat, gps.lon);

                positionMarker.setLatLng(latlng);
                positionCircle.setLatLng(latlng);

                if (!positionMarker._map) {
                    positionMarker.addTo(map);
                    positionCircle.addTo(map);
                }

                // Center on first fix
                if (!HAS_FIRST_FIX) {
                    map.setView(latlng, 17);
                    HAS_FIRST_FIX = true;
                }

                // Track
                if (trackEnabled) {
                    trackPoints.push(latlng);
                    if (trackPoints.length > 1000) trackPoints.shift();
                    trackLine.setLatLngs(trackPoints);
                    renderTrackDots();
                }

                // Update GPS info in stats
                var gpsInfo = document.getElementById("map-gps-info");
                if (gpsInfo) {
                    gpsInfo.textContent = "\u2705 GPS Fix: " + gps.lat.toFixed(5) + ", " + gps.lon.toFixed(5);
                    if (gps.alt) gpsInfo.textContent += " | " + gps.alt.toFixed(0) + "m";
                    gpsInfo.style.color = "";
                }

                positionMarker.bindPopup(
                    "<b>Argus Payload</b><br>" +
                    "Lat: " + gps.lat.toFixed(6) + "<br>" +
                    "Lon: " + gps.lon.toFixed(6) + "<br>" +
                    "Alt: " + (gps.alt ? gps.alt.toFixed(1) + "m" : "N/A") + "<br>" +
                    "Source: " + (gps.source || "GPS") + "<br>" +
                    "Track points: " + trackPoints.length
                );
            })
            .catch(function () {});
    }

    function updateMapDevices() {
        fetch("/api/devices/located", { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined })
            .then(function (r) { return r.json(); })
            .then(function (devices) {
                if (!map) return;

                // Clear old markers and radii
                deviceMarkers.forEach(function (m) { map.removeLayer(m); });
                deviceMarkers = [];
                deviceRadii.forEach(function (r) { map.removeLayer(r); });
                deviceRadii = [];

                accumulateHeatSamples(devices);
                renderHeatmap();
                updateMapStats(devices);

                devices.forEach(function (d) {
                    var color = signalColor(d.signal);
                    var name = escapeForPopup(d.name || d.mac);
                    var phyLabel = d.phy === "IEEE802.11" ? "WiFi" : d.phy || "Unknown";
                    var mfr = d.manufacturer || "";
                    var icon = d.icon || "";
                    var packets = d.packets || 0;

                    // Bubble size: logarithmic scale based on packet count
                    // 1 pkt → 4px, 10 → 7px, 100 → 10px, 1000 → 13px, 10000 → 16px
                    var markerSize = 4 + Math.log10(Math.max(1, packets)) * 3;

                    // Boost size for devices with real signal data
                    if (d.signal !== 0 && d.signal > -50) markerSize = Math.max(markerSize, 10);

                    var marker = L.circleMarker([d.lat, d.lon], {
                        radius: Math.round(markerSize),
                        fillColor: color,
                        color: color,
                        weight: 2,
                        opacity: 0.7,
                        fillOpacity: 0.55
                    }).addTo(map);

                    var sigText = d.signal === 0 ? "N/A" : d.signal + " dBm";
                    var displayName = mfr && mfr !== "Random BLE" ? mfr : name;

                    // Build popup with DOM methods for safety
                    var popupDiv = document.createElement("div");
                    popupDiv.style.cssText = "min-width:180px;font-family:system-ui,sans-serif;";

                    var titleLine = document.createElement("div");
                    titleLine.style.cssText = "font-size:13px;font-weight:700;color:" + color + ";margin-bottom:2px;";
                    titleLine.textContent = (icon ? icon + " " : "") + displayName;
                    popupDiv.appendChild(titleLine);

                    var macLine = document.createElement("div");
                    macLine.style.cssText = "font-family:monospace;font-size:11px;color:#aaa;margin-bottom:6px;";
                    macLine.textContent = d.mac || "";
                    popupDiv.appendChild(macLine);

                    var hr = document.createElement("hr");
                    hr.style.cssText = "border:none;border-top:1px solid #333;margin:4px 0;";
                    popupDiv.appendChild(hr);

                    var fields = [
                        ["Type", phyLabel],
                        ["Signal", sigText],
                        ["Channel", d.channel || "—"],
                        ["Packets", packets.toLocaleString()]
                    ];
                    fields.forEach(function (f) {
                        var row = document.createElement("div");
                        row.style.cssText = "font-size:11px;margin:2px 0;";
                        var label = document.createElement("b");
                        label.textContent = f[0] + ": ";
                        row.appendChild(label);
                        row.appendChild(document.createTextNode(f[1]));
                        popupDiv.appendChild(row);
                    });

                    marker.bindPopup(popupDiv);

                    deviceMarkers.push(marker);

                    // Signal radius circles (optional)
                    if (showRadii && d.signal !== 0) {
                        var radius = L.circle([d.lat, d.lon], {
                            radius: signalRadius(d.signal),
                            color: color,
                            fillColor: color,
                            fillOpacity: 0.06,
                            weight: 1,
                            dashArray: "3, 5"
                        }).addTo(map);
                        deviceRadii.push(radius);
                    }
                });
            })
            .catch(function () {});
    }

    function updateMapStats(devices) {
        var stats = document.getElementById("map-stats");
        if (!stats) return;
        var currentDevices = Array.isArray(devices) ? devices : [];
        var wifiCount = currentDevices.filter(function (d) { return d.phy === "IEEE802.11"; }).length;
        var btCount = currentDevices.filter(function (d) { return d.phy === "Bluetooth"; }).length;
        var otherCount = currentDevices.length - wifiCount - btCount;
        var parts = [];
        if (wifiCount) parts.push(wifiCount + " WiFi");
        if (btCount) parts.push(btCount + " BT");
        if (otherCount) parts.push(otherCount + " other");
        parts.push(Object.keys(heatSamples).length + " heat cells");
        stats.textContent = currentDevices.length + " located (" + parts.join(", ") + ")";
    }

    function renderTrackDots() {
        if (!trackDotsLayer) return;
        trackDotsLayer.clearLayers();
        if (!trackEnabled || trackPoints.length < 3) return;

        var stride = Math.max(1, Math.floor(trackPoints.length / 24));
        for (var i = 0; i < trackPoints.length; i += stride) {
            var point = trackPoints[i];
            var progress = i / Math.max(1, trackPoints.length - 1);
            L.circleMarker(point, {
                radius: 2 + progress * 2.5,
                color: "#A6BC92",
                weight: 1,
                opacity: 0.20 + progress * 0.35,
                fillOpacity: 0.12 + progress * 0.18
            }).addTo(trackDotsLayer);
        }
    }

    function normalizeSignalWeight(signal, packets) {
        var signalWeight = 0.15;
        if (typeof signal === "number" && signal !== 0) {
            // Map [-95, -35] dBm into [0.15, 1.0]
            signalWeight = (signal + 95) / 60;
            signalWeight = Math.max(0.15, Math.min(1.0, signalWeight));
        }
        var packetWeight = Math.log10(Math.max(1, packets || 1)) / 4;
        packetWeight = Math.max(0, Math.min(1, packetWeight));
        return signalWeight * 0.75 + packetWeight * 0.25;
    }

    function heatColor(intensity) {
        if (intensity > 0.75) return "#ef5350";
        if (intensity > 0.50) return "#ff9800";
        if (intensity > 0.30) return "#fbc02d";
        return "#42a5f5";
    }

    function pruneHeatSamples(nowSec) {
        var keys = Object.keys(heatSamples);
        if (!keys.length) return;

        keys.forEach(function (key) {
            if ((nowSec - heatSamples[key].seen_at) > HEAT_STALE_SECONDS) {
                delete heatSamples[key];
            }
        });

        keys = Object.keys(heatSamples);
        if (keys.length <= HEAT_MAX_CELLS) return;

        keys.sort(function (a, b) {
            return heatSamples[b].seen_at - heatSamples[a].seen_at;
        });
        for (var i = HEAT_MAX_CELLS; i < keys.length; i++) {
            delete heatSamples[keys[i]];
        }
    }

    function accumulateHeatSamples(devices) {
        if (!Array.isArray(devices) || devices.length === 0) return;

        var nowSec = Date.now() / 1000;
        devices.forEach(function (d) {
            if (typeof d.lat !== "number" || typeof d.lon !== "number") return;
            var key = d.lat.toFixed(HEAT_CELL_PRECISION) + "," + d.lon.toFixed(HEAT_CELL_PRECISION);
            var sampleWeight = normalizeSignalWeight(d.signal, d.packets);
            var existing = heatSamples[key];
            if (!existing) {
                heatSamples[key] = {
                    lat: d.lat,
                    lon: d.lon,
                    intensity: sampleWeight,
                    seen_at: nowSec
                };
                return;
            }
            existing.intensity = (existing.intensity * 0.80) + (sampleWeight * 0.20);
            existing.seen_at = nowSec;
        });

        pruneHeatSamples(nowSec);
    }

    function renderHeatmap() {
        if (!heatLayer) return;
        heatLayer.clearLayers();
        if (!showHeatmap) return;

        var nowSec = Date.now() / 1000;
        var keys = Object.keys(heatSamples);
        if (!keys.length) return;

        keys.forEach(function (key) {
            var sample = heatSamples[key];
            var ageRatio = Math.min(1, Math.max(0, (nowSec - sample.seen_at) / HEAT_STALE_SECONDS));
            var ageMultiplier = 1 - (ageRatio * 0.65);
            var intensity = Math.max(0.08, sample.intensity * ageMultiplier);

            L.circleMarker([sample.lat, sample.lon], {
                radius: 7 + intensity * 15,
                color: heatColor(intensity),
                weight: 0,
                opacity: 0,
                fillOpacity: 0.05 + (intensity * 0.30)
            }).addTo(heatLayer);
        });
    }

    function escapeForPopup(str) {
        return str ? window.ARGUS.escapeHtml(str) : "";
    }

    function pollMap() {
        if (window.ARGUS.getActiveTab() !== "operations") return;
        updateMapPosition();
        updateMapDevices();
    }

    // ── Init ────────────────────────────────────────────────

    var observer = new MutationObserver(function () {
        var mapContainer = document.getElementById("subtab-map");
        if (mapContainer && mapContainer.classList.contains("active")) {
            if (!mapInitialized) {
                initMap();
            } else if (map) {
                map.invalidateSize();
            }
            if (!mapPollTimer) {
                pollMap();
                mapPollTimer = setInterval(pollMap, 5000);
            }
        } else {
            // Clear poll timer when map sub-tab is not active
            if (mapPollTimer) {
                clearInterval(mapPollTimer);
                mapPollTimer = null;
            }
        }
    });

    document.addEventListener("DOMContentLoaded", function () {
        var main = document.querySelector("main");
        if (main) {
            observer.observe(main, { subtree: true, attributes: true, attributeFilter: ["class"] });
        }

        // Expose centerMap for cross-module use (device detail → map)
        if (window.ARGUS) {
            window.ARGUS.centerMap = function (lat, lon) {
                if (!mapInitialized) initMap();
                if (map) {
                    map.setView([lat, lon], 18);
                    // Flash a temporary marker at the target location
                    var pulse = L.circleMarker([lat, lon], {
                        radius: 14,
                        fillColor: "#385723",
                        color: "#A6BC92",
                        weight: 3,
                        opacity: 1,
                        fillOpacity: 0.4
                    }).addTo(map);
                    setTimeout(function () { map.removeLayer(pulse); }, 3000);
                }
            };
        }
    });

})();
