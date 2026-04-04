/* Argus Dashboard — Instructor Overview Controller (Standalone) */

(function () {
    "use strict";

    // ── Constants ────────────────────────────────────────────
    var STORAGE_KEY = "argus-instructor-devices";
    var POLL_INTERVAL = 2000;
    var FETCH_TIMEOUT = 3000;
    var DASHBOARD_PORT = 8080;

    // ── State ───────────────────────────────────────────────
    var devices = [];
    var deviceStatus = {};
    var pollTimer = null;
    var alertLog = [];
    var MAX_ALERTS = 50;

    // ── Utilities ───────────────────────────────────────────

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    function timeAgo(date) {
        var seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return seconds + "s ago";
        if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
        return Math.floor(seconds / 3600) + "h ago";
    }

    // ── LocalStorage Management ─────────────────────────────

    function loadDevices() {
        try {
            var stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                devices = JSON.parse(stored);
            }
        } catch (e) {
            devices = [];
        }
        renderDeviceList();
        renderCards();
    }

    function saveDevices() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
        } catch (e) {
            // Storage full or unavailable
        }
    }

    // ── Device Management ───────────────────────────────────

    function addDevice(address) {
        address = address.trim();
        if (!address) return;

        // Normalize: strip protocol and trailing slashes
        address = address.replace(/^https?:\/\//, "").replace(/\/+$/, "");

        // Check for duplicates
        for (var i = 0; i < devices.length; i++) {
            if (devices[i].address === address) return;
        }

        devices.push({
            address: address,
            addedAt: new Date().toISOString()
        });
        saveDevices();
        renderDeviceList();
        renderCards();

        // Immediately poll the new device
        pollDevice(devices[devices.length - 1]);
    }

    function removeDevice(address) {
        devices = devices.filter(function (d) { return d.address !== address; });
        delete deviceStatus[address];
        saveDevices();
        renderDeviceList();
        renderCards();
    }

    // ── Device List (sidebar/input area) ────────────────────

    function renderDeviceList() {
        var list = document.getElementById("device-list");
        if (!list) return;

        if (devices.length === 0) {
            list.innerHTML = '<div class="empty-state">No devices added. Enter a Pi IP address above.</div>';
            return;
        }

        var html = "";
        devices.forEach(function (d) {
            html += '<div class="device-list-item">';
            html += '  <span class="device-address">' + escapeHtml(d.address) + '</span>';
            html += '  <button class="remove-device-btn" data-address="' + escapeHtml(d.address) + '" title="Remove">&#10005;</button>';
            html += '</div>';
        });
        list.innerHTML = html;

        // Bind remove buttons
        list.querySelectorAll(".remove-device-btn").forEach(function (btn) {
            btn.addEventListener("click", function () {
                removeDevice(this.dataset.address);
            });
        });
    }

    // ── Status Polling ──────────────────────────────────────

    function pollAllDevices() {
        devices.forEach(function (d) {
            pollDevice(d);
        });
    }

    function pollDevice(device) {
        var address = device.address;
        var url = "http://" + address + ":" + DASHBOARD_PORT + "/api/status";

        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT);

        fetch(url, {
            signal: controller.signal,
            mode: "cors"
        })
            .then(function (r) {
                clearTimeout(timeoutId);
                return r.json();
            })
            .then(function (status) {
                var prevStatus = deviceStatus[address];
                var wasOffline = !prevStatus || prevStatus.offline;

                deviceStatus[address] = {
                    data: status,
                    lastSeen: new Date(),
                    offline: false
                };

                // Alert: device came back online
                if (wasOffline && prevStatus) {
                    addAlert(address, "Device came back online", "info");
                }

                // Alert: GPS lost
                if (prevStatus && prevStatus.data && prevStatus.data.gps && !status.gps) {
                    addAlert(address, "GPS signal lost", "warn");
                }

                renderCards();
            })
            .catch(function () {
                clearTimeout(timeoutId);
                var prevStatus = deviceStatus[address];
                var wasOnline = prevStatus && !prevStatus.offline;

                deviceStatus[address] = {
                    data: prevStatus ? prevStatus.data : null,
                    lastSeen: prevStatus ? prevStatus.lastSeen : null,
                    offline: true
                };

                // Alert: device went offline
                if (wasOnline) {
                    addAlert(address, "Device went offline", "error");
                }

                renderCards();
            });
    }

    // ── Card Rendering ──────────────────────────────────────

    function renderCards() {
        var container = document.getElementById("device-cards");
        if (!container) return;

        if (devices.length === 0) {
            container.innerHTML = '<div class="empty-state">Add devices to monitor them here.</div>';
            return;
        }

        var html = "";
        devices.forEach(function (d) {
            var address = d.address;
            var info = deviceStatus[address] || { offline: true, data: null };
            var data = info.data || {};
            var offline = info.offline;

            html += '<div class="instructor-card' + (offline ? " offline" : "") + '">';

            if (offline) {
                html += '  <div class="offline-overlay">OFFLINE</div>';
            }

            // Header
            html += '  <div class="card-header">';
            html += '    <span class="card-hostname">' + escapeHtml(data.hostname || address) + '</span>';
            if (data.callsign) {
                html += '    <span class="card-callsign">' + escapeHtml(data.callsign) + '</span>';
            }
            html += '  </div>';

            // Status dots
            html += '  <div class="card-status-row">';
            html += '    <span class="status-dot-label">';
            html += '      <span class="dot ' + (data.kismet ? "active" : "error") + '"></span> Kismet';
            html += '    </span>';
            html += '    <span class="status-dot-label">';
            html += '      <span class="dot ' + (data.gps ? "active" : "error") + '"></span> GPS';
            html += '    </span>';
            html += '    <span class="status-dot-label">';
            html += '      <span class="dot ' + (data.modem ? "active" : "error") + '"></span> LTE';
            html += '    </span>';
            html += '  </div>';

            // Info row
            html += '  <div class="card-info-row">';

            // Battery
            var batText = "--";
            if (data.battery !== null && data.battery !== undefined) {
                batText = Math.round(data.battery) + "%";
            }
            html += '    <span class="card-info-item">Battery: ' + batText + '</span>';

            // Device count
            if (data.device_count !== undefined && data.device_count !== null) {
                html += '    <span class="card-info-item">Devices: ' + escapeHtml(String(data.device_count)) + '</span>';
            }

            // Active profile
            if (data.active_profile) {
                html += '    <span class="card-info-item">Profile: ' + escapeHtml(data.active_profile) + '</span>';
            }

            html += '  </div>';

            // Last seen
            if (info.lastSeen) {
                html += '  <div class="card-lastseen">Last seen: ' + timeAgo(info.lastSeen) + '</div>';
            }

            // Open dashboard link
            html += '  <div class="card-actions">';
            html += '    <a href="http://' + escapeHtml(address) + ':' + DASHBOARD_PORT + '" target="_blank" class="open-dashboard-btn">Open Dashboard</a>';
            html += '  </div>';

            html += '</div>';
        });

        container.innerHTML = html;
    }

    // ── Alert Feed ──────────────────────────────────────────

    function addAlert(address, message, type) {
        alertLog.unshift({
            address: address,
            message: message,
            type: type || "info",
            time: new Date()
        });

        if (alertLog.length > MAX_ALERTS) {
            alertLog = alertLog.slice(0, MAX_ALERTS);
        }

        renderAlerts();
    }

    function renderAlerts() {
        var container = document.getElementById("alert-feed");
        if (!container) return;

        if (alertLog.length === 0) {
            container.innerHTML = '<div class="empty-state">No alerts yet.</div>';
            return;
        }

        var html = "";
        alertLog.forEach(function (alert) {
            var typeClass = alert.type === "error" ? "alert-error" :
                            alert.type === "warn" ? "alert-warn" : "alert-info";
            html += '<div class="alert-item ' + typeClass + '">';
            html += '  <span class="alert-time">' + alert.time.toLocaleTimeString() + '</span>';
            html += '  <span class="alert-address">' + escapeHtml(alert.address) + '</span>';
            html += '  <span class="alert-message">' + escapeHtml(alert.message) + '</span>';
            html += '</div>';
        });

        container.innerHTML = html;
    }

    // ── Init ────────────────────────────────────────────────

    document.addEventListener("DOMContentLoaded", function () {
        loadDevices();

        // Add device form
        var addBtn = document.getElementById("add-device-btn");
        var addressInput = document.getElementById("device-address-input");

        if (addBtn && addressInput) {
            addBtn.addEventListener("click", function () {
                addDevice(addressInput.value);
                addressInput.value = "";
                addressInput.focus();
            });

            addressInput.addEventListener("keydown", function (e) {
                if (e.key === "Enter") {
                    addDevice(addressInput.value);
                    addressInput.value = "";
                }
            });
        }

        // Render initial empty alert feed
        renderAlerts();

        // Start polling
        pollAllDevices();
        pollTimer = setInterval(pollAllDevices, POLL_INTERVAL);
    });

})();
