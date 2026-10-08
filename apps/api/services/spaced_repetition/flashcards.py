"""Flashcard generation service.

Auto-generates flashcards from course content using LLM.
Reference: spaceforge — 6-provider AI flashcard generation pattern.
"""

import uuid
import logging
import re
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.content import CourseContentTree
from models.progress import LearningProgress
from services.llm.router import get_llm_client
from services.content_text import is_assessment_content, is_generic_textbook_prompt, is_non_learning_question
from services.generated_assets import get_active_note_markdown_by_node
from services.spaced_repetition.fsrs import FSRSCard, review_card

logger = logging.getLogger(__name__)

FLASHCARD_PROMPT = """Generate flashcards from this educational content.

Content:
{content}

Create {count} flashcards. Each flashcard should have:
- A clear, specific question (front)
- A concise, accurate answer (back)
- A difficulty tag: easy, medium, or hard
- A knowledge_points array using only names from the available graph concepts

Output as JSON array:
[
  {{"front": "question", "back": "answer", "difficulty": "medium", "knowledge_points": ["exact concept name"]}},
  ...
]

Rules:
- IMPORTANT: Write ALL question (front) and answer (back) text in the requested learner language. Keep formulas, proper nouns, and technical terms accurate.
- Focus on key concepts and definitions
- Avoid trivial questions
- Make questions specific enough to have one clear answer
- Write for a K-12 learner: use clear, encouraging language and prefer a
  concrete mini-situation or “why/how” prompt when the note supports it
- Keep the cards in a logical learning order: idea, example, then application
- Never create cards about publishers, editors, authors, ISBNs, copyright,
  printing, or other book-production metadata
- Never ask for a textbook, chapter, unit, or section title/name, the number
  of chapters, a table-of-contents entry, or other document navigation detail
- Every question must name a specific concept; never use vague wording such as
  "课本中介绍了什么" or "本节学习了什么"
- Include a mix of recall, understanding, and application questions"""

_NOVELTY_PROMPT = """
Available graph concepts (copy exact names into knowledge_points):
{concept_names}

Do not repeat or lightly paraphrase any of these existing card questions:
{excluded_questions}
Every new card must use a different question angle, example, or application.
"""

_MODE_FLASHCARD_HINTS: dict[str, str] = {
    "exam_prep": "\nMode: EXAM PREP — Prefer cloze-deletion style and application questions. Bias toward harder difficulty.",
    "maintenance": "\nMode: MAINTENANCE — Only cover previously-seen core concepts. Focus on retention, not new material.",
    "self_paced": "\nMode: SELF-PACED — Include exploratory, open-ended questions. Encourage cross-topic connections.",
    "course_following": "\nMode: COURSE FOLLOWING — Follow the syllabus order. Only test concepts from the provided content.",
}


def _is_in_requested_language(card: object, language: str | None) -> bool:
    if not isinstance(card, dict):
        return False
    front = str(card.get("front") or "").strip()
    back = str(card.get("back") or "").strip()
    if not front or not back:
        return False
    text = f"{front} {back}"
    if language == "zh":
        # Do not accept an English sentence that merely appends a Chinese
        # glossary term in parentheses. Chinese must be the primary card
        # language, while formulas and short technical identifiers remain
        # allowed.
        han_count = len(re.findall(r"[\u4e00-\u9fff]", text))
        latin_count = len(re.findall(r"[A-Za-z]", text))
        return han_count >= 4 and han_count >= latin_count * 0.35
    if language == "en":
        return len(re.findall(r"[A-Za-z]{3,}", text)) >= 2
    return True


