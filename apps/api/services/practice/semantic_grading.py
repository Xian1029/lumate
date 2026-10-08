"""Semantic verification for open-ended learner answers.

This module is the *only* place that talks to an LLM for grading.  It is
invoked by :mod:`services.practice.grading_service` after the deterministic
layers (normalization / numeric / accepted answers) have failed to reach a
verdict, so it is never called for answers that are already clearly right or
clearly wrong — cost stays bounded.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from config import settings

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = """你是严谨但公平的学科判题老师。判断学生答案是否表达了与参考答案相同的学科含义，而不是措辞是否相像。

必须严格核对：
1. 核心概念：学生使用的概念与参考答案是否一致；
2. 方向：增加/减少、上升/下降、正/负等方向必须一致，方向相反必须判错；
3. 数值：关键数值（含百分数）必须一致，数值不同必须判错；
4. 单位与量纲：不得改变物理/数学意义；
5. 条件与结论：遗漏导致结论变化的必要条件必须判错。

同时遵守：
- 表达方式不同 ≠ 错误。同义词（如 减少/下降/降低）、语序变化、补充不改变命运的对象说明，都不算错；
- 方向错误 / 数值错误 / 核心概念错误 ≠ 语义等价，必须判错；
- 拿不准时降低 confidence，不要硬判。

仅返回 JSON：
{"is_correct": true 或 false, "confidence": 0 到 1 的数字, "reason": "一句可审计的中文判定理由"}
不要返回其他文字，不要返回思维过程。"""

_LEGACY_SYSTEM_PROMPT = """你是严谨但公平的初中数学判题老师。判断学生答案在数学含义上是否正确，不要求措辞、格式或示例与参考答案一致。

规则：
1. 只判断知识结论、计算结果和题目要求的关键部分；同义词、换行、单位空格、键盘数学写法均不扣分。
2. 学生可以使用与参考答案不同但成立的生活实例或推导方法。
3. 多问或多空必须全部回答；结论相反、关键数值错误、漏掉必要部分时判错。
4. 参考答案可能只是示例，不得要求学生逐字复述。
5. 仅返回 JSON：{"is_correct": true 或 false, "reason": "一句中文理由"}。"""


def _build_prompt(
    *,
    question: Optional[str],
    reference_answer: str,
    user_answer: str,
    knowledge_point: Optional[str] = None,
    subject: Optional[str] = None,
) -> str:
    lines = []
    if subject:
        lines.append(f"学科：{subject}")
    if question:
        lines.append(f"题目：{question}")
    if knowledge_point:
        lines.append(f"考查知识点：{knowledge_point}")
    lines.append(f"参考答案：{reference_answer}")
    lines.append(f"学生答案：{user_answer}")
    lines.append("请按规则判定，仅返回 JSON。")
    return "\n".join(lines)


async def grade_blank_semantic(
    *,
    expected_answer: str,
    student_answer: str,
    question: Optional[str] = None,
    knowledge_point: Optional[str] = None,
    subject: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Grade one blank semantically.

    Returns ``{"is_correct": bool, "confidence": float, "reason": str}`` or
    ``None`` when the LLM is unavailable / unparsable — the caller must treat
    ``None`` as NEEDS_REVIEW, never as wrong.
    """
    from libs.text_utils import parse_llm_json
    from services.llm.router import get_llm_client

    prompt = _build_prompt(
        question=question,
        reference_answer=expected_answer,
        user_answer=student_answer,
        knowledge_point=knowledge_point,
        subject=subject,
    )
    try:
        client = get_llm_client("fast")
        response, _ = await asyncio.wait_for(
            client.chat(_SYSTEM_PROMPT, prompt),
            timeout=settings.semantic_grading_timeout_seconds,
        )
        parsed = parse_llm_json(response, default=None)
    except asyncio.TimeoutError:
        logger.warning("Semantic grading timed out after %.1fs", settings.semantic_grading_timeout_seconds)
        return None
    except Exception:  # noqa: BLE001 - providers expose different API error classes
        logger.exception("Semantic grading service unavailable")
        return None
    if not isinstance(parsed, dict) or not isinstance(parsed.get("is_correct"), bool):
        return None
    confidence = parsed.get("confidence")
    try:
        confidence = max(0.0, min(1.0, float(confidence)))
    except (TypeError, ValueError):
        confidence = 0.5
    reason = str(parsed.get("reason") or "").strip()
    # Never persist chain-of-thought; keep the audit reason short.
    if len(reason) > 200:
        reason = reason[:200]
    return {"is_correct": parsed["is_correct"], "confidence": confidence, "reason": reason}


async def grade_semantic_answer(
    *, question: str, reference_answer: str, user_answer: str
) -> bool | None:
    """Legacy whole-answer semantic verdict, kept for existing callers."""
    verdict = await grade_blank_semantic(
        expected_answer=reference_answer,
        student_answer=user_answer,
        question=question,
    )
    if verdict is None:
        return None
    return verdict["is_correct"]
