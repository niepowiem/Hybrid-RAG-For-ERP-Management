from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import re
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, model_validator


MODELS_ROOT = Path(os.environ.get("CRM_MODELS_ROOT", "/models")).resolve()
LEGACY_MODEL_DIR = os.environ.get("CRM_MODEL_DIR", "").strip()
API_KEY = os.environ.get("CRM_AI_API_KEY", "").strip()
if not API_KEY:
    raise RuntimeError("CRM_AI_API_KEY musi być ustawiony dla usługi klasyfikatora.")
THRESHOLD = os.environ.get("CRM_CLASSIFIER_THRESHOLD", "").strip()
DEFAULT_MODEL_VERSION = os.environ.get(
    "CRM_DEFAULT_MODEL_VERSION", "stacking-crm-v1-dgx"
).strip()
MODEL_VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


def configured_versions() -> tuple[str, ...]:
    raw = os.environ.get("CRM_ALLOWED_MODEL_VERSIONS", DEFAULT_MODEL_VERSION)
    versions = tuple(dict.fromkeys(part.strip() for part in raw.split(",") if part.strip()))
    if not versions:
        raise RuntimeError("CRM_ALLOWED_MODEL_VERSIONS nie może być puste.")
    for version in versions:
        if MODEL_VERSION_PATTERN.fullmatch(version) is None:
            raise RuntimeError(f"Niepoprawna nazwa wersji modelu: {version!r}.")
    if DEFAULT_MODEL_VERSION not in versions:
        raise RuntimeError("Model domyślny musi znajdować się na liście dozwolonych wersji.")
    return versions


ALLOWED_MODEL_VERSIONS = configured_versions()
_models: dict[str, Any] = {}
_model_contracts: dict[str, dict[str, Any]] = {}
_model_errors: dict[str, str] = {}
_inference_lock = asyncio.Lock()


