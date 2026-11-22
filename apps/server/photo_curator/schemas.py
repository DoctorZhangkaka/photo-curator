"""请求体模型（camelCase）。"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class PhotoStatePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    viewedStatus: Literal["unseen", "viewed"] | None = None
    selectionStatus: Literal["unmarked", "selected", "pending_delete"] | None = None
    version: int = Field(ge=1)


class OrganizePreflightRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keepBackup: bool = False


class PreflightExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preflightToken: str = Field(min_length=8, max_length=256)
    idempotencyKey: str = Field(min_length=8, max_length=128)


class SettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    defaultSort: Literal["capture", "filename"] | None = None
    autoplayInterval: Literal[2, 3, 5, 10] | None = None
    cleanupNoticeSeen: bool | None = None
