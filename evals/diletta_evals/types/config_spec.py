# Generated from evals/schemas/ by scripts/generate_types.py (pnpm evals:types). Do not edit.

from __future__ import annotations

from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, RootModel


class Persona(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    instructions: Annotated[str, Field(max_length=20000, min_length=1)]


class Procedure(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    name: Annotated[str, Field(max_length=100, min_length=1)]
    whenToUse: Annotated[str, Field(max_length=1000, min_length=1)]
    steps: Annotated[str, Field(max_length=10000, min_length=1)]


class Tool(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    name: Annotated[str, Field(max_length=100, min_length=1)]
    version: Annotated[int, Field(ge=1, le=9007199254740991)]


class Role(RootModel[str]):
    root: Annotated[str, Field(max_length=100, min_length=1)]


class Tool1(RootModel[str]):
    root: Annotated[str, Field(max_length=100, min_length=1)]


class Approval(StrEnum):
    auto = "auto"
    required = "required"
    blocked = "blocked"


class ApprovalRule(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    roles: Annotated[list[Role], Field(max_length=50)]
    tools: Annotated[list[Tool1], Field(max_length=200)]
    approval: Approval


class Provider(StrEnum):
    google = "google"
    openai = "openai"
    anthropic = "anthropic"


class Small(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    provider: Provider
    model: Annotated[str, Field(max_length=200, min_length=1)]


class Mid(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    provider: Provider
    model: Annotated[str, Field(max_length=200, min_length=1)]


class Top(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    provider: Provider
    model: Annotated[str, Field(max_length=200, min_length=1)]


class DefaultTier(StrEnum):
    small = "small"
    mid = "mid"
    top = "top"


class Routing(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    small: Small
    mid: Mid
    top: Top
    defaultTier: DefaultTier


class SourceId(RootModel[str]):
    root: Annotated[str, Field(max_length=64, min_length=1)]


class Knowledge(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    sourceIds: Annotated[list[SourceId], Field(max_length=200)]
    topK: Annotated[int | None, Field(ge=1, le=20)] = None


class Suggestion(RootModel[str]):
    root: Annotated[str, Field(max_length=120, min_length=1)]


class Widget(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    greeting: Annotated[str, Field(max_length=500, min_length=1)]
    suggestions: Annotated[list[Suggestion], Field(max_length=3)]
    launcherLabel: Annotated[str | None, Field(max_length=40, min_length=1)] = None


class Limits(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    maxStepsPerTurn: Annotated[int | None, Field(ge=1, le=50)] = None
    maxTokensPerTurn: Annotated[int | None, Field(ge=1, le=1000000)] = None
    turnTimeoutSeconds: Annotated[int | None, Field(ge=1, le=900)] = None
    turnCostCapUsd: Annotated[float | None, Field(gt=0.0, le=100.0)] = None
    conversationTurnsPerHour: Annotated[int | None, Field(ge=1, le=600)] = None
    conversationCostCapUsd: Annotated[float | None, Field(gt=0.0, le=1000.0)] = None
    userMessagesPerMinute: Annotated[int | None, Field(ge=1, le=60)] = None
    userDailyCostCapUsd: Annotated[float | None, Field(gt=0.0, le=1000.0)] = None


class Attachments(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    isImageUploadEnabled: bool | None = None
    maxImagesPerMessage: Annotated[int | None, Field(ge=1, le=10)] = None
    maxImageBytes: Annotated[int | None, Field(ge=1, le=20971520)] = None


class ConfigSpec(BaseModel):
    """
    chatbot_configs.body at schema_version 1
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    persona: Persona
    procedures: Annotated[list[Procedure], Field(max_length=50)]
    tools: Annotated[list[Tool], Field(max_length=200)]
    approvalRules: Annotated[list[ApprovalRule], Field(max_length=100)]
    routing: Routing
    knowledge: Knowledge
    widget: Widget
    limits: Limits | None = None
    attachments: Attachments | None = None
