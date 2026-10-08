"""Tests for deterministic subject detection / upload planning."""

from services.ingestion.subject_detection import analyze_filename, build_upload_plan


class TestAnalyzeFilename:
    def test_math_subject(self):
        result = analyze_filename("七年级数学教材.pdf")
        assert result.subject == "数学"
        assert result.grade == "七年级"
        assert result.material_type == "教材"
        assert result.confidence == "high"

    def test_english_with_publisher(self):
        result = analyze_filename("人教版七年级英语上册单词表.docx")
        assert result.subject == "英语"
        assert result.publisher == "人教版"
        assert result.volume == "上册"
        assert result.material_type == "词汇字帖"

    def test_biology_lowercase_keyword(self):
        result = analyze_filename("生物知识点.docx")
        assert result.subject == "生物"
        assert result.material_type == "讲义笔记"

    def test_workbook(self):
        result = analyze_filename("数学练习册.pdf")
        assert result.subject == "数学"
        assert result.material_type == "练习册"

    def test_unrecognized_is_low_confidence(self):
        result = analyze_filename("扫描文件_001.pdf")
        assert result.subject is None
        assert result.confidence == "low"

    def test_grade_only_medium_confidence(self):
        result = analyze_filename("七年级上学期资料.pdf")
        assert result.subject is None
        assert result.grade == "七年级"
        assert result.confidence == "medium"


class TestBuildUploadPlan:
    def test_multi_subject_split(self):
        plan = build_upload_plan([
            "七年级数学教材.pdf",
            "七年级英语资料.pdf",
            "生物知识点.docx",
            "数学练习册.pdf",
        ])
        subjects = {g["subject"] for g in plan["groups"]}
        assert subjects == {"数学", "英语", "生物"}
        math_group = next(g for g in plan["groups"] if g["subject"] == "数学")
        assert len(math_group["files"]) == 2
        assert plan["unclassified"] == []

    def test_same_subject_same_grade_merges(self):
        plan = build_upload_plan(["七年级数学教材.pdf", "数学练习册.pdf"])
        assert len(plan["groups"]) == 1
        assert len(plan["groups"][0]["files"]) == 2

    def test_unclassified_goes_to_review(self):
        plan = build_upload_plan(["数学教材.pdf", "扫描文件.pdf"])
        assert len(plan["unclassified"]) == 1
        assert plan["unclassified"][0]["filename"] == "扫描文件.pdf"

    def test_suggested_name(self):
        plan = build_upload_plan(["人教版七年级数学上册教材.pdf"])
        assert plan["groups"][0]["suggested_name"] == "七年级数学上册"
