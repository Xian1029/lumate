"""Regression tests for opening textbooks after moving the project folder."""

from pathlib import Path

from services.upload_storage import resolve_upload_path, upload_record_path


def test_resolves_migrated_absolute_upload_by_basename(tmp_path: Path):
    upload_root = tmp_path / "current" / "uploads"
    upload_root.mkdir(parents=True)
    textbook = upload_root / "book.pdf"
    textbook.write_bytes(b"%PDF-1.4")

    resolved = resolve_upload_path(
        "/Users/example/old-project/uploads/book.pdf",
        str(upload_root),
    )

    assert resolved == textbook.resolve()


def test_never_serves_existing_file_outside_current_upload_root(tmp_path: Path):
    upload_root = tmp_path / "current" / "uploads"
    upload_root.mkdir(parents=True)
    outside = tmp_path / "private.pdf"
    outside.write_bytes(b"private")

    resolved = resolve_upload_path(str(outside), str(upload_root))

    assert resolved is None


def test_rejects_traversal_when_relative_path_escapes_upload_root(tmp_path: Path):
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    outside = tmp_path / "outside.pdf"
    outside.write_bytes(b"private")

    resolved = resolve_upload_path("../outside.pdf", str(upload_root))

    assert resolved is None


def test_new_upload_record_is_portable(tmp_path: Path):
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    textbook = upload_root / "book.pdf"
    textbook.write_bytes(b"%PDF-1.4")

    assert upload_record_path(str(textbook), str(upload_root)) == "book.pdf"
