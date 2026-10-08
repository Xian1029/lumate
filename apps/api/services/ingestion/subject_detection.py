"""Deterministic subject / grade / textbook detection for upload grouping.

Used by the multi-file upload planning endpoint to propose how uploaded
files should be split into learning spaces. Purely rule-based (keywords +
regex) so results are stable, testable, and never hallucinated.

Confidence levels:
- "high":   explicit subject keyword in filename
- "medium": grade/version hints but ambiguous subject
- "low":    nothing recognizable -> goes to "待确认" bucket
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# ── Subject keyword banks (filename matching) ──
SUBJECT_KEYWORDS: dict[str, list[str]] = {
    "数学": ["数学", "math", "代数", "几何", "函数", "方程", "奥数", "算术"],
    "语文": ["语文", "汉语", "阅读", "作文", "文言文", "诗词", "chinese"],
    "英语": ["英语", "英文", "english", "grammar", "vocabulary", "听力", "口语"],
    "物理": ["物理", "physics", "力学", "电磁", "光学", "热学"],
    "化学": ["化学", "chemistry", "元素周期", "化学反应", "方程式"],
    "生物": ["生物", "biology", "细胞", "遗传", "生态"],
    "历史": ["历史", "history", "朝代", "史记"],
    "地理": ["地理", "geography", "地形", "气候", "地图"],
    "道德与法治": ["道德与法治", "道法", "政治", "思想品德", "思品"],
    "科学": ["科学", "science"],
    "信息技术": ["信息技术", "计算机", "编程", "信息科技", "python", "scratch"],
}

# Grade patterns: 七年级/初一/7年级/grade 7/七上/七下 ...
_GRADE_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"高[一二三3]"), None),  # handled specially below
]

_GRADE_MAP: list[tuple[re.Pattern, str]] = [
    (re.compile(r"七年级|初一|grade\s*7|7年级|七上|七下"), "七年级"),
    (re.compile(r"八年级|初二|grade\s*8|8年级|八上|八下"), "八年级"),
    (re.compile(r"九年级|初三|grade\s*9|9年级|九上|九下"), "九年级"),
    (re.compile(r"高一|grade\s*10|10年级|高1"), "高一"),
    (re.compile(r"高二|grade\s*11|11年级|高2"), "高二"),
    (re.compile(r"高三|grade\s*12|12年级|高3"), "高三"),
    (re.compile(r"四年级|grade\s*4|4年级"), "四年级"),
    (re.compile(r"五年级|grade\s*5|5年级"), "五年级"),
    (re.compile(r"六年级|grade\s*6|6年级"), "六年级"),
    (re.compile(r"三年级|grade\s*3|3年级"), "三年级"),
    (re.compile(r"二年级|grade\s*2|2年级"), "二年级"),
    (re.compile(r"一年级|grade\s*1|1年级"), "一年级"),
]

# Textbook publishers / versions
_PUBLISHER_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"人教版|人民教育出版社|PEP"), "人教版"),
    (re.compile(r"北师大版|北京师范大学出版社"), "北师大版"),
    (re.compile(r"苏教版|江苏教育出版社"), "苏教版"),
    (re.compile(r"沪教版|上海教育出版社"), "沪教版"),
    (re.compile(r"浙教版|浙江教育出版社"), "浙教版"),
    (re.compile(r"湘教版|湖南教育出版社"), "湘教版"),
    (re.compile(r"冀教版|河北教育出版社"), "冀教版"),
    (re.compile(r"华师大版|华东师范大学出版社"), "华师大版"),
    (re.compile(r"青岛版"), "青岛版"),
    (re.compile(r"西师大版|西南师范大学出版社"), "西师大版"),
    (re.compile(r"外研版|外语教学与研究出版社"), "外研版"),
    (re.compile(r"译林版|译林出版社"), "译林版"),
]

_VOLUME_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"上册|第一册|上学期"), "上册"),
    (re.compile(r"下册|第二册|下学期"), "下册"),
    (re.compile(r"全一册|全册"), "全一册"),
]

# Material type hints from filename
_MATERIAL_TYPE_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"教材|课本|教科书|textbook"), "教材"),
    (re.compile(r"练习册|习题|题库|workbook|exercise|课时练|同步练习"), "练习册"),
    (re.compile(r"试卷|真题|模拟|test|exam|月考|期中|期末"), "试卷"),
    (re.compile(r"知识点|讲义|笔记|notes|summary|复习资料|handout"), "讲义笔记"),
    (re.compile(r"单词|词汇|vocabulary|字帖"), "词汇字帖"),
]


@dataclass
class FileAnalysis:
    filename: str
    subject: str | None = None
    grade: str | None = None
    publisher: str | None = None
    volume: str | None = None
    material_type: str | None = None
    confidence: str = "low"

    def to_dict(self) -> dict:
        return {
            "filename": self.filename,
            "subject": self.subject,
            "grade": self.grade,
            "publisher": self.publisher,
            "volume": self.volume,
            "material_type": self.material_type,
            "confidence": self.confidence,
        }


def analyze_filename(filename: str) -> FileAnalysis:
    """Analyze a single filename for subject/grade/version hints."""
    text = filename.lower()
    result = FileAnalysis(filename=filename)

    # Subject: count keyword hits, require unique best match
    hits: dict[str, int] = {}
    for subject, keywords in SUBJECT_KEYWORDS.items():
        for kw in keywords:
            if kw in text:
                hits[subject] = hits.get(subject, 0) + len(kw)
                break  # one hit per subject is enough
    if len(hits) == 1:
        result.subject = next(iter(hits))
    elif len(hits) > 1:
        # Multiple subjects matched: pick strongest, mark low confidence
        best = max(hits.items(), key=lambda kv: kv[1])
        result.subject = best[0]

    for pattern, grade in _GRADE_MAP:
        if pattern.search(filename):
            result.grade = grade
            break

    for pattern, publisher in _PUBLISHER_PATTERNS:
        if pattern.search(filename):
            result.publisher = publisher
            break

    for pattern, volume in _VOLUME_PATTERNS:
        if pattern.search(filename):
            result.volume = volume
            break

    for pattern, mtype in _MATERIAL_TYPE_PATTERNS:
        if pattern.search(filename):
            result.material_type = mtype
            break

    # Confidence
    if result.subject:
        result.confidence = "high"
    elif result.grade or result.publisher:
        result.confidence = "medium"
    else:
        result.confidence = "low"
    return result


@dataclass
class UploadPlanGroup:
    """A proposed learning space (one subject cluster)."""

    key: str  # grouping key e.g. "数学|七年级"
    subject: str | None
    grade: str | None
    publisher: str | None
    volume: str | None
    suggested_name: str
    files: list[FileAnalysis] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "subject": self.subject,
            "grade": self.grade,
            "publisher": self.publisher,
            "volume": self.volume,
            "suggested_name": self.suggested_name,
            "files": [f.to_dict() for f in self.files],
        }


def build_upload_plan(filenames: list[str]) -> dict:
    """Group filenames into proposed learning spaces by subject/grade.

    Returns:
        {
          "groups": [UploadPlanGroup...],       # confident clusters
          "unclassified": [FileAnalysis...],    # low-confidence -> user decides
        }
    """
    analyses = [analyze_filename(name) for name in filenames]

    groups: dict[str, UploadPlanGroup] = {}
    unclassified: list[FileAnalysis] = []

    for analysis in analyses:
        if analysis.confidence == "low" or not analysis.subject:
            unclassified.append(analysis)
            continue
        key = "|".join(filter(None, [analysis.subject, analysis.grade]))
        # Files without grade info merge into an existing same-subject group
        # when exactly one exists, instead of creating a parallel bare group.
        if analysis.grade is None and key not in groups:
            same_subject = [k for k in groups if k.split("|", 1)[0] == analysis.subject]
            if len(same_subject) == 1:
                key = same_subject[0]
        if key not in groups:
            groups[key] = UploadPlanGroup(
                key=key,
                subject=analysis.subject,
                grade=analysis.grade,
                publisher=analysis.publisher,
                volume=analysis.volume,
                suggested_name=_suggest_space_name(analysis),
            )
        group = groups[key]
        # Merge richer metadata from later files (publisher/volume)
        if not group.publisher and analysis.publisher:
            group.publisher = analysis.publisher
        if not group.volume and analysis.volume:
            group.volume = analysis.volume
        group.files.append(analysis)

    return {
        "groups": [g.to_dict() for g in groups.values()],
        "unclassified": [f.to_dict() for f in unclassified],
    }


def _suggest_space_name(analysis: FileAnalysis) -> str:
    parts = [p for p in (analysis.grade, analysis.subject) if p]
    name = "".join(parts) if parts else (analysis.subject or "新学习空间")
    if analysis.volume and analysis.volume not in name:
        name += analysis.volume
    return name
