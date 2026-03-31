/* SORCC-PI Dashboard — Settings Tab Controller */

(function () {
    "use strict";

    var activeSection = "general";

    // ── Section Navigation ──────────────────────────────────

    function initSections() {
        document.querySelectorAll(".settings-nav-btn").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var target = this.dataset.section;
                document.querySelectorAll(".settings-nav-btn").forEach(function (b) {
                    b.classList.remove("active");
                });
                document.querySelectorAll(".settings-section").forEach(function (s) {
                    s.classList.remove("active");
                });
                this.classList.add("active");
                var panel = document.getElementById("settings-" + target);
                if (panel) panel.classList.add("active");
                activeSection = target;
            });
        });
    }

    // ── Load Config into static form fields ─────────────────

    function loadConfig(retries) {
        retries = retries === undefined ? 2 : retries;
        fetch("/api/config/full", {
            signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined
        })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .then(function (config) {
                populateForm(config);
            })
            .catch(function (err) {
                if (retries > 0) {
                    setTimeout(function () { loadConfig(retries - 1); }, 2000);
                } else {
                    window.SORCC.showToast("Failed to load config: " + err.message, "error");
                }
            });
    }

    function populateForm(config) {
        // Map config keys to form field IDs — must match all inputs in settings.html
        var mapping = {
            "cfg-hostname":         { section: "general", key: "hostname" },
            "cfg-callsign":         { section: "general", key: "callsign" },
            "cfg-apn":              { section: "lte", key: "apn" },
            "cfg-sim-pin":          { section: "lte", key: "sim_pin" },
            "cfg-gps-port":         { section: "gps", key: "serial_port" },
            "cfg-gps-baud":         { section: "gps", key: "serial_baud" },
            "cfg-kismet-url":       { section: "kismet", key: "port" },
            "cfg-kismet-user":      { section: "kismet", key: "user" },
            "cfg-kismet-pass":      { section: "kismet", key: "pass" },
            "cfg-kismet-autostart": { section: "kismet", key: "autostart" },
            "cfg-dash-port":        { section: "dashboard", key: "port" },
            "cfg-dash-password":    { section: "dashboard", key: "password" },
            "cfg-poll-interval":    { section: "dashboard", key: "poll_interval" },
            "cfg-show-bt":          { section: "dashboard", key: "show_bluetooth" },
            "cfg-show-sdr":         { section: "dashboard", key: "show_sdr" },
            "cfg-ts-authkey":       { section: "tailscale", key: "authkey" },
            "cfg-ts-enabled":       { section: "tailscale", key: "enabled" },
            "cfg-pisugar-enabled":  { section: "pisugar", key: "enabled" },
            "cfg-pisugar-warn":     { section: "pisugar", key: "low_battery_warn" },
            "cfg-wifi-ssid":        { section: "wifi", key: "ssid" },
            "cfg-wifi-pass":        { section: "wifi", key: "password" },
            "cfg-wifi-country":     { section: "wifi", key: "country_code" },
        };

        Object.keys(mapping).forEach(function (fieldId) {
            var m = mapping[fieldId];
            var el = document.getElementById(fieldId);
            if (!el) return;
            var section = config[m.section];
            if (!section) return;
            var val = section[m.key];
            if (val === undefined || val === null) return;

            if (el.type === "checkbox") {
                el.checked = (val === true || val === "true" || val === "1");
            } else {
                el.value = val;
            }
        });
    }

    // ── Collect form values back to config ──────────────────

    function collectConfig() {
        var config = {};
        var mapping = {
            "cfg-hostname":         { section: "general", key: "hostname" },
            "cfg-callsign":         { section: "general", key: "callsign" },
            "cfg-apn":              { section: "lte", key: "apn" },
            "cfg-sim-pin":          { section: "lte", key: "sim_pin" },
            "cfg-gps-port":         { section: "gps", key: "serial_port" },
            "cfg-gps-baud":         { section: "gps", key: "serial_baud" },
            "cfg-kismet-url":       { section: "kismet", key: "port" },
            "cfg-kismet-user":      { section: "kismet", key: "user" },
            "cfg-kismet-pass":      { section: "kismet", key: "pass" },
            "cfg-kismet-autostart": { section: "kismet", key: "autostart" },
            "cfg-dash-port":        { section: "dashboard", key: "port" },
            "cfg-dash-password":    { section: "dashboard", key: "password" },
            "cfg-poll-interval":    { section: "dashboard", key: "poll_interval" },
            "cfg-show-bt":          { section: "dashboard", key: "show_bluetooth" },
            "cfg-show-sdr":         { section: "dashboard", key: "show_sdr" },
            "cfg-ts-authkey":       { section: "tailscale", key: "authkey" },
            "cfg-ts-enabled":       { section: "tailscale", key: "enabled" },
            "cfg-pisugar-enabled":  { section: "pisugar", key: "enabled" },
            "cfg-pisugar-warn":     { section: "pisugar", key: "low_battery_warn" },
            "cfg-wifi-ssid":        { section: "wifi", key: "ssid" },
            "cfg-wifi-pass":        { section: "wifi", key: "password" },
            "cfg-wifi-country":     { section: "wifi", key: "country_code" },
        };

        Object.keys(mapping).forEach(function (fieldId) {
            var m = mapping[fieldId];
            var el = document.getElementById(fieldId);
            if (!el) return;
            if (!config[m.section]) config[m.section] = {};

            if (el.type === "checkbox") {
                config[m.section][m.key] = el.checked ? "true" : "false";
            } else {
                config[m.section][m.key] = el.value;
            }
        });
        return config;
    }

    // ── Apply Config ────────────────────────────────────────

    function applyConfig() {
        var config = collectConfig();

        fetch("/api/config/full", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config)
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.status === "ok" || data.ok || data.success) {
                    window.SORCC.showToast("Configuration saved", "success");
                } else {
                    window.SORCC.showToast("Failed to save: " + (data.detail || data.error || "Unknown error"), "error");
                }
            })
            .catch(function (err) {
                window.SORCC.showToast("Save failed: " + err.message, "error");
            });
    }

    function factoryReset() {
        if (!window.confirm("Factory reset all configuration? This cannot be undone.")) return;

        fetch("/api/config/factory-reset", { method: "POST" })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.status === "ok" || data.ok || data.success) {
                    window.SORCC.showToast("Factory reset complete", "success");
                    loadConfig();
                } else {
                    window.SORCC.showToast("Factory reset failed", "error");
                }
            })
            .catch(function (err) {
                window.SORCC.showToast("Factory reset failed: " + err.message, "error");
            });
    }

    function applyWifi() {
        fetch("/api/wifi/apply", { method: "POST" })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.status === "ok") {
                    window.SORCC.showToast(data.detail, "success");
                } else {
                    window.SORCC.showToast(data.detail || "WiFi apply failed", "error");
                }
            })
            .catch(function (err) {
                window.SORCC.showToast("WiFi apply failed: " + err.message, "error");
            });
    }

    function restartLte() {
        fetch("/api/lte/restart", { method: "POST" })
            .then(function (r) {
                if (!r.ok) throw new Error("Not available");
                return r.json();
            })
            .then(function () {
                window.SORCC.showToast("LTE modem restarting...", "success");
            })
            .catch(function () {
                window.SORCC.showToast("Use terminal: sudo mmcli -m 0 --reset", "info");
            });
    }

    function exportConfig() {
        fetch("/api/config/export")
            .then(function (r) {
                if (!r.ok) throw new Error("Export failed");
                return r.blob();
            })
            .then(function (blob) {
                var url = URL.createObjectURL(blob);
                var a = document.createElement("a");
                a.href = url;
                a.download = "sorcc-config.json";
                a.click();
                URL.revokeObjectURL(url);
                window.SORCC.showToast("Config exported", "success");
            })
            .catch(function (err) {
                window.SORCC.showToast("Export failed: " + err.message, "error");
            });
    }

    function importConfig() {
        var input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.addEventListener("change", function () {
            if (!input.files || !input.files[0]) return;
            var reader = new FileReader();
            reader.onload = function (e) {
                try {
                    JSON.parse(e.target.result); // validate JSON
                } catch (err) {
                    window.SORCC.showToast("Invalid JSON file", "error");
                    return;
                }
                fetch("/api/config/import", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: e.target.result
                })
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        if (data.status === "ok" || data.ok || data.success) {
                            window.SORCC.showToast("Config imported — reloading...", "success");
                            loadConfig();
                        } else {
                            window.SORCC.showToast("Import failed: " + (data.detail || "Unknown error"), "error");
                        }
                    })
                    .catch(function (err) {
                        window.SORCC.showToast("Import failed: " + err.message, "error");
                    });
            };
            reader.readAsText(input.files[0]);
        });
        input.click();
    }

    // ── Init ────────────────────────────────────────────────

    document.addEventListener("DOMContentLoaded", function () {
        initSections();

        // Bind buttons (matching HTML IDs)
        var applyBtn = document.getElementById("btn-settings-apply");
        if (applyBtn) applyBtn.addEventListener("click", applyConfig);

        var resetBtn = document.getElementById("btn-settings-reset");
        if (resetBtn) resetBtn.addEventListener("click", function () {
            loadConfig();
            window.SORCC.showToast("Config reloaded", "info");
        });

        var factoryBtn = document.getElementById("btn-factory-reset");
        if (factoryBtn) factoryBtn.addEventListener("click", factoryReset);

        var exportBtn = document.getElementById("btn-config-export");
        if (exportBtn) exportBtn.addEventListener("click", exportConfig);

        var importBtn = document.getElementById("btn-config-import");
        if (importBtn) importBtn.addEventListener("click", importConfig);

        var lteBtn = document.getElementById("btn-restart-lte");
        if (lteBtn) lteBtn.addEventListener("click", restartLte);

        var wifiBtn = document.getElementById("btn-apply-wifi");
        if (wifiBtn) wifiBtn.addEventListener("click", function () {
            // Save config first, then apply WiFi only on success
            var config = collectConfig();
            fetch("/api/config/full", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(config)
            })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (data.status === "ok" || data.ok || data.success) {
                        window.SORCC.showToast("Config saved, applying WiFi...", "info");
                        setTimeout(applyWifi, 500);
                    } else {
                        window.SORCC.showToast("Config save failed — WiFi not applied", "error");
                    }
                })
                .catch(function (err) {
                    window.SORCC.showToast("Config save failed: " + err.message, "error");
                });
        });

        // Load config when settings tab is activated
        document.querySelectorAll(".tab").forEach(function (tab) {
            tab.addEventListener("click", function () {
                if (this.dataset.tab === "settings") {
                    loadConfig();
                }
            });
        });
    });

})();
