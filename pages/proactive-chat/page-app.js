(function () {
    "use strict";

    var DEFAULT_URL = "http://127.0.0.1:4100/";
    var state = {
        bridge: null,
        payload: null,
        webUrl: DEFAULT_URL
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function text(id, value) {
        var node = byId(id);
        if (node) node.textContent = value == null || value === "" ? "--" : String(value);
    }

    function normalizePayload(payload) {
        if (!payload || typeof payload !== "object") return {};
        if (payload.ok === true && payload.data && typeof payload.data === "object") {
            return payload.data;
        }
        if (payload.success === true && payload.data && typeof payload.data === "object") {
            return payload.data;
        }
        return payload;
    }

    function waitBridge(timeoutMs) {
        return new Promise(function (resolve) {
            var started = Date.now();
            if (window.AstrBotPluginPage) {
                resolve(window.AstrBotPluginPage);
                return;
            }
            var timer = setInterval(function () {
                if (window.AstrBotPluginPage) {
                    clearInterval(timer);
                    resolve(window.AstrBotPluginPage);
                    return;
                }
                if (Date.now() - started > timeoutMs) {
                    clearInterval(timer);
                    resolve(null);
                }
            }, 80);
        });
    }

    function deriveReachableUrl(webAdmin) {
        webAdmin = webAdmin || {};
        var port = Number(webAdmin.port || 4100);
        if (webAdmin.bind_all && window.location && window.location.hostname) {
            return window.location.protocol + "//" + window.location.hostname + ":" + port + "/";
        }
        return webAdmin.url || DEFAULT_URL;
    }

    function renderFrame(url) {
        var wrap = byId("frame-wrap");
        if (!wrap) return;
        wrap.innerHTML = "";
        var frame = document.createElement("iframe");
        frame.title = "主动消息 Web 管理端";
        frame.src = url;
        wrap.appendChild(frame);
    }

    function render(payload) {
        payload = payload || {};
        var status = payload.status || {};
        var webAdmin = payload.web_admin || {};
        var jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
        var sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        var url = deriveReachableUrl(webAdmin);
        state.webUrl = url;

        text("page-subtitle", "已连接 Pages，复用现有 Web 管理端");
        text("running-value", status.running ? "运行中" : "未运行");
        text("version-value", "版本 " + (status.version || "--"));
        text("jobs-value", jobs.length || status.jobs_count || 0);
        text("sessions-value", "会话 " + (sessions.length || status.sessions_count || 0));
        text("web-value", webAdmin.running ? "已启动" : (webAdmin.enabled ? "待启动" : "已禁用"));
        text("web-hint", url);

        var openButton = byId("open-button");
        if (openButton) openButton.href = url;
        renderFrame(url);
    }

    function renderFallback(message) {
        text("page-subtitle", message || "未连接 Pages bridge，使用默认 Web 管理端地址");
        text("running-value", "未知");
        text("version-value", "版本 --");
        text("jobs-value", "--");
        text("sessions-value", "会话 --");
        text("web-value", "默认入口");
        text("web-hint", DEFAULT_URL);
        var openButton = byId("open-button");
        if (openButton) openButton.href = DEFAULT_URL;
        renderFrame(DEFAULT_URL);
    }

    function loadDashboard() {
        if (!state.bridge || typeof state.bridge.apiGet !== "function") {
            renderFallback("AstrBot Pages bridge 未注入，使用默认 Web 管理端地址");
            return Promise.resolve();
        }
        return Promise.resolve(state.bridge.apiGet("dashboard"))
            .then(function (payload) {
                state.payload = normalizePayload(payload);
                render(state.payload);
            })
            .catch(function (error) {
                renderFallback(error && error.message ? error.message : "读取 Pages 状态失败");
            });
    }

    function init() {
        var openButton = byId("open-button");
        if (openButton) openButton.href = DEFAULT_URL;
        var refreshButton = byId("refresh-button");
        if (refreshButton) refreshButton.addEventListener("click", loadDashboard);

        waitBridge(5000).then(function (bridge) {
            state.bridge = bridge;
            if (bridge && typeof bridge.ready === "function") {
                Promise.resolve(bridge.ready()).finally(loadDashboard);
            } else {
                loadDashboard();
            }
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
