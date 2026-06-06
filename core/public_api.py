"""插件间通信的轻量公共接口。"""

from __future__ import annotations

import asyncio
from typing import Any


class PublicApiMixin:
    """提供给其它插件复用的稳定方法，避免直接触碰内部状态。"""

    web_admin_server: Any
    manual_trigger_sessions: set[str]
    scheduler: Any
    data_lock: Any
    session_data: dict

    def get_proactive_chat_status(self) -> dict[str, Any]:
        """返回主动消息运行状态快照。"""
        if self.web_admin_server:
            return self.web_admin_server._build_status_payload()
        return {"running": False, "error": "web_admin_server_unavailable"}

    def list_proactive_chat_jobs(self) -> list[dict[str, Any]]:
        """返回当前调度任务列表。"""
        if self.web_admin_server:
            return self.web_admin_server._collect_jobs()
        return []

    def list_proactive_chat_sessions(self) -> list[dict[str, Any]]:
        """返回当前已知会话摘要。"""
        if self.web_admin_server:
            return self.web_admin_server._list_known_session_summaries()
        return []

    async def trigger_proactive_chat(self, session_id: str) -> dict[str, Any]:
        """立即触发一次指定会话的主动消息流程。"""
        normalized = self._normalize_session_id(session_id)
        if normalized in self.manual_trigger_sessions:
            return {
                "ok": False,
                "session": normalized,
                "in_progress": True,
                "message": "该会话正在触发中",
            }

        self.manual_trigger_sessions.add(normalized)
        asyncio.create_task(self.check_and_chat(normalized))
        return {
            "ok": True,
            "session": normalized,
            "in_progress": True,
            "message": "已开始触发主动消息",
        }

    async def reschedule_proactive_chat(
        self,
        session_id: str,
        *,
        reset_counter: bool = False,
    ) -> dict[str, Any]:
        """重新调度指定会话的下一次主动消息。"""
        normalized = self._normalize_session_id(session_id)
        session_config = self._get_session_config(normalized)
        if not session_config or not session_config.get("enable", False):
            return {
                "ok": False,
                "session": normalized,
                "error": "会话未启用或配置不存在",
            }

        await self._schedule_next_chat_and_save(
            normalized,
            reset_counter=reset_counter,
        )
        return {"ok": True, "session": normalized}

    async def cancel_proactive_chat_job(self, session_id: str) -> dict[str, Any]:
        """取消指定会话当前的调度任务。"""
        normalized = self._normalize_session_id(session_id)
        removed = False
        if self.scheduler:
            try:
                self.scheduler.remove_job(normalized)
                removed = True
            except Exception:
                pass

        if self.data_lock:
            async with self.data_lock:
                if normalized in self.session_data:
                    self.session_data[normalized].pop("next_trigger_time", None)
                    await self._save_data_internal()

        return {"ok": True, "session": normalized, "removed": removed}