def verify_manifest(model_dir: Path) -> None:
    """Weryfikuje zaufany pakiet przed załadowaniem pliku joblib/pickle."""
    manifest_path = model_dir / "manifest.json"
    if not manifest_path.exists():
        raise RuntimeError("Brak manifest.json w katalogu modelu.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for relative, expected in manifest.get("files", {}).items():
        path = (model_dir / relative).resolve()
        if model_dir not in path.parents or not path.is_file():
            raise RuntimeError(f"Brak lub niepoprawna ścieżka artefaktu: {relative}")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected.get("sha256"):
            raise RuntimeError(f"Niezgodna suma SHA-256 artefaktu: {relative}")


def read_model_version(model_dir: Path) -> str:
    metadata_path = model_dir / "metadata.json"
    if not metadata_path.is_file():
        raise RuntimeError("Brak metadata.json w katalogu modelu.")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    version = str(metadata.get("model_version", "")).strip()
    if MODEL_VERSION_PATTERN.fullmatch(version) is None:
        raise RuntimeError("metadata.json zawiera niepoprawną wersję modelu.")
    return version


def discover_model_dirs() -> dict[str, Path]:
    """Odnajduje modele po metadanych; nazwa katalogu nie steruje ścieżką żądania."""
    candidates: list[Path] = []
    if LEGACY_MODEL_DIR:
        candidates.append(Path(LEGACY_MODEL_DIR).resolve())
    if MODELS_ROOT.is_dir():
        candidates.extend(path.resolve() for path in MODELS_ROOT.iterdir() if path.is_dir())

    discovered: dict[str, Path] = {}
    for model_dir in candidates:
        if model_dir != MODELS_ROOT and MODELS_ROOT not in model_dir.parents:
            raise RuntimeError(f"Model znajduje się poza CRM_MODELS_ROOT: {model_dir}")
        try:
            version = read_model_version(model_dir)
        except (OSError, ValueError, RuntimeError, json.JSONDecodeError):
            continue
        if version not in ALLOWED_MODEL_VERSIONS:
            continue
        if version in discovered and discovered[version] != model_dir:
            raise RuntimeError(f"Znaleziono dwa katalogi wersji {version}.")
        discovered[version] = model_dir
    return discovered


def load_classifier(model_dir: Path, version: str) -> Any:
    verify_manifest(model_dir)
    inference_path = model_dir / "inference.py"
    module_suffix = hashlib.sha256(version.encode("utf-8")).hexdigest()[:12]
    spec = importlib.util.spec_from_file_location(
        f"crm_exported_inference_{module_suffix}", inference_path
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Nie można załadować inference.py z pakietu modelu.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    model = module.CRMInquiryClassifier(model_dir)
    if str(model.model_version) != version:
        raise RuntimeError("Wersja załadowanego modelu nie zgadza się z metadata.json.")
    return model


def build_model_contract(model: Any) -> dict[str, Any]:
    """Buduje i lokalnie weryfikuje kontrakt encodera z klasyfikatorem."""
    metadata = model.metadata
    dimension = model.encoder.get_sentence_embedding_dimension()
    expected_dimension = int(getattr(model.classifier, "n_features_in_", dimension))
    if dimension is None or int(dimension) != expected_dimension:
        raise RuntimeError(
            f"Niezgodny wymiar encodera ({dimension}) i klasyfikatora ({expected_dimension})."
        )
    encoder_name = str(metadata.get("encoder_name", "")).strip()
    if not encoder_name:
        raise RuntimeError("Brak encoder_name w metadata.json.")
    return {
        "model_name": encoder_name,
        "model_version": str(model.model_version),
        "embedding_dimension": int(dimension),
        "normalize_embeddings": bool(model.normalize_embeddings),
        "preprocessing_version": int(metadata.get("format_version", 1)),
    }


def model_states() -> list[dict[str, Any]]:
    states: list[dict[str, Any]] = []
    for version in ALLOWED_MODEL_VERSIONS:
        if version in _model_contracts:
            states.append({"state": "ready", "model_contract": _model_contracts[version]})
        else:
            states.append(
                {
                    "state": "error",
                    "model_version": version,
                    "error": _model_errors.get(version, "Model nie został załadowany."),
                }
            )
    return states


@asynccontextmanager
async def lifespan(_: FastAPI):
    discovered = discover_model_dirs()
    for version in ALLOWED_MODEL_VERSIONS:
        model_dir = discovered.get(version)
        if model_dir is None:
            _model_errors[version] = "Nie znaleziono katalogu modelu z tą wersją."
            continue
        try:
            model = await asyncio.to_thread(load_classifier, model_dir, version)
            _models[version] = model
            _model_contracts[version] = build_model_contract(model)
        except Exception as error:
            _model_errors[version] = str(error)[:300]

    if DEFAULT_MODEL_VERSION not in _models:
        reason = _model_errors.get(DEFAULT_MODEL_VERSION, "nieznany błąd")
        raise RuntimeError(f"Nie można uruchomić modelu domyślnego: {reason}")
    yield
    _models.clear()
    _model_contracts.clear()
    _model_errors.clear()


app = FastAPI(title="CRM Inquiry Classifier", version="1.2", lifespan=lifespan)


def authorize(authorization: str | None = Header(default=None)) -> None:
    expected = f"Bearer {API_KEY}"
    if authorization is None or not secrets.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Niepoprawny klucz usługi AI.")


class ClassificationRequest(BaseModel):
    message_id: str = Field(min_length=1, max_length=200)
    model_version: str | None = Field(default=None, min_length=1, max_length=80)
    subject: str = Field(default="", max_length=2_000)
    body: str = Field(default="", max_length=200_000)
    attachments: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_request(self) -> "ClassificationRequest":
        if not self.subject.strip() and not self.body.strip():
            raise ValueError("Temat lub treść wiadomości muszą być niepuste.")
        if self.model_version and MODEL_VERSION_PATTERN.fullmatch(self.model_version) is None:
            raise ValueError("Niepoprawny format wersji modelu.")
        return self


class ClassificationResponse(BaseModel):
    message_id: str
    label: int
    classification: str
    probability: float
    threshold: float
    model_version: str
    service: str
    model_contract: dict[str, Any]


@app.get("/health", dependencies=[Depends(authorize)])
def health() -> dict[str, Any]:
    model = _models.get(DEFAULT_MODEL_VERSION)
    contract = _model_contracts.get(DEFAULT_MODEL_VERSION)
    if model is None or contract is None:
        raise HTTPException(status_code=503, detail="Model domyślny nie jest gotowy.")
    return {
        "status": "ok",
        "service": "crm-email-classifier",
        "default_model_version": DEFAULT_MODEL_VERSION,
        "model_contract": contract,
        "models": model_states(),
        "device": str(getattr(model.encoder, "device", "unknown")),
    }


@app.get("/models", dependencies=[Depends(authorize)])
def models() -> dict[str, Any]:
    return {
        "service": "crm-email-classifier",
        "default_model_version": DEFAULT_MODEL_VERSION,
        "models": model_states(),
    }


@app.post(
    "/classify-email",
    response_model=ClassificationResponse,
    dependencies=[Depends(authorize)],
)
async def classify_email(request: ClassificationRequest) -> dict[str, Any]:
    selected_version = request.model_version or DEFAULT_MODEL_VERSION
    if selected_version not in ALLOWED_MODEL_VERSIONS:
        raise HTTPException(status_code=422, detail="Ta wersja modelu nie jest dozwolona.")
    model = _models.get(selected_version)
    contract = _model_contracts.get(selected_version)
    if model is None or contract is None:
        raise HTTPException(status_code=503, detail="Wybrana wersja modelu nie jest dostępna.")

    selected_threshold = float(THRESHOLD) if THRESHOLD else None
    # Wspólna kolejka chroni pamięć GPU przed skokami przy kilku modelach.
    async with _inference_lock:
        result = await asyncio.to_thread(
            model.predict,
            subject=request.subject,
            body=request.body,
            attachments="; ".join(request.attachments),
            threshold=selected_threshold,
        )
    return {
        "message_id": request.message_id,
        **result,
        "service": "crm-email-classifier",
        "model_contract": contract,
    }
