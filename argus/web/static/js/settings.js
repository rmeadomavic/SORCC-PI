/* Argus Dashboard — Settings Tab Controller */

(function () {
    "use strict";

    var activeSection = "general";
    var KISMET_PORT_MIN = 1;
    var KISMET_PORT_MAX = 65535;
    var schema = null;

    // Merged behavior: preserve Kismet port bounds while using schema-driven field mappings.
    // Schema-driven settings map: one source of truth for form IDs <-> config keys.
    var FIELD_MAP = [
        { id: "cfg-hostname", section: "general", key: "hostname" },
        { id: "cfg-callsign", section: "general", key: "callsign" },
        { id: "cfg-apn", section: "lte", key: "apn" },
        { id: "cfg-gps-port", section: "gps", key: "serial_port" },
        { id: "cfg-gps-baud", section: "gps", key: "serial_baud" },
        { id: "cfg-kismet-port", section: "kismet", key: "port" },
        { id: "cfg-kismet-user", section: "kismet", key: "user" },
        { id: "cfg-kismet-pass", section: "kismet", key: "pass" },
        { id: "cfg-dash-port", section: "dashboard", key: "port" },
        { id: "cfg-dash-password", section: "dashboard", key: "password" },
        { id: "cfg-ts-enabled", section: "tailscale", key: "enabled" },
        { id: "cfg-pisugar-enabled", section: "pisugar", key: "enabled" },
        { id: "cfg-wifi-ssid", section: "wifi", key: "ssid" },
        { id: "cfg-wifi-pass", section: "wifi", key: "password" },
        { id: "cfg-wifi-country", section: "wifi", key: "country_code" }
    ];

    // ── Section Navigation ──────────────────────────────────

    function syncSections(tabs, activeName) {
        tabs.forEach(function (tab) {
            var isActive = tab.dataset.section === activeName;
            tab.classList.toggle("active", isActive);
            tab.setAttribute("aria-selected", isActive ? "true" : "false");
            tab.setAttribute("tabindex", isActive ? "0" : "-1");
        });

        document.querySelectorAll(".settings-section").forEach(function (section) {
            section.classList.remove("active");
        });

        var panel = document.getElementById("settings-" + activeName);
        if (panel) panel.classList.add("active");
    }

    function focusSectionByOffset(tabs, currentTab, offset) {
        var index = tabs.indexOf(currentTab);
        if (index < 0) return;
        var nextIndex = (index + offset + tabs.length) % tabs.length;
        tabs[nextIndex].focus();
        tabs[nextIndex].click();
    }

    function initSections() {
        var tabs = Array.from(document.querySelectorAll(".settings-nav-btn"));
        tabs.forEach(function (btn) {
            btn.addEventListener("click", function () {
                var target = this.dataset.section;
                syncSections(tabs, target);
                activeSection = target;
            });

            btn.addEventListener("keydown", function (e) {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    focusSectionByOffset(tabs, this, 1);
                } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    focusSectionByOffset(tabs, this, -1);
                } else if (e.key === "Home") {
                    e.preventDefault();
                    tabs[0].focus();
                    tabs[0].click();
                } else if (e.key === "End") {
                    e.preventDefault();
                    tabs[tabs.length - 1].focus();
                    tabs[tabs.length - 1].click();
                }
            });
        });

        syncSections(tabs, activeSection);
    }

    // ── Load Config into static form fields ─────────────────

    function loadConfig(retries) {
        retries = retries === undefined ? 2 : retries;
        Promise.all([fetchSchema(), fetchConfig()])
            .then(function (results) {
                schema = results[0];
                populateForm(results[1]);
                validateFieldMap();
            })
            .catch(function (err) {
                if (retries > 0) {
                    setTimeout(function () { loadConfig(retries - 1); }, 2000);
                } else {
                    window.ARGUS.showToast("Failed to load config: " + err.message, "error");
                }
            });
    }

    function fetchConfig() {
        return fetch("/api/config/full", {
            signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined
        })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            });
    }

    function fetchSchema() {
        return fetch("/api/config/schema", {
            signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined
        })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            });
    }

    function showSaveWarnings(items) {
        var box = document.getElementById("settings-save-warnings");
        if (!box) return;
        if (!items || !items.length) {
            box.innerHTML = "";
            box.style.display = "none";
            return;
        }

        var html = "<strong>Saved with warnings:</strong><ul>" + items.map(function (item) {
            return "<li>" + item + "</li>";
        }).join("") + "</ul>";
        box.innerHTML = html;
        box.style.display = "block";
    }

    function validateFieldMap() {
        if (!schema || !schema.sections) return;
        var unknown = [];
        FIELD_MAP.forEach(function (entry) {
            if (!schema.sections[entry.section] || !schema.sections[entry.section][entry.key]) {
                unknown.push(entry.section + "." + entry.key + " (mapped from #" + entry.id + ")");
            }
        });
        if (unknown.length) {
            showSaveWarnings(["UI mapping drift detected: " + unknown.join(", ")]);
        }
    }

    function populateForm(config) {
        FIELD_MAP.forEach(function (m) {
            var el = document.getElementById(m.id);
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
        FIELD_MAP.forEach(function (m) {
            var el = document.getElementById(m.id);
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

    function validateKismetPort(config) {
        if (!config || !config.kismet) return null;
        var portRaw = config.kismet.port;
        if (portRaw === undefined || portRaw === null || portRaw === "") return null;

        var port = Number(portRaw);
        if (!Number.isInteger(port) || port < KISMET_PORT_MIN || port > KISMET_PORT_MAX) {
            return "Kismet port must be an integer between " + KISMET_PORT_MIN + " and " + KISMET_PORT_MAX + ".";
        }
        return null;
    }

    // ── Apply Config ────────────────────────────────────────

    function applyConfig() {
        var config = collectConfig();
        var kismetError = validateKismetPort(config);
        if (kismetError) {
            window.ARGUS.showToast(kismetError, "error");
            return;
        }

        fetch("/api/config/full", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config)
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.status === "ok" || data.ok || data.success) {
                    var warnings = []
                        .concat(data.skipped || [])
                        .concat(data.validation_warnings || [])
                        .concat(data.validation_errors || []);
                    showSaveWarnings(warnings);
                    window.ARGUS.showToast("Configuration saved", "success");
                } else {
                    window.ARGUS.showToast("Failed to save: " + (data.detail || data.error || "Unknown error"), "error");
                }
            })
            .catch(function (err) {
                window.ARGUS.showToast("Save failed: " + err.message, "error");
            });
    }

    function extractImportError(data, fallback) {
        if (!data) return fallback;
        if (typeof data.detail === "string" && data.detail.trim()) return data.detail;
        if (typeof data.error === "string" && data.error.trim()) return data.error;
        if (Array.isArray(data.errors) && data.errors.length) return data.errors.join("; ");
        if (Array.isArray(data.validation_errors) && data.validation_errors.length) return data.validation_errors.join("; ");
        return fallback;
    }

    function factoryReset() {
        if (!window.confirm("Factory reset all configuration? This cannot be undone.")) return;

        fetch("/api/config/factory-reset", { method: "POST" })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.status === "ok" || data.ok || data.success) {
                    window.ARGUS.showToast("Factory reset complete", "success");
                    loadConfig();
                } else {
                    window.ARGUS.showToast("Factory reset failed", "error");
                }
            })
            .catch(function (err) {
                window.ARGUS.showToast("Factory reset failed: " + err.message, "error");
            });
    }

    function applyWifi() {
        fetch("/api/wifi/apply", { method: "POST" })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.status === "ok") {
                    window.ARGUS.showToast(data.detail, "success");
                } else {
                    window.ARGUS.showToast(data.detail || "WiFi apply failed", "error");
                }
            })
            .catch(function (err) {
                window.ARGUS.showToast("WiFi apply failed: " + err.message, "error");
            });
    }

    function restartLte() {
        fetch("/api/lte/restart", { method: "POST" })
            .then(function (r) {
                if (!r.ok) throw new Error("Not available");
                return r.json();
            })
            .then(function () {
                window.ARGUS.showToast("LTE modem restarting...", "success");
            })
            .catch(function () {
                window.ARGUS.showToast("Use terminal: sudo mmcli -m 0 --reset", "info");
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
                a.download = "argus-config.json";
                a.click();
                URL.revokeObjectURL(url);
                window.ARGUS.showToast("Config exported", "success");
            })
            .catch(function (err) {
                window.ARGUS.showToast("Export failed: " + err.message, "error");
            });
    }

    function extractImportError(data, fallback) {
        if (!data) return fallback;
        var detail = data.detail || data.error || data.message;
        if (typeof detail === "string") return detail;
        if (detail && typeof detail === "object") {
            var parts = [];
            if (detail.message) parts.push(detail.message);
            if (Array.isArray(detail.errors) && detail.errors.length) {
                parts.push(detail.errors.join("; "));
            }
            if (Array.isArray(detail.warnings) && detail.warnings.length) {
                parts.push("Warnings: " + detail.warnings.join("; "));
            }
            if (parts.length) return parts.join(" ");
        }
        return fallback;
    }

    function importConfig() {
        var input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.addEventListener("change", function () {
            if (!input.files || !input.files[0]) return;
            uploadConfigFile(input.files[0], true);
        });
        input.click();
    }

    function uploadConfigFile(file, reloadOnSuccess) {
        var reader = new FileReader();
        reader.onload = function (e) {
            try {
                JSON.parse(e.target.result); // validate JSON before upload
            } catch (err) {
                window.ARGUS.showToast("Invalid JSON file", "error");
                return;
            }

            var formData = new FormData();
            formData.append("file", file, file.name || "argus-config.json");

            fetch("/api/config/import", {
                method: "POST",
                body: formData
            })
                .then(function (r) {
                    if (r.status === 422 || r.status === 415) {
                        var detail = "Import expects multipart/form-data with a JSON file in the 'file' field.";
                        window.ARGUS.showToast("Import rejected (" + r.status + "): " + detail, "error");
                        var knownError = new Error(detail);
                        knownError.toastShown = true;
                        throw knownError;
                    }
                    return r.json().then(function (data) {
                        return { ok: r.ok, status: r.status, data: data };
                    });
                })
                .then(function (result) {
                    var data = result.data || {};
                    if (result.ok && (data.status === "ok" || data.ok || data.success)) {
                        if (reloadOnSuccess) {
                            window.ARGUS.showToast("Config imported — reloading...", "success");
                            loadConfig();
                        } else {
                            window.ARGUS.showToast("Round-trip check passed: export re-imported successfully", "success");
                        }
                    } else {
                        var reason = extractImportError(data, "HTTP " + result.status);
                        window.ARGUS.showToast("Import failed: " + reason, "error");
                    }
                })
                .catch(function (err) {
                    if (err && err.toastShown) return;
                    if (err && err.message) {
                        window.ARGUS.showToast("Import failed: " + err.message, "error");
                    }
                });
        };
        reader.readAsText(file);
    }

    function runConfigRoundTripCheck() {
        fetch("/api/config/export")
            .then(function (r) {
                if (!r.ok) throw new Error("Export failed with HTTP " + r.status);
                return r.blob();
            })
            .then(function (blob) {
                var roundTripFile = new File([blob], "argus-config-roundtrip.json", { type: "application/json" });
                uploadConfigFile(roundTripFile, false);
            })
            .catch(function (err) {
                window.ARGUS.showToast("Round-trip check failed: " + err.message, "error");
            });
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
            window.ARGUS.showToast("Config reloaded", "info");
        });

        var factoryBtn = document.getElementById("btn-factory-reset");
        if (factoryBtn) factoryBtn.addEventListener("click", factoryReset);

        var exportBtn = document.getElementById("btn-config-export");
        if (exportBtn) exportBtn.addEventListener("click", exportConfig);

        var importBtn = document.getElementById("btn-config-import");
        if (importBtn) importBtn.addEventListener("click", importConfig);

        var roundTripBtn = document.getElementById("btn-config-roundtrip");
        if (roundTripBtn) roundTripBtn.addEventListener("click", runConfigRoundTripCheck);

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
                        window.ARGUS.showToast("Config saved, applying WiFi...", "info");
                        setTimeout(applyWifi, 500);
                    } else {
                        window.ARGUS.showToast("Config save failed — WiFi not applied", "error");
                    }
                })
                .catch(function (err) {
                    window.ARGUS.showToast("Config save failed: " + err.message, "error");
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
