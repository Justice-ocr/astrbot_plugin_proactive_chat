(function () {
    "use strict";

    var PLUGIN_REPO = "https://github.com/DBJD-CR/astrbot_plugin_proactive_chat";
    var state = {
        view: "status",
        bridge: null,
        bridgeReady: false,
        error: "",
        status: {},
        jobs: [],
        sessions: [],
        notifications: [],
        notificationsMeta: {},
        config: null,
        configSchema: null,
        selectedSession: "",
        sessionDetail: null,
        markdownFiles: [],
        selectedMarkdownPath: "",
        markdownDocument: null,
        theme: safeStorageGet("theme") || "light",
        busy: {}
    };

    var viewMeta = {
        status: { label: "运行状态", icon: "📊", subtitle: "服务状态、调度概览与会话计时器" },
        tasks: { label: "任务管理", icon: "📋", subtitle: "查看、立即触发、重新调度或取消会话任务" },
        notifications: { label: "通知中心", icon: "🔔", subtitle: "同步插件通知、标记已读与快速刷新" },
        docs: { label: "文档浏览", icon: "📚", subtitle: "浏览 README、CHANGELOG 与 docs 目录文档" },
        config: { label: "配置管理", icon: "⚙️", subtitle: "编辑全局配置与会话差异配置" }
    };

    function safeStorageGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return "";
        }
    }

    function safeStorageSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {}
    }

    function $(id) {
        return document.getElementById(id);
    }

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function text(value, fallback) {
        if (value === null || value === undefined || value === "") return fallback || "--";
        return String(value);
    }

    function asArray(value) {
        return Array.isArray(value) ? value : [];
    }

    function setBusy(key, value) {
        state.busy[key] = Boolean(value);
        render();
    }

    function setError(message) {
        state.error = message || "";
        render();
    }

    function formatDuration(totalSeconds) {
        var seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        var days = Math.floor(seconds / 86400);
        var hours = Math.floor((seconds % 86400) / 3600);
        var minutes = Math.floor((seconds % 3600) / 60);
        var secs = seconds % 60;
        var parts = [];
        if (days) parts.push(days + "天");
        if (hours) parts.push(hours + "小时");
        if (minutes) parts.push(minutes + "分");
        if (secs || !parts.length) parts.push(secs + "秒");
        return parts.slice(0, 3).join("");
    }

    function formatDate(value) {
        if (!value) return "--";
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) return text(value);
        return date.toLocaleString("zh-CN", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        });
    }

    function normalizePayload(payload) {
        if (!payload || typeof payload !== "object") return payload || {};
        if (payload.error) {
            throw new Error(typeof payload.error === "string" ? payload.error : payload.error.message || "请求失败");
        }
        if (payload.ok === false || payload.success === false) {
            throw new Error(payload.message || "请求失败");
        }
        if (typeof payload.code === "number" && payload.code !== 0) {
            throw new Error(payload.message || payload.msg || "请求失败 (" + payload.code + ")");
        }
        if ((payload.ok === true || payload.success === true || payload.code === 0) && Object.prototype.hasOwnProperty.call(payload, "data")) {
            return payload.data || {};
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
            }, 60);
        });
    }

    function apiGet(endpoint) {
        if (!state.bridge || typeof state.bridge.apiGet !== "function") {
            return Promise.reject(new Error("AstrBot Pages bridge 未注入，请从 AstrBot WebUI 的插件页面重新打开。"));
        }
        return Promise.resolve(state.bridge.apiGet(endpoint)).then(normalizePayload);
    }

    function apiPost(endpoint, body) {
        if (!state.bridge || typeof state.bridge.apiPost !== "function") {
            return Promise.reject(new Error("AstrBot Pages bridge 未注入，请从 AstrBot WebUI 的插件页面重新打开。"));
        }
        return Promise.resolve(state.bridge.apiPost(endpoint, body || {})).then(normalizePayload);
    }

    function route(endpoint) {
        return endpoint;
    }

    function hideBoot() {
        var boot = $("loading-skeleton");
        if (!boot) return;
        boot.classList.add("is-exiting");
        setTimeout(function () {
            if (boot.parentNode) boot.parentNode.removeChild(boot);
        }, 220);
    }

    function initTheme() {
        document.body.classList.toggle("dark-theme", state.theme === "dark");
        document.documentElement.classList.toggle("theme-dark", state.theme === "dark");
    }

    function toggleTheme() {
        state.theme = state.theme === "dark" ? "light" : "dark";
        safeStorageSet("theme", state.theme);
        initTheme();
        renderHeader();
    }

    function navButton(key) {
        var meta = viewMeta[key];
        return [
            '<button class="pc-nav-button', state.view === key ? " is-active" : "", '" data-view="', key, '">',
            '<span class="pc-nav-icon">', meta.icon, '</span>',
            '<span>', meta.label, '</span>',
            '</button>'
        ].join("");
    }

    function shellHtml() {
        return [
            '<div class="pc-app">',
            '<aside class="pc-sidebar">',
            '<div class="pc-brand">',
            '<img class="pc-logo" src="./logo.png" alt="Logo">',
            '<div><div class="pc-brand-title">主动消息</div><div class="pc-brand-subtitle">Admin Console</div></div>',
            '</div>',
            '<nav class="pc-nav">', navButton("status"), navButton("tasks"), navButton("notifications"), navButton("docs"), navButton("config"), '</nav>',
            '<div class="pc-sidebar-actions">',
            '<button class="pc-button secondary" data-action="open-dir" data-path="plugin">📂 打开插件文件目录</button>',
            '<button class="pc-button secondary" data-action="open-dir" data-path="data">🗃️ 打开插件数据目录</button>',
            '</div>',
            '<a class="pc-github-card" href="', PLUGIN_REPO, '" target="_blank" rel="noopener noreferrer">',
            '<div class="pc-github-author">@DBJD-CR</div>',
            '<div class="pc-github-title">🔧 (主动消息) ... 点个 Star 吧~ ⭐</div>',
            '</a>',
            '</aside>',
            '<main class="pc-main">',
            '<header class="pc-topbar" id="pc-topbar"></header>',
            '<div class="pc-content">',
            '<div id="pc-error"></div>',
            '<section id="view-status" class="pc-section"></section>',
            '<section id="view-tasks" class="pc-section"></section>',
            '<section id="view-notifications" class="pc-section"></section>',
            '<section id="view-docs" class="pc-section"></section>',
            '<section id="view-config" class="pc-section"></section>',
            '</div>',
            '</main>',
            '</div>'
        ].join("");
    }

    function renderShell() {
        $("root").innerHTML = shellHtml();
        bindShellEvents();
        render();
    }

    function bindShellEvents() {
        document.addEventListener("click", function (event) {
            var viewBtn = event.target.closest("[data-view]");
            if (viewBtn) {
                switchView(viewBtn.getAttribute("data-view"));
                return;
            }
            var action = event.target.closest("[data-action]");
            if (!action) return;
            handleAction(action.getAttribute("data-action"), action);
        });
        document.addEventListener("change", function (event) {
            if (event.target && event.target.id === "session-select") {
                state.selectedSession = event.target.value;
                loadSessionDetail(state.selectedSession);
            }
            if (event.target && event.target.id === "doc-select") {
                state.selectedMarkdownPath = event.target.value;
                loadMarkdownDocument(state.selectedMarkdownPath);
            }
        });
    }

    function handleAction(action, node) {
        if (action === "refresh") loadCurrentView();
        if (action === "theme") toggleTheme();
        if (action === "open-dir") openDirectory(node.getAttribute("data-path"));
        if (action === "trigger-job") triggerJob(node.getAttribute("data-id"));
        if (action === "reschedule-job") rescheduleJob(node.getAttribute("data-id"));
        if (action === "cancel-job") cancelJob(node.getAttribute("data-id"));
        if (action === "read-notification") readNotification(node.getAttribute("data-id"));
        if (action === "read-all-notifications") readAllNotifications();
        if (action === "refresh-notifications") refreshNotifications();
        if (action === "save-config") saveConfig();
        if (action === "load-config") loadConfig();
        if (action === "save-session") saveSessionConfig();
        if (action === "reset-session") resetSessionConfig();
    }

    function switchView(view) {
        if (!viewMeta[view]) return;
        state.view = view;
        render();
        loadCurrentView();
    }

    function loadCurrentView() {
        if (state.view === "status") loadDashboard();
        if (state.view === "tasks") loadJobs();
        if (state.view === "notifications") loadNotifications();
        if (state.view === "docs") loadMarkdownFiles();
        if (state.view === "config") loadConfig();
    }

    function renderHeader() {
        var meta = viewMeta[state.view];
        var status = state.status || {};
        var connected = state.bridgeReady;
        $("pc-topbar").innerHTML = [
            '<div><div class="pc-title">', escapeHtml(meta.label), '</div>',
            '<div class="pc-subtitle">', escapeHtml(meta.subtitle), '</div></div>',
            '<div class="pc-topbar-actions">',
            '<span class="pc-chip">🕒 <span id="pc-clock">', escapeHtml(formatDate(new Date())), '</span></span>',
            '<span class="pc-chip ', connected ? "is-ok" : "is-warn", '">', connected ? "已连接 Pages bridge" : "未连接 Pages bridge", '</span>',
            '<span class="pc-chip">WebSocket ', Number(status.ws_connections || 0), ' 个</span>',
            '<button class="pc-icon-button" data-action="refresh" title="刷新">↻</button>',
            '<button class="pc-icon-button" data-action="theme" title="切换主题">', state.theme === "dark" ? "☀" : "🌙", '</button>',
            '</div>'
        ].join("");
    }

    function renderError() {
        $("pc-error").innerHTML = state.error ? '<div class="pc-error">' + escapeHtml(state.error) + '</div>' : "";
    }

    function render() {
        if (!$("pc-topbar")) return;
        initTheme();
        renderHeader();
        renderError();
        var keys = ["status", "tasks", "notifications", "docs", "config"];
        for (var i = 0; i < keys.length; i += 1) {
            var section = $("view-" + keys[i]);
            if (section) section.classList.toggle("is-active", state.view === keys[i]);
        }
        var navs = document.querySelectorAll("[data-view]");
        for (var n = 0; n < navs.length; n += 1) {
            navs[n].classList.toggle("is-active", navs[n].getAttribute("data-view") === state.view);
        }
        renderStatus();
        renderTasks();
        renderNotifications();
        renderDocs();
        renderConfig();
    }

    function metric(label, value, hint) {
        return [
            '<article class="pc-card pc-metric">',
            '<div><div class="pc-metric-label">', escapeHtml(label), '</div>',
            '<div class="pc-metric-value">', escapeHtml(value), '</div></div>',
            '<div class="pc-card-subtitle">', escapeHtml(hint || ""), '</div>',
            '</article>'
        ].join("");
    }

    function renderStatus() {
        var status = state.status || {};
        var autoCards = asArray(status.auto_trigger_cards);
        var groupCards = asArray(status.group_timer_cards);
        $("view-status").innerHTML = [
            '<div class="pc-grid metrics">',
            metric("插件状态", status.running ? "运行中" : "已停止", "版本 " + text(status.version, "...")),
            metric("运行时长", formatDuration(status.uptime_seconds), "启动后持续运行时间"),
            metric("调度任务", text(status.jobs_count, "0"), status.scheduler_running ? "调度器运行中" : "调度器未启动"),
            metric("会话数据", text(status.sessions_count, "0"), "自动触发 " + autoCards.length + " / 群沉默 " + groupCards.length),
            '</div>',
            '<div class="pc-grid two">',
            '<div class="pc-card"><div class="pc-card-header"><div><div class="pc-card-title">会话计时器可视化</div><div class="pc-card-subtitle">实时展示自动触发检测与群沉默检测的倒计时、进度和会话状态。</div></div></div>',
            renderTimerList(autoCards.concat(groupCards)), '</div>',
            '<div class="pc-card"><div class="pc-card-title">调度概览</div>',
            '<div class="pc-list" style="margin-top:14px">',
            infoRow("调度器", status.scheduler_running ? "运行中" : "未启动"),
            infoRow("当前任务总数", text(status.jobs_count, "0") + " 个"),
            infoRow("自动触发计时器", autoCards.length + " 个"),
            infoRow("群沉默计时器", groupCards.length + " 个"),
            infoRow("数据时间", formatDate(status.timestamp)),
            '</div></div></div>'
        ].join("");
    }

    function infoRow(label, value) {
        return '<div class="pc-row"><div class="pc-row-title">' + escapeHtml(label) + '</div><div class="pc-row-meta">' + escapeHtml(value) + '</div></div>';
    }

    function renderTimerList(items) {
        if (!items.length) return '<div class="pc-empty">🫧 暂无运行中的会话计时器</div>';
        var html = ['<div class="pc-list">'];
        for (var i = 0; i < items.length; i += 1) {
            var item = items[i] || {};
            html.push('<div class="pc-row">');
            html.push('<div class="pc-row-title">', escapeHtml(item.session_display_name || item.session_name || item.session || item.id || "会话"), '</div>');
            html.push('<div class="pc-row-meta">', escapeHtml(item.timer_kind_label || item.timer_kind || "计时器"), ' · 剩余 ', escapeHtml(formatDuration(item.remaining_seconds)), ' · 进度 ', escapeHtml(text(item.progress_percent, "0")), '%</div>');
            html.push('</div>');
        }
        html.push('</div>');
        return html.join("");
    }

    function renderTasks() {
        var jobs = state.jobs || [];
        if (!jobs.length) {
            $("view-tasks").innerHTML = '<div class="pc-card"><div class="pc-empty">暂无调度任务</div></div>';
            return;
        }
        var html = ['<div class="pc-card"><div class="pc-card-header"><div><div class="pc-card-title">任务列表</div><div class="pc-card-subtitle">当前共 ', jobs.length, ' 个任务</div></div></div><div class="pc-list">'];
        for (var i = 0; i < jobs.length; i += 1) {
            var job = jobs[i] || {};
            var id = job.id || job.session || "";
            html.push('<div class="pc-row">');
            html.push('<div class="pc-row-title">', escapeHtml(job.session_display_name || job.session_name || id || "任务"), '</div>');
            html.push('<div class="pc-row-meta">UMO: ', escapeHtml(id), '</div>');
            html.push('<div class="pc-row-meta">下次运行: ', escapeHtml(formatDate(job.next_run_time)), ' · 来源: ', escapeHtml(job.source_mode || "--"), ' · 未回复: ', escapeHtml(text(job.unanswered_count, "0")), '/', escapeHtml(text(job.max_unanswered_times, "0")), '</div>');
            html.push('<div class="pc-row-actions">');
            html.push('<button class="pc-button" data-action="trigger-job" data-id="', escapeHtml(id), '">立即触发</button>');
            html.push('<button class="pc-button secondary" data-action="reschedule-job" data-id="', escapeHtml(id), '">重新调度</button>');
            html.push('<button class="pc-button ghost" data-action="cancel-job" data-id="', escapeHtml(id), '">取消任务</button>');
            html.push('</div></div>');
        }
        html.push('</div></div>');
        $("view-tasks").innerHTML = html.join("");
    }

    function renderNotifications() {
        var items = state.notifications || [];
        var meta = state.notificationsMeta || {};
        var html = ['<div class="pc-card"><div class="pc-card-header"><div><div class="pc-card-title">通知中心</div><div class="pc-card-subtitle">未读 ', Number(meta.unread_count || 0), ' / 总数 ', Number(meta.total_count || items.length || 0), '</div></div><div class="pc-row-actions"><button class="pc-button secondary" data-action="refresh-notifications">同步</button><button class="pc-button ghost" data-action="read-all-notifications">全部已读</button></div></div>'];
        if (!items.length) {
            html.push('<div class="pc-empty">暂无通知</div></div>');
            $("view-notifications").innerHTML = html.join("");
            return;
        }
        html.push('<div class="pc-list">');
        for (var i = 0; i < items.length; i += 1) {
            var item = items[i] || {};
            var id = item.id == null ? "" : String(item.id);
            html.push('<div class="pc-row">');
            html.push('<div class="pc-row-title">', escapeHtml(item.title || item.type || "通知"), '</div>');
            html.push('<div class="pc-row-meta">', escapeHtml(item.level || item.severity || "info"), ' · ', escapeHtml(formatDate(item.created_at || item.timestamp || item.time)), '</div>');
            html.push('<div class="pc-row-meta">', escapeHtml(item.content || item.message || item.text || ""), '</div>');
            if (id) html.push('<div><button class="pc-button secondary" data-action="read-notification" data-id="', escapeHtml(id), '">标记已读</button></div>');
            html.push('</div>');
        }
        html.push('</div></div>');
        $("view-notifications").innerHTML = html.join("");
    }

    function renderDocs() {
        var files = state.markdownFiles || [];
        var doc = state.markdownDocument || {};
        var options = [];
        for (var i = 0; i < files.length; i += 1) {
            var file = files[i] || {};
            var selected = file.path === state.selectedMarkdownPath ? " selected" : "";
            options.push('<option value="' + escapeHtml(file.path) + '"' + selected + '>' + escapeHtml((file.title || file.filename || file.path) + " · " + file.path) + '</option>');
        }
        $("view-docs").innerHTML = [
            '<div class="pc-doc-layout">',
            '<div class="pc-card"><div class="pc-card-title">文档目录</div><div class="pc-card-subtitle">选择要浏览的 Markdown 文档</div>',
            '<select class="pc-select" id="doc-select" style="margin-top:14px">', options.join(""), '</select>',
            '<div class="pc-footer-note">目录来自插件根目录与 docs 文件夹。</div></div>',
            '<div class="pc-card pc-doc-body">',
            doc.content ? renderMarkdown(doc.content) : '<div class="pc-empty">请选择或刷新文档</div>',
            '</div>',
            '</div>'
        ].join("");
    }

    function renderMarkdown(markdown) {
        var escaped = escapeHtml(markdown || "");
        escaped = escaped.replace(/^### (.*)$/gm, "<h3>$1</h3>");
        escaped = escaped.replace(/^## (.*)$/gm, "<h2>$1</h2>");
        escaped = escaped.replace(/^# (.*)$/gm, "<h1>$1</h1>");
        escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        escaped = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
        var lines = escaped.split(/\n{2,}/);
        var out = [];
        for (var i = 0; i < lines.length; i += 1) {
            var block = lines[i];
            if (/^\s*<h[1-3]/.test(block) || /^\s*<pre/.test(block)) {
                out.push(block);
            } else {
                out.push("<p>" + block.replace(/\n/g, "<br>") + "</p>");
            }
        }
        return out.join("");
    }

    function renderConfig() {
        var configText = state.config ? escapeHtml(JSON.stringify(state.config, null, 2)) : "";
        var schema = state.configSchema || {};
        var schemaKeys = Object.keys(schema);
        var sessionOptions = ['<option value="">选择会话...</option>'];
        for (var i = 0; i < state.sessions.length; i += 1) {
            var s = state.sessions[i] || {};
            var value = s.session || s;
            sessionOptions.push('<option value="' + escapeHtml(value) + '"' + (value === state.selectedSession ? " selected" : "") + '>' + escapeHtml((s.session_display_name || s.session_name || value) + (s.has_override ? " · 已覆写" : "")) + '</option>');
        }
        var sessionText = state.sessionDetail ? escapeHtml(JSON.stringify(state.sessionDetail.override || {}, null, 2)) : "";
        $("view-config").innerHTML = [
            '<div class="pc-grid two">',
            '<div class="pc-card"><div class="pc-card-header"><div><div class="pc-card-title">全局配置</div><div class="pc-card-subtitle">使用 JSON 编辑完整配置，保存前请确认格式正确。</div></div><button class="pc-button secondary" data-action="load-config">刷新</button></div>',
            '<textarea class="pc-textarea" id="config-editor" spellcheck="false">', configText, '</textarea>',
            '<div class="pc-row-actions" style="margin-top:12px"><button class="pc-button" data-action="save-config">保存全局配置</button></div>',
            '</div>',
            '<div class="pc-card"><div class="pc-card-title">配置结构</div><div class="pc-card-subtitle">Schema 分组概览</div>',
            schemaKeys.length ? '<div class="pc-list" style="margin-top:14px">' + schemaKeys.map(function (key) { return infoRow(key, schema[key] && schema[key].description || schema[key] && schema[key].title || "配置分组"); }).join("") + '</div>' : '<div class="pc-empty" style="margin-top:14px">暂无 Schema</div>',
            '</div>',
            '</div>',
            '<div class="pc-card" style="margin-top:16px"><div class="pc-card-header"><div><div class="pc-card-title">会话差异配置</div><div class="pc-card-subtitle">选择会话后编辑 override JSON，留空对象表示不覆写。</div></div></div>',
            '<div class="pc-form-grid"><select class="pc-select" id="session-select">', sessionOptions.join(""), '</select><button class="pc-button secondary" data-action="reset-session">清空覆写</button></div>',
            '<textarea class="pc-textarea" id="session-editor" spellcheck="false" style="margin-top:12px">', sessionText, '</textarea>',
            '<div class="pc-row-actions" style="margin-top:12px"><button class="pc-button" data-action="save-session">保存会话配置</button></div>',
            state.sessionDetail ? '<div class="pc-footer-note">当前会话: ' + escapeHtml(state.sessionDetail.session || state.selectedSession) + '</div>' : '',
            '</div>'
        ].join("");
    }

    function openDirectory(path) {
        apiPost(route("open-directory"), { path: path }).then(function (res) {
            window.alert(res.message || "已请求打开目录");
        }).catch(function (err) {
            window.alert(err.message || "打开目录失败");
        });
    }

    function loadDashboard() {
        if (!state.bridgeReady) {
            setError("AstrBot Pages bridge 未注入，当前只能显示静态页面。");
            return;
        }
        apiGet(route("dashboard")).then(function (data) {
            state.status = data.status || state.status || {};
            state.jobs = asArray(data.jobs);
            state.sessions = asArray(data.sessions);
            state.notificationsMeta = data.notifications_meta || state.notificationsMeta || {};
            setError("");
            render();
        }).catch(function () {
            Promise.all([apiGet(route("status")), apiGet(route("jobs")), apiGet(route("session-config/sessions"))]).then(function (parts) {
                state.status = parts[0] || {};
                state.jobs = asArray(parts[1].jobs || parts[1]);
                state.sessions = asArray(parts[2].sessions || parts[2]);
                setError("");
                render();
            }).catch(function (err) {
                setError(err.message || "加载状态失败");
            });
        });
    }

    function loadJobs() {
        apiGet(route("jobs")).then(function (data) {
            state.jobs = asArray(data.jobs || data);
            setError("");
            render();
        }).catch(function (err) {
            setError(err.message || "加载任务失败");
        });
    }

    function triggerJob(id) {
        if (!id) return;
        apiPost(route("jobs/" + encodeURIComponent(id) + "/trigger"), {}).then(loadJobs).catch(function (err) { setError(err.message); });
    }

    function rescheduleJob(id) {
        if (!id) return;
        apiPost(route("jobs/" + encodeURIComponent(id) + "/reschedule"), {}).then(loadJobs).catch(function (err) { setError(err.message); });
    }

    function cancelJob(id) {
        if (!id) return;
        apiPost(route("jobs-cancel/" + encodeURIComponent(id)), {}).then(loadJobs).catch(function (err) { setError(err.message); });
    }

    function loadNotifications() {
        apiGet(route("notifications")).then(function (data) {
            state.notifications = asArray(data.items || data.notifications || data);
            state.notificationsMeta = data.meta || state.notificationsMeta || {};
            setError("");
            render();
        }).catch(function (err) {
            setError(err.message || "加载通知失败");
        });
    }

    function readNotification(id) {
        apiPost(route("notifications/read"), { id: id }).then(loadNotifications).catch(function (err) { setError(err.message); });
    }

    function readAllNotifications() {
        apiPost(route("notifications/read-all"), {}).then(loadNotifications).catch(function (err) { setError(err.message); });
    }

    function refreshNotifications() {
        apiPost(route("notifications/refresh"), {}).then(loadNotifications).catch(function (err) { setError(err.message); });
    }

    function loadMarkdownFiles() {
        apiGet(route("markdown-files")).then(function (data) {
            state.markdownFiles = asArray(data.items || data.files || data);
            if (!state.selectedMarkdownPath && state.markdownFiles.length) {
                state.selectedMarkdownPath = state.markdownFiles[0].path;
                loadMarkdownDocument(state.selectedMarkdownPath);
            }
            setError("");
            render();
        }).catch(function (err) {
            setError(err.message || "加载文档目录失败");
        });
    }

    function loadMarkdownDocument(path) {
        if (!path) {
            state.markdownDocument = null;
            render();
            return;
        }
        apiGet(route("markdown-files/" + encodeURIComponent(path))).then(function (data) {
            state.markdownDocument = data || {};
            setError("");
            render();
        }).catch(function (err) {
            setError(err.message || "加载文档失败");
        });
    }

    function loadConfig() {
        Promise.all([
            apiGet(route("config")),
            apiGet(route("config-schema")),
            apiGet(route("session-config/sessions"))
        ]).then(function (parts) {
            state.config = parts[0] || {};
            state.configSchema = parts[1] && (parts[1].schema || parts[1]) || {};
            state.sessions = asArray(parts[2].sessions || parts[2]);
            setError("");
            render();
        }).catch(function (err) {
            setError(err.message || "加载配置失败");
        });
    }

    function saveConfig() {
        var editor = $("config-editor");
        if (!editor) return;
        try {
            var payload = JSON.parse(editor.value || "{}");
            apiPost(route("config"), payload).then(function (data) {
                state.config = data.config || data || payload;
                setError("");
                render();
                window.alert("全局配置已保存");
            }).catch(function (err) { setError(err.message); });
        } catch (e) {
            setError("JSON 格式错误: " + e.message);
        }
    }

    function loadSessionDetail(session) {
        if (!session) {
            state.sessionDetail = null;
            render();
            return;
        }
        apiGet(route("session-config/" + encodeURIComponent(session))).then(function (data) {
            state.sessionDetail = data || {};
            setError("");
            render();
        }).catch(function (err) {
            setError(err.message || "加载会话配置失败");
        });
    }

    function saveSessionConfig() {
        if (!state.selectedSession) {
            setError("请先选择会话");
            return;
        }
        var editor = $("session-editor");
        try {
            var payload = JSON.parse(editor && editor.value || "{}");
            apiPost(route("session-config/" + encodeURIComponent(state.selectedSession)), payload).then(function (data) {
                state.sessionDetail = data || {};
                setError("");
                render();
                window.alert("会话配置已保存");
            }).catch(function (err) { setError(err.message); });
        } catch (e) {
            setError("JSON 格式错误: " + e.message);
        }
    }

    function resetSessionConfig() {
        if (!state.selectedSession) {
            setError("请先选择会话");
            return;
        }
        apiPost(route("session-config-delete/" + encodeURIComponent(state.selectedSession)), {}).then(function (data) {
            state.sessionDetail = data || {};
            loadConfig();
        }).catch(function (err) { setError(err.message); });
    }

    function initClock() {
        setInterval(function () {
            var node = $("pc-clock");
            if (node) node.textContent = formatDate(new Date());
        }, 1000);
    }

    function init() {
        initTheme();
        renderShell();
        hideBoot();
        initClock();
        waitBridge(5000).then(function (bridge) {
            state.bridge = bridge;
            state.bridgeReady = !!bridge;
            if (!bridge) {
                setError("AstrBot Pages bridge 未注入，当前页面无法读取插件数据。");
                return;
            }
            Promise.resolve(typeof bridge.ready === "function" ? bridge.ready() : null).then(function () {
                state.bridgeReady = true;
                loadDashboard();
            }).catch(function (err) {
                state.bridgeReady = false;
                setError(err.message || "AstrBot Pages bridge 初始化失败");
            });
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
