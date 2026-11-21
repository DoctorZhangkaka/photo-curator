"""轻量版本化迁移。

原则：schema 只增不改，升级不删除数据库；每个版本在事务内执行且只执行一次。
当前版本 1 由 SQLAlchemy metadata 创建，版本 2 增加查询索引，用于验证迁移链。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import Connection, Engine

from .models import Base
from .natural import utcnow_iso

LATEST_SCHEMA_VERSION = 2


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    apply: Callable[[Connection], None]


def _initial_schema(conn: Connection) -> None:
    Base.metadata.create_all(conn)


def _query_indexes(conn: Connection) -> None:
    conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_operations_type_status ON operations (type, status)")
    conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_assets_relative_path ON assets (relative_path)")
    conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_export_conflicts_album ON export_conflicts (album_id)")


MIGRATIONS: tuple[Migration, ...] = (
    Migration(1, "initial schema", _initial_schema),
    Migration(2, "query indexes", _query_indexes),
)


def migrate(engine: Engine) -> int:
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
        )
        applied = {int(row[0]) for row in conn.exec_driver_sql("SELECT version FROM schema_migrations").fetchall()}
        for migration in MIGRATIONS:
            if migration.version in applied:
                continue
            migration.apply(conn)
            conn.exec_driver_sql(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
                (migration.version, migration.name, utcnow_iso()),
            )
        conn.exec_driver_sql(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('db_schema_version', ?, ?)",
            (str(LATEST_SCHEMA_VERSION), utcnow_iso()),
        )
    return LATEST_SCHEMA_VERSION