def _fallback_chinese_flashcards(content: str, title: str, count: int) -> list[dict]:
    """Make a small, readable Chinese study set when an LLM ignores locale.

    This is deliberately conservative: it quotes only the supplied course text
    and gives the learner a clear recall prompt, rather than inventing facts.
    """
    sentences = [
        re.sub(r"\s+", " ", sentence).strip(" -–—#*`\t")
        for sentence in re.split(r"[。！？!?]\s*", content)
    ]
    sentences = [sentence for sentence in sentences if len(re.findall(r"[\u4e00-\u9fff]", sentence)) >= 8]
    cards: list[dict] = []
    if title and len(re.findall(r"[\u4e00-\u9fff]", title)) >= 2:
        cards.append({
            "front": f"这一节“{title}”主要学习什么？",
            "back": sentences[0][:180] if sentences else title,
            "difficulty": "easy",
        })
    for sentence in sentences:
        if len(cards) >= count:
            break
        cards.append({
            "front": f"请用自己的话复述这条知识：{sentence[:70]}",
            "back": sentence[:220],
            "difficulty": "medium",
        })
    return cards[:count]


async def generate_flashcards(
    db: AsyncSession,
    course_id: uuid.UUID,
    content_node_id: uuid.UUID | None = None,
    count: int = 5,
    mode: str | None = None,
    language: str | None = None,
    user_id: uuid.UUID | None = None,
    exclude_fronts: list[str] | None = None,
) -> list[dict]:
    """Generate flashcards from course content using LLM.

    If content_node_id is provided, generates from that specific node.
    Otherwise, generates from the most recent content.
    """
    # Get content
    if content_node_id:
        result = await db.execute(
            select(CourseContentTree).where(CourseContentTree.id == content_node_id)
        )
        nodes = [result.scalar_one_or_none()]
        nodes = [
            n for n in nodes
            if n and is_assessment_content(
                n.title, n.content, content_category=n.content_category,
            )
        ]
    else:
        result = await db.execute(
            select(CourseContentTree)
            .where(CourseContentTree.course_id == course_id)
            .order_by(CourseContentTree.order_index, CourseContentTree.created_at)
        )
        nodes = [
            node for node in result.scalars().all()
            if is_assessment_content(
                node.title, node.content, content_category=node.content_category, level=node.level,
            )
        ][:5]

    if not nodes:
        return []

    note_by_node = (
        await get_active_note_markdown_by_node(db, user_id=user_id, course_id=course_id)
        if user_id is not None
        else {}
    )
    # Cards must come from the same child-friendly section notes the learner
    # sees, never from raw PDF pages or document metadata.
    if user_id is not None:
        nodes = [node for node in nodes if note_by_node.get(str(node.id))]
    if not nodes:
        return []

    content = "\n\n".join(
        f"## {n.title}\n{note_by_node[str(n.id)]}"
        for n in nodes
    )[:5000]  # Limit context size

    from models.knowledge_graph import KnowledgeNode

    concept_result = await db.execute(
        select(KnowledgeNode).where(KnowledgeNode.course_id == course_id)
    )
    graph_concepts = [node.name for node in concept_result.scalars().all()]
    normalized_concepts = {name.casefold(): name for name in graph_concepts}

    client = get_llm_client()
    prompt = FLASHCARD_PROMPT.format(content=content, count=count)
    prompt += _NOVELTY_PROMPT.format(
        concept_names="、".join(graph_concepts[:80]) or "(none)",
        excluded_questions="\n".join(f"- {front}" for front in (exclude_fronts or [])[:30]) or "(none)",
    )
    if mode and mode in _MODE_FLASHCARD_HINTS:
        prompt += _MODE_FLASHCARD_HINTS[mode]
    output_language = "Simplified Chinese" if language == "zh" else "English" if language == "en" else "the source material language"
    response, _ = await client.chat(
        f"You are an expert at creating educational flashcards. Output only valid JSON. Write all question and answer text in {output_language}.",
        prompt,
    )

    # Parse response
    from libs.text_utils import parse_llm_json

    flashcards = parse_llm_json(response, default=[])
    if not isinstance(flashcards, list):
        logger.warning("Failed to parse flashcard JSON, returning empty")
        flashcards = []

    flashcards = [
        card for card in flashcards
        if _is_in_requested_language(card, language)
        and not is_non_learning_question(str(card.get("front") or ""))
        and not is_generic_textbook_prompt(str(card.get("front") or ""))
    ]
    excluded_normalized = {
        re.sub(r"\s+", "", str(front)).casefold()
        for front in (exclude_fronts or [])
        if str(front).strip()
    }
    flashcards = [
        card for card in flashcards
        if re.sub(r"\s+", "", str(card.get("front") or "")).casefold() not in excluded_normalized
    ]

    # A few providers can ignore a system-message locale instruction. Retry
    # once with the requirement repeated in the user prompt before falling back
    # to a source-only study set. This keeps the Chinese UI useful without
    # ever surfacing English cards as if they were translated.
    if language == "zh" and not flashcards:
        retry_prompt = (
            "请只使用简体中文重新生成闪卡。每张卡片的 front 和 back 都必须以中文为主；"
            "不能输出英文句子，也不能只在英文后面加中文括号。仅返回 JSON 数组。\n\n"
            f"教材标题：{nodes[0].title}\n教材内容：\n{content}\n\n"
            f"请生成 {count} 张适合学生复习的闪卡。"
        )
        retry_response, _ = await client.chat(
            "你是中文学习卡片编辑。输出仅包含简体中文的有效 JSON 数组。",
            retry_prompt,
        )
        retry_cards = parse_llm_json(retry_response, default=[])
        if isinstance(retry_cards, list):
            flashcards = [
                card for card in retry_cards
                if _is_in_requested_language(card, language)
                and not is_non_learning_question(str(card.get("front") or ""))
                and not is_generic_textbook_prompt(str(card.get("front") or ""))
            ]

    # Apply novelty filtering after every generation path, including the
    # locale retry above, and remove duplicates inside the new set itself.
    seen_fronts = set(excluded_normalized)
    unique_flashcards: list[dict] = []
    for card in flashcards:
        normalized_front = re.sub(r"\s+", "", str(card.get("front") or "")).casefold()
        if not normalized_front or normalized_front in seen_fronts:
            continue
        seen_fronts.add(normalized_front)
        unique_flashcards.append(card)
    flashcards = unique_flashcards

        # Do not manufacture generic cards when the provider output fails the
        # quality/language filters. An empty set is safer than misleading K-12
        # content; the learner can retry generation.

    # Add metadata
    for i, card in enumerate(flashcards):
        requested_points = card.get("knowledge_points") or []
        if isinstance(requested_points, str):
            requested_points = [requested_points]
        valid_points = [
            normalized_concepts[str(point).casefold()]
            for point in requested_points
            if str(point).casefold() in normalized_concepts
        ][:5]
        if not valid_points:
            visible = f"{card.get('front', '')} {card.get('back', '')}".casefold()
            valid_points = sorted(
                (name for name in graph_concepts if name.casefold() in visible),
                key=len,
                reverse=True,
            )[:5]
        card["knowledge_points"] = valid_points
        if valid_points:
            card["concept"] = valid_points[0]
        card["id"] = str(uuid.uuid4())
        card["course_id"] = str(course_id)
        card["content_node_id"] = str(content_node_id) if content_node_id else None
        card["fsrs"] = {
            "difficulty": 5.0,
            "stability": 0.0,
            "reps": 0,
            "lapses": 0,
            "state": "new",
            "due": None,
        }

    return flashcards


def review_flashcard(card_data: dict, rating: int) -> dict:
    """Process a flashcard review using FSRS algorithm.

    rating: 1=Again, 2=Hard, 3=Good, 4=Easy
    Returns updated card data with next review date.
    """
    fsrs_data = card_data.get("fsrs", {})

    card = FSRSCard(
        difficulty=fsrs_data.get("difficulty", 5.0),
        stability=fsrs_data.get("stability", 0.0),
        reps=fsrs_data.get("reps", 0),
        lapses=fsrs_data.get("lapses", 0),
        state=fsrs_data.get("state", "new"),
        last_review=datetime.fromisoformat(fsrs_data["last_review"]) if fsrs_data.get("last_review") else None,
    )

    card, log = review_card(card, rating)

    card_data["fsrs"] = {
        "difficulty": card.difficulty,
        "stability": card.stability,
        "reps": card.reps,
        "lapses": card.lapses,
        "state": card.state,
        "last_review": card.last_review.isoformat() if card.last_review else None,
        "due": card.due.isoformat() if card.due else None,
    }

    return card_data
