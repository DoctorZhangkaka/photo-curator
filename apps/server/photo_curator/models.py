"""SQLAlchemy 数据模型。

时间统一存储为 UTC ISO8601 字符串（Z 结尾），便于 SQLite 字符串排序与游标分页。
所有 ID 为 UUID 字符串，为未来同步保留空间；删除使用 deleted_at 软删除标记。
"""

from __future__ import annotations

import uuid

from sqlalchemy import (
    BigInteger,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from .natural import utcnow_iso


def new_id() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


def _timestamps() -> tuple[Mapped[str], Mapped[str]]:
    return (
        mapped_column(String(32), nullable=False, default=utcnow_iso),
        mapped_column(String(32), nullable=False, default=utcnow_iso, onupdate=utcnow_iso),
    )


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso, onupdate=utcnow_iso)


class Album(Base):
    __tablename__ = "albums"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    relative_path: Mapped[str] = mapped_column(String(512), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(512), nullable=False)
    cover_photo_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    last_opened_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    last_scanned_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    scan_status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    scan_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    scan_report_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso, onupdate=utcnow_iso)
    deleted_at: Mapped[str | None] = mapped_column(String(32), nullable=True)

    photo_groups: Mapped[list[PhotoGroup]] = relationship(back_populates="album", cascade="all, delete-orphan")


class PhotoGroup(Base):
    __tablename__ = "photo_groups"
    __table_args__ = (
        UniqueConstraint("album_id", "normalized_pair_key", name="uq_photo_group_pair_key"),
        Index("ix_photo_groups_album_sort", "album_id", "sort_key"),
        Index("ix_photo_groups_album_natural", "album_id", "natural_key"),
        Index("ix_photo_groups_selection", "album_id", "selection_status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    album_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("albums.id", ondelete="CASCADE"), nullable=False, index=True
    )
    normalized_pair_key: Mapped[str] = mapped_column(String(512), nullable=False)
    display_name: Mapped[str] = mapped_column(String(512), nullable=False)
    natural_key: Mapped[str] = mapped_column(String(512), nullable=False)
    viewed_status: Mapped[str] = mapped_column(String(16), nullable=False, default="unseen")
    selection_status: Mapped[str] = mapped_column(String(16), nullable=False, default="unmarked")
    pairing_status: Mapped[str] = mapped_column(String(16), nullable=False, default="normal")
    conflict_reasons_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    capture_time: Mapped[str | None] = mapped_column(String(32), nullable=True)
    sort_key: Mapped[str] = mapped_column(String(600), nullable=False, default="")
    metadata_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    metadata_fingerprint: Mapped[str | None] = mapped_column(String(128), nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso, onupdate=utcnow_iso)
    deleted_at: Mapped[str | None] = mapped_column(String(32), nullable=True)

    album: Mapped[Album] = relationship(back_populates="photo_groups")
    assets: Mapped[list[Asset]] = relationship(back_populates="photo_group", cascade="all, delete-orphan")


class Asset(Base):
    __tablename__ = "assets"
    __table_args__ = (
        UniqueConstraint("photo_group_id", "relative_path", name="uq_asset_group_path"),
        Index("ix_assets_group", "photo_group_id"),
        Index("ix_assets_presence", "presence_status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    photo_group_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("photo_groups.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(8), nullable=False)  # jpg / raw
    extension: Mapped[str] = mapped_column(String(16), nullable=False)  # 原始大小写，如 .RAF
    relative_path: Mapped[str] = mapped_column(String(512), nullable=False)  # 相对相册根目录
    original_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    mtime_ns: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    presence_status: Mapped[str] = mapped_column(String(16), nullable=False, default="present")
    content_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    preview_status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    preview_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso, onupdate=utcnow_iso)

    photo_group: Mapped[PhotoGroup] = relationship(back_populates="assets")


class Operation(Base):
    __tablename__ = "operations"
    __table_args__ = (Index("ix_operations_requested", "requested_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True, unique=True)
    parent_operation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    album_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("albums.id", ondelete="SET NULL"), nullable=True
    )
    type: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="preflight")
    requested_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso)
    started_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    finished_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    requested_photo_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    requested_file_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    success_file_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped_file_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_file_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    conflict_file_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    request_snapshot_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    progress_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    restored_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    restore_operation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso)

    items: Mapped[list[OperationItem]] = relationship(back_populates="operation", cascade="all, delete-orphan")


class OperationItem(Base):
    __tablename__ = "operation_items"
    __table_args__ = (Index("ix_operation_items_operation", "operation_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    operation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("operations.id", ondelete="CASCADE"), nullable=False
    )
    photo_group_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    asset_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    display_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    source_relative_path: Mapped[str] = mapped_column(String(1024), nullable=False, default="")
    destination_path_snapshot: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    source_size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    source_mtime_ns: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    content_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    result: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    group_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso)

    operation: Mapped[Operation] = relationship(back_populates="items")


class ExportConflict(Base):
    __tablename__ = "export_conflicts"
    __table_args__ = (
        UniqueConstraint("album_id", "source_relative_path", "destination_relative_path", name="uq_export_conflict"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    album_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("albums.id", ondelete="CASCADE"), nullable=False, index=True
    )
    operation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    source_relative_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    destination_relative_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    conflict_type: Mapped[str] = mapped_column(String(32), nullable=False, default="same_name_different_content")
    source_size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    destination_size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    last_seen_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso)


class PreflightToken(Base):
    __tablename__ = "preflight_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    album_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    operation_id: Mapped[str] = mapped_column(String(36), nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso)
    expires_at: Mapped[str] = mapped_column(String(32), nullable=False)
    used_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class Issue(Base):
    __tablename__ = "issues"
    __table_args__ = (UniqueConstraint("fingerprint", name="uq_issue_fingerprint"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    album_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("albums.id", ondelete="CASCADE"), nullable=True, index=True
    )
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    severity: Mapped[str] = mapped_column(String(16), nullable=False, default="warning")
    fingerprint: Mapped[str] = mapped_column(String(128), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False, default="")
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    operation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    last_seen_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso)
    resolved_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False, default=utcnow_iso)
