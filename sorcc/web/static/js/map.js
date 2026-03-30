/* SORCC-PI Dashboard — Map View Controller (Enhanced) */

(function () {
    "use strict";

    var map = null;
    var positionMarker = null;
    var positionCircle = null;
    var deviceMarkers = [];
    var deviceRadii = [];
    var trackPoints = [];
    var trackLine = null;
    var trackEnabled = true;
    var showRadii = false;
    var mapPollTimer = null;
    var mapInitialized = false;
    var tileLayer = null;
    var satelliteLayer = null;
    var isSatellite = false;

    // Default center — will recenter on first GPS fix
    var DEFAULT_LAT = 39.8283;
    var DEFAULT_LON = -98.5795;
    var DEFAULT_ZOOM = 4;
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

        map = L.map("sorcc-map", {
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
                }

                // Update GPS info in stats
                var gpsInfo = document.getElementById("map-gps-info");
                if (gpsInfo) {
                    gpsInfo.textContent = gps.lat.toFixed(5) + ", " + gps.lon.toFixed(5);
                    if (gps.alt) gpsInfo.textContent += " | " + gps.alt.toFixed(0) + "m";
                }

                positionMarker.bindPopup(
                    "<b>SORCC Payload</b><br>" +
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

                // Update stats
                var stats = document.getElementById("map-stats");
                if (stats) {
                    var wifiCount = devices.filter(function (d) { return d.phy === "IEEE802.11"; }).length;
                    var btCount = devices.filter(function (d) { return d.phy === "Bluetooth"; }).length;
                    var otherCount = devices.length - wifiCount - btCount;
                    var parts = [];
                    if (wifiCount) parts.push(wifiCount + " WiFi");
                    if (btCount) parts.push(btCount + " BT");
                    if (otherCount) parts.push(otherCount + " other");
                    stats.textContent = devices.length + " located (" + (parts.join(", ") || "none") + ")";
                }

                devices.forEach(function (d) {
                    var color = signalColor(d.signal);
                    var name = escapeForPopup(d.name || d.mac);
                    var phyLabel = d.phy === "IEEE802.11" ? "WiFi" : d.phy || "Unknown";

                    // Marker size based on signal strength
                    var markerSize = d.signal === 0 ? 5 :
                                     d.signal > -50 ? 8 :
                                     d.signal > -70 ? 6 : 5;

                    var marker = L.circleMarker([d.lat, d.lon], {
                        radius: markerSize,
                        fillColor: color,
                        color: "#fff",
                        weight: 1,
                        opacity: 0.9,
                        fillOpacity: 0.85
                    }).addTo(map);

                    var sigText = d.signal === 0 ? "N/A" : d.signal + " dBm";

                    marker.bindPopup(
                        "<div style='min-width:160px'>" +
                        "<b style='font-size:14px;color:" + color + "'>" + name + "</b><br>" +
                        "<span style='font-family:monospace;font-size:11px;color:#aaa'>" + escapeForPopup(d.mac) + "</span><br>" +
                        "<hr style='border:none;border-top:1px solid #333;margin:6px 0'>" +
                        "<b>Type:</b> " + escapeForPopup(phyLabel) + "<br>" +
                        "<b>Signal:</b> " + sigText + "<br>" +
                        "<b>Channel:</b> " + escapeForPopup(d.channel) + "<br>" +
                        "<b>Packets:</b> " + d.packets +
                        "</div>"
                    );

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

    function escapeForPopup(str) {
        return str ? window.SORCC.escapeHtml(str) : "";
    }

    function pollMap() {
        if (window.SORCC.getActiveTab() !== "operations") return;
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
        }
    });

    document.addEventListener("DOMContentLoaded", function () {
        var main = document.querySelector("main");
        if (main) {
            observer.observe(main, { subtree: true, attributes: true, attributeFilter: ["class"] });
        }

        // Expose centerMap for cross-module use (device detail → map)
        if (window.SORCC) {
            window.SORCC.centerMap = function (lat, lon) {
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
