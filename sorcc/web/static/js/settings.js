/* SORCC-PI Dashboard — Settings Tab Controller */

(function () {
    "use strict";

    // ── State ───────────────────────────────────────────────
    var currentConfig = null;
    var activeSection = null;

    // Common APN values for datalist
    var commonApns = [
        "b2b.static",
        "fast.t-mobile.com",
        "wholesale",
        "hologram",
        "iot.1nce.net",
        "super",
        "broadband",
        "internet"
    ];

    // Fields that require a service restart when changed
    var restartFields = [
        "kismet.port", "kismet.sources", "gps.port", "gps.baud",
        "modem.apn", "network.hostname"
    ];

    // ── Section Navigation ──────────────────────────────────

    function initSections() {
        document.querySelectorAll(".settings-section-btn").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var target = this.dataset.section;
                document.querySelectorAll(".settings-section-btn").forEach(function (b) {
                    b.classList.remove("active");
                });
                document.querySelectorAll(".settings-section").forEach(function (s) {
                    s.classList.remove("active");
                });
                this.classList.add("active");
                var panel = document.getElementById("section-" + target);
                if (panel) panel.classList.add("active");
                activeSection = target;
            });
        });
    }

    // ── Load Config ─────────────────────────────────────────

    function loadConfig() {
        fetch("/api/config/full")
            .then(function (r) { return r.json(); })
            .then(function (config) {
                currentConfig = config;
                renderAllSections(config);
            })
            .catch(function (err) {
                window.SORCC.showToast("Failed to load config: " + err.message, "error");
            });
    }

    // ── Dynamic Form Rendering ──────────────────────────────

    function renderAllSections(config) {
        var container = document.getElementById("settings-forms");
        if (!container) return;

        var escapeHtml = window.SORCC.escapeHtml;
        var html = "";

        var sections = Object.keys(config);
        sections.forEach(function (sectionKey) {
            var sectionData = config[sectionKey];
            if (typeof sectionData !== "object" || sectionData === null) return;

            html += '<div class="settings-section" id="section-' + escapeHtml(sectionKey) + '">';
            html += '  <h3>' + escapeHtml(sectionKey.charAt(0).toUpperCase() + sectionKey.slice(1)) + '</h3>';

            var fields = Object.keys(sectionData);
            fields.forEach(function (fieldKey) {
                var value = sectionData[fieldKey];
                var fieldId = sectionKey + "." + fieldKey;
                var label = fieldKey.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });

                html += '<div class="form-group">';
                html += '  <label for="cfg-' + escapeHtml(fieldId) + '">' + escapeHtml(label) + '</label>';

                if (typeof value === "boolean") {
                    // Toggle switch for booleans
                    html += '  <label class="toggle-switch">';
                    html += '    <input type="checkbox" id="cfg-' + escapeHtml(fieldId) + '" data-field="' + escapeHtml(fieldId) + '"' + (value ? " checked" : "") + '>';
                    html += '    <span class="toggle-slider"></span>';
                    html += '  </label>';
                } else if (typeof value === "number") {
                    // Number input
                    html += '  <input type="number" id="cfg-' + escapeHtml(fieldId) + '" data-field="' + escapeHtml(fieldId) + '" value="' + value + '" class="form-input">';
                } else if (fieldKey === "password" || fieldKey === "pass" || fieldKey === "wifi_password" || fieldKey === "psk") {
                    // Password field
                    html += '  <input type="password" id="cfg-' + escapeHtml(fieldId) + '" data-field="' + escapeHtml(fieldId) + '" value="' + escapeHtml(String(value || "")) + '" class="form-input" autocomplete="off">';
                } else if (fieldKey === "apn") {
                    // APN with datalist
                    html += '  <input type="text" id="cfg-' + escapeHtml(fieldId) + '" data-field="' + escapeHtml(fieldId) + '" value="' + escapeHtml(String(value || "")) + '" class="form-input" list="apn-list">';
                    html += '  <datalist id="apn-list">';
                    commonApns.forEach(function (apn) {
                        html += '    <option value="' + escapeHtml(apn) + '">';
                    });
                    html += '  </datalist>';
                } else {
                    // Default text input
                    html += '  <input type="text" id="cfg-' + escapeHtml(fieldId) + '" data-field="' + escapeHtml(fieldId) + '" value="' + escapeHtml(String(value || "")) + '" class="form-input">';
                }

                html += '</div>';
            });

            html += '</div>';
        });

        container.innerHTML = html;

        // Activate first section or previously active section
        var sectionBtns = document.querySelectorAll(".settings-section-btn");
        if (sectionBtns.length > 0) {
            var targetSection = activeSection || sectionBtns[0].dataset.section;
            sectionBtns.forEach(function (b) {
                b.classList.remove("active");
                if (b.dataset.section === targetSection) b.classList.add("active");
            });
            var panel = document.getElementById("section-" + targetSection);
            if (panel) panel.classList.add("active");
        }
    }

    // ── Collect Form Values ─────────────────────────────────

    function collectFormValues() {
        var config = {};
        document.querySelectorAll("[data-field]").forEach(function (el) {
            var parts = el.dataset.field.split(".");
            var section = parts[0];
            var field = parts[1];

            if (!config[section]) config[section] = {};

            if (el.type === "checkbox") {
                config[section][field] = el.checked;
            } else if (el.type === "number") {
                config[section][field] = Number(el.value);
            } else {
                config[section][field] = el.value;
            }
        });
        return config;
    }

    // ── Apply Config ────────────────────────────────────────

    function applyConfig() {
        var newConfig = collectFormValues();

        // Check if any restart-required fields changed
        var needsRestart = false;
        if (currentConfig) {
            restartFields.forEach(function (fieldPath) {
                var parts = fieldPath.split(".");
                var section = parts[0];
                var field = parts[1];
                var oldVal = currentConfig[section] && currentConfig[section][field];
                var newVal = newConfig[section] && newConfig[section][field];
                if (oldVal !== undefined && String(oldVal) !== String(newVal)) {
                    needsRestart = true;
                }
            });
        }

        fetch("/api/config/full", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(newConfig)
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.ok || data.success) {
                    window.SORCC.showToast("Configuration saved", "success");
                    if (needsRestart) {
                        window.SORCC.showToast("Some changes require a service restart to take effect", "info");
                    }
                    currentConfig = newConfig;
                } else {
                    window.SORCC.showToast("Failed to save: " + (data.detail || data.error || "Unknown error"), "error");
                }
            })
            .catch(function (err) {
                window.SORCC.showToast("Save failed: " + err.message, "error");
            });
    }

    // ── Reset ───────────────────────────────────────────────

    function resetConfig() {
        loadConfig();
        window.SORCC.showToast("Configuration reloaded from server", "info");
    }

    // ── Factory Reset ───────────────────────────────────────

    function factoryReset() {
        if (!window.confirm("Are you sure you want to factory reset all configuration? This cannot be undone.")) {
            return;
        }

        fetch("/api/config/factory-reset", {
            method: "POST"
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.ok || data.success) {
                    window.SORCC.showToast("Factory reset complete. Reloading config...", "success");
                    loadConfig();
                } else {
                    window.SORCC.showToast("Factory reset failed: " + (data.detail || data.error || "Unknown error"), "error");
                }
            })
            .catch(function (err) {
                window.SORCC.showToast("Factory reset failed: " + err.message, "error");
            });
    }

    // ── Import / Export Config ───────────────────────────────

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
        var fileInput = document.getElementById("config-import-file");
        if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
            window.SORCC.showToast("Please select a config file first", "info");
            return;
        }

        var reader = new FileReader();
        reader.onload = function (e) {
            var configData;
            try {
                configData = JSON.parse(e.target.result);
            } catch (err) {
                window.SORCC.showToast("Invalid JSON file", "error");
                return;
            }

            fetch("/api/config/import", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(configData)
            })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (data.ok || data.success) {
                        window.SORCC.showToast("Config imported successfully", "success");
                        loadConfig();
                    } else {
                        window.SORCC.showToast("Import failed: " + (data.detail || data.error || "Unknown error"), "error");
                    }
                })
                .catch(function (err) {
                    window.SORCC.showToast("Import failed: " + err.message, "error");
                });
        };
        reader.readAsText(fileInput.files[0]);
    }

    // ── Restart LTE ─────────────────────────────────────────

    function restartLte() {
        fetch("/api/lte/restart", { method: "POST" })
            .then(function (r) {
                if (!r.ok) throw new Error("LTE restart endpoint not available");
                return r.json();
            })
            .then(function (data) {
                if (data.ok || data.success) {
                    window.SORCC.showToast("LTE modem restarting...", "success");
                } else {
                    window.SORCC.showToast("LTE restart failed: " + (data.detail || data.error || "Unknown error"), "error");
                }
            })
            .catch(function () {
                window.SORCC.showToast("LTE restart requires terminal access (sudo mmcli -m 0 --reset)", "info");
            });
    }

    // ── Init ────────────────────────────────────────────────

    function bindButtons() {
        var applyBtn = document.getElementById("settings-apply");
        if (applyBtn) applyBtn.addEventListener("click", applyConfig);

        var resetBtn = document.getElementById("settings-reset");
        if (resetBtn) resetBtn.addEventListener("click", resetConfig);

        var factoryBtn = document.getElementById("settings-factory-reset");
        if (factoryBtn) factoryBtn.addEventListener("click", factoryReset);

        var exportBtn = document.getElementById("config-export");
        if (exportBtn) exportBtn.addEventListener("click", exportConfig);

        var importBtn = document.getElementById("config-import");
        if (importBtn) importBtn.addEventListener("click", importConfig);

        var lteBtn = document.getElementById("restart-lte");
        if (lteBtn) lteBtn.addEventListener("click", restartLte);
    }

    document.addEventListener("DOMContentLoaded", function () {
        initSections();
        bindButtons();

        // Load config when settings tab is activated
        // Also watch for tab switches to reload config on entry
        document.querySelectorAll(".main-tab").forEach(function (tab) {
            tab.addEventListener("click", function () {
                if (this.dataset.tab === "settings") {
                    loadConfig();
                }
            });
        });

        // If settings tab is already active on load, fetch config
        if (window.SORCC.getActiveTab() === "settings") {
            loadConfig();
        }
    });

})();
