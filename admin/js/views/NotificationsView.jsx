/**
 * 文件职责：通知中心视图，负责通知列表展示、已读状态操作与手动刷新交互。
 */

const { Box, Typography, Button, Chip } = MaterialUI;

const NOTIFICATION_TYPE_META = {
    UPDATE: { label: '更新通知', color: 'info' },
    BUGFIX: { label: '修复通知', color: 'success' },
    NOTICE: { label: '注意事项', color: 'warning' },
    SECURITY: { label: '安全通知', color: 'error' },
    TEST: { label: '测试通知', color: 'default' },
};

function resolveNotificationTypeMeta(type) {
    const normalizedType = String(type || '').trim().toUpperCase();
    return NOTIFICATION_TYPE_META[normalizedType] || { label: '其他通知', color: 'default' };
}

function renderNotificationContent(item) {
    const rawContent = String(item?.content || '--');
    const content = rawContent
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\r\n?/g, '\n');
    const format = String(item?.content_format || 'text').trim().toLowerCase();

    const markdownLike = /(^|\n)\s{0,3}(#{1,6}\s|>\s|[-*]\s)|(^|\n)\s*---\s*($|\n)/m.test(content);
    const shouldRenderMarkdown = format === 'markdown' || markdownLike;

    if (!shouldRenderMarkdown) {
        return (
            <Typography variant="body2" className="task-countdown-text notification-feed-content-text" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.85 }}>
                {content}
            </Typography>
        );
    }

    const escapeHtml = (text) => text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const safeLinkHref = (href) => {
        const value = String(href || '').trim();
        if (/^https?:\/\//i.test(value) || value.startsWith('/') || value.startsWith('#')) {
            return value;
        }
        return '#';
    };

    const applyInlineMarkdown = (text) => {
        let output = text;
        output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        output = output.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        output = output.replace(/`([^`]+)`/g, '<code>$1</code>');
        output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
            const safeHref = safeLinkHref(href);
            return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        });
        return output;
    };

    const fallbackRenderMarkdown = (md) => {
        const normalized = String(md || '').replace(/\r\n?/g, '\n');
        const lines = normalized.split('\n');
        const htmlParts = [];
        let paragraphBuffer = [];
        let inList = false;

        const flushParagraph = () => {
            if (!paragraphBuffer.length) return;
            const safeText = paragraphBuffer.map((line) => escapeHtml(line)).join('<br />');
            htmlParts.push(`<p>${applyInlineMarkdown(safeText)}</p>`);
            paragraphBuffer = [];
        };

        const closeList = () => {
            if (!inList) return;
            htmlParts.push('</ul>');
            inList = false;
        };

        for (const rawLine of lines) {
            const line = rawLine.trimEnd();
            const trimmed = line.trim();

            if (!trimmed) {
                flushParagraph();
                closeList();
                continue;
            }

            const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
            if (heading) {
                flushParagraph();
                closeList();
                const level = heading[1].length;
                htmlParts.push(`<h${level}>${applyInlineMarkdown(escapeHtml(heading[2]))}</h${level}>`);
                continue;
            }

            if (/^---+$/.test(trimmed)) {
                flushParagraph();
                closeList();
                htmlParts.push('<hr />');
                continue;
            }

            const quote = trimmed.match(/^>\s?(.*)$/);
            if (quote) {
                flushParagraph();
                closeList();
                htmlParts.push(`<blockquote><p>${applyInlineMarkdown(escapeHtml(quote[1]))}</p></blockquote>`);
                continue;
            }

            const listItem = trimmed.match(/^[-*]\s+(.+)$/);
            if (listItem) {
                flushParagraph();
                if (!inList) {
                    htmlParts.push('<ul>');
                    inList = true;
                }
                htmlParts.push(`<li>${applyInlineMarkdown(escapeHtml(listItem[1]))}</li>`);
                continue;
            }

            closeList();
            paragraphBuffer.push(line);
        }

        flushParagraph();
        closeList();

        return htmlParts.join('');
    };

    let sanitizedHtml = '';
    try {
        const marked = window.marked;
        const DOMPurify = window.DOMPurify;

        if (marked && DOMPurify) {
            const parseMarkdown = (md) => {
                if (marked && typeof marked.parse === 'function') {
                    return marked.parse(md, { gfm: true, breaks: true });
                }
                if (typeof marked === 'function') {
                    return marked(md, { gfm: true, breaks: true });
                }
                throw new Error('marked parser unavailable');
            };

            const rawHtml = parseMarkdown(content);
            const sanitizedFragment = DOMPurify.sanitize(rawHtml, {
                USE_PROFILES: { html: true },
                FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
                FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus'],
                RETURN_DOM_FRAGMENT: true,
            });

            sanitizedFragment.querySelectorAll('a[href]').forEach((link) => {
                const href = String(link.getAttribute('href') || '').trim();
                if (!/^https?:\/\//i.test(href) && !href.startsWith('/') && !href.startsWith('#')) {
                    link.setAttribute('href', '#');
                }
                link.setAttribute('target', '_blank');
                link.setAttribute('rel', 'noopener noreferrer');
            });

            const container = document.createElement('div');
            container.appendChild(sanitizedFragment);
            sanitizedHtml = container.innerHTML;
        } else {
            sanitizedHtml = fallbackRenderMarkdown(content);
        }
    } catch (e) {
        sanitizedHtml = fallbackRenderMarkdown(content);
    }

    return (
        <Box
            className="task-countdown-text notification-feed-content-text"
            sx={{
                lineHeight: 1.85,
                '& p': { my: 0.8 },
                '& ul, & ol': { pl: 2.5, my: 0.8 },
                '& pre': { overflowX: 'auto' },
                '& blockquote': {
                    m: '8px 0',
                    px: 1.5,
                    py: 1,
                    borderLeft: '4px solid var(--md-sys-color-primary)',
                    background: 'rgba(103, 80, 164, 0.10)',
                    borderRadius: '0 10px 10px 0',
                    opacity: 1,
                },
                '& blockquote p': { m: 0 },
            }}
            dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
        />
    );
}

function NotificationsView({ onRefresh }) {
    const { state, dispatch } = useAppContext();
    const api = useApi();
    const notifications = Array.isArray(state.notifications) ? state.notifications : [];
    const notificationsMeta = state.notificationsMeta || { unread_count: 0, last_sync_at: '', total_count: 0 };
    const displayTimezone = state.config?.displayTimezone || 'Asia/Shanghai';
    const [busyAction, setBusyAction] = React.useState('');

    const refreshFromServer = async () => {
        setBusyAction('refresh');
        try {
            const payload = await api.refreshNotifications();
            dispatch({ type: 'SET_NOTIFICATIONS', payload: payload.items || [] });
            dispatch({ type: 'SET_NOTIFICATIONS_META', payload: payload.meta || null });
            await onRefresh();
        } catch (e) {
            dispatch({ type: 'SET_ERROR', payload: e.message || '刷新通知失败' });
        } finally {
            setBusyAction('');
        }
    };

    const markOneAsRead = async (id) => {
        setBusyAction(`read-${id}`);
        try {
            const payload = await api.readNotification(id);
            dispatch({ type: 'SET_NOTIFICATIONS_META', payload: payload.meta || null });
            dispatch({
                type: 'SET_NOTIFICATIONS',
                payload: notifications.map((item) =>
                    Number(item.id) === Number(id) ? { ...item, _read: true } : item
                ),
            });
        } catch (e) {
            dispatch({ type: 'SET_ERROR', payload: e.message || '标记已读失败' });
        } finally {
            setBusyAction('');
        }
    };

    const markAllAsRead = async () => {
        setBusyAction('read-all');
        try {
            const payload = await api.readAllNotifications();
            dispatch({ type: 'SET_NOTIFICATIONS_META', payload: payload.meta || null });
            dispatch({
                type: 'SET_NOTIFICATIONS',
                payload: notifications.map((item) => ({ ...item, _read: true })),
            });
        } catch (e) {
            dispatch({ type: 'SET_ERROR', payload: e.message || '全部已读失败' });
        } finally {
            setBusyAction('');
        }
    };

    return (
        <Box className="notifications-view">
            <div className="card notifications-hero-card">
                <Box className="tasks-header-row notifications-header-row">
                    <div className="notifications-header-main">
                        <Box className="notifications-title-row">
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap' }}>
                                <Typography variant="h6" sx={{ fontWeight: 800 }}>
                                    通知中心 ({notificationsMeta.total_count || notifications.length})
                                </Typography>
                                <Box
                                    sx={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 0.75,
                                        px: 1.25,
                                        py: 0.6,
                                        borderRadius: 999,
                                        fontSize: '0.82rem',
                                        fontWeight: 700,
                                        lineHeight: 1,
                                        border: '1px solid',
                                        borderColor: Number(notificationsMeta.unread_count ?? 0) > 0
                                            ? 'rgba(245, 158, 11, 0.28)'
                                            : 'rgba(46, 125, 50, 0.18)',
                                        background: Number(notificationsMeta.unread_count ?? 0) > 0
                                            ? 'rgba(245, 158, 11, 0.12)'
                                            : 'rgba(46, 125, 50, 0.08)',
                                        color: Number(notificationsMeta.unread_count ?? 0) > 0
                                            ? '#B45309'
                                            : '#2E7D32',
                                    }}
                                >
                                    {Number(notificationsMeta.unread_count ?? 0) > 0
                                        ? `未读 ${Number(notificationsMeta.unread_count ?? 0)} 条`
                                        : '全部已读'}
                                </Box>
                            </Box>
                            <div className="notifications-inline-meta">
                                <div className="notifications-inline-meta-item is-pill">
                                    <span className="notifications-inline-meta-label">未读通知</span>
                                    <strong>{Number(notificationsMeta.unread_count ?? 0)}</strong>
                                </div>
                                <div className="notifications-inline-meta-item is-pill">
                                    <span className="notifications-inline-meta-label">上次同步</span>
                                    <strong>
                                        {notificationsMeta.last_sync_at
                                            ? formatDateTime(notificationsMeta.last_sync_at, displayTimezone, { includeYear: true, includeSeconds: true })
                                            : '--'}
                                    </strong>
                                </div>
                            </div>
                        </Box>
                        <Typography variant="body2" className="tasks-header-subtitle">
                            用于接收插件更新、修复说明、注意事项等官方通知。
                        </Typography>
                    </div>
                    <Box className="notifications-actions-row">
                        <Button
                            variant="outlined"
                            onClick={markAllAsRead}
                            disabled={busyAction === 'read-all' || notifications.length === 0}
                            sx={{ borderRadius: 3 }}
                        >
                            全部已读
                        </Button>
                        <Button
                            variant="contained"
                            onClick={refreshFromServer}
                            disabled={busyAction === 'refresh'}
                            startIcon={<span>🔄</span>}
                            sx={{ borderRadius: 3, boxShadow: 'none', px: 2.25 }}
                        >
                            立即同步
                        </Button>
                    </Box>
                </Box>
            </div>

            {notifications.length === 0 ? (
                <div className="card tasks-empty-card notifications-empty-card">
                    <div className="tasks-empty-icon">🔔</div>
                    <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>暂无通知</Typography>
                    <Typography variant="body1" color="text.secondary">
                        当前还没有可展示的系统通知，后续若有插件更新、修复说明或注意事项，这里会自动出现。
                    </Typography>
                </div>
            ) : (
                <div className="notifications-feed-list">
                    {notifications.map((item) => {
                        const meta = resolveNotificationTypeMeta(item.type);
                        const isRead = Boolean(item._read) || false;
                        return (
                            <div className={`card task-card-enhanced notification-feed-card ${isRead ? 'is-read' : 'is-urgent'}`} key={item.id}>
                                <div className="task-card-top notification-feed-card-top">
                                    <div className="notification-feed-heading-group">
                                        <Typography variant="body1" className="task-card-session is-primary notification-feed-title">
                                            {item.title || '--'}
                                        </Typography>
                                        <Chip
                                            className="notification-feed-type-chip"
                                            label={meta.label}
                                            size="small"
                                            color={meta.color}
                                            variant="outlined"
                                        />
                                    </div>
                                    <div className="notification-feed-side notification-feed-meta-inline">
                                        <span className={`notification-feed-status-pill ${isRead ? 'is-read' : 'is-unread'}`}>
                                            {isRead ? '已读' : '未读'}
                                        </span>
                                        <Typography variant="caption" className="task-card-session-sub mono notification-feed-time">
                                            {formatDateTime(item.created_at, displayTimezone, { includeYear: true, includeSeconds: true })}
                                        </Typography>
                                    </div>
                                </div>

                                <div className="task-next-run-panel notification-feed-content-panel">
                                    {renderNotificationContent(item)}
                                    <Box className="notification-feed-actions notification-feed-actions-inside">
                                        <Button
                                            variant="outlined"
                                            size="small"
                                            disabled={isRead || busyAction === `read-${item.id}`}
                                            onClick={() => markOneAsRead(item.id)}
                                            sx={{ borderRadius: 999, minWidth: 112, boxShadow: 'none' }}
                                        >
                                            {isRead ? '已读' : '确认已读'}
                                        </Button>
                                    </Box>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </Box>
    );
}

window.NotificationsView = NotificationsView;
