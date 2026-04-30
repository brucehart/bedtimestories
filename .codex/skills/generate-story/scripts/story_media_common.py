#!/usr/bin/env python3
import json
import mimetypes
import os
import pathlib
import shlex
import urllib.error
import urllib.parse
import urllib.request
import uuid

DEFAULT_SECRETS_ENV_PATH = pathlib.Path.home() / ".config" / "secrets" / "codex.env"
ENV_ALIASES = {
    "OPENAI_API_KEY": ("OPENAI_BEDTIME_STORY_KEY",),
}


def parse_env_value(raw: str) -> str:
    if not raw:
        return ""
    lexer = shlex.shlex(raw, posix=True)
    lexer.whitespace_split = True
    lexer.commenters = "#"
    parts = list(lexer)
    if not parts:
        return ""
    return " ".join(parts)


def load_default_secret_env() -> None:
    if not DEFAULT_SECRETS_ENV_PATH.exists():
        return
    try:
        lines = DEFAULT_SECRETS_ENV_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        return

    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        name, sep, raw_value = line.partition("=")
        name = name.strip()
        if not sep or not name or os.getenv(name):
            continue
        os.environ[name] = parse_env_value(raw_value.strip())


def require_env(name: str) -> str:
    load_default_secret_env()
    value = os.getenv(name, "").strip()
    if value:
        return value

    for alias in ENV_ALIASES.get(name, ()):
        alias_value = os.getenv(alias, "").strip()
        if alias_value:
            os.environ[name] = alias_value
            return alias_value

    alias_names = ENV_ALIASES.get(name, ())
    alias_hint = ""
    if alias_names:
        alias_hint = f" or one of its aliases ({', '.join(alias_names)})"

    raise SystemExit(
        f"{name} is required (export it in the current environment or set it{alias_hint} in {DEFAULT_SECRETS_ENV_PATH})."
    )


def request_json(
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    payload: dict | None = None,
    data: bytes | None = None,
) -> dict:
    if payload is not None and data is not None:
        raise ValueError("request_json accepts either payload or raw data, not both.")

    final_headers = dict(headers or {})
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        final_headers.setdefault("Content-Type", "application/json")
    final_headers.setdefault("Accept", "application/json")

    req = urllib.request.Request(url=url, method=method, headers=final_headers, data=data)
    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"API error {exc.code}: {body[:2000]}") from exc


def build_multipart_form_data(
    fields: list[tuple[str, str]],
    files: list[tuple[str, str, bytes, str]],
) -> tuple[bytes, str]:
    boundary = f"----codex-{uuid.uuid4().hex}"
    parts: list[bytes] = []

    for name, value in fields:
        parts.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"),
                value.encode("utf-8"),
                b"\r\n",
            ]
        )

    for name, filename, data, content_type in files:
        safe_filename = filename.replace('"', '\\"')
        parts.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                (
                    f'Content-Disposition: form-data; name="{name}"; '
                    f'filename="{safe_filename}"\r\n'
                ).encode("utf-8"),
                f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"),
                data,
                b"\r\n",
            ]
        )

    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def mime_type_for_path(path: str) -> str:
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


def guess_extension(
    url: str,
    headers: dict[str, str],
    default_ext: str,
    allowed_suffixes: set[str] | None = None,
) -> str:
    content_type = headers.get("Content-Type", "").split(";")[0].strip().lower()
    if content_type:
        ext = mimetypes.guess_extension(content_type)
        if ext and (not allowed_suffixes or ext in allowed_suffixes):
            return ext

    parsed = urllib.parse.urlparse(url)
    suffix = pathlib.Path(parsed.path).suffix.lower()
    if suffix and (not allowed_suffixes or suffix in allowed_suffixes):
        return suffix
    return default_ext


def download_file(
    url: str,
    prefix: str,
    default_ext: str,
    headers: dict[str, str] | None = None,
    allowed_suffixes: set[str] | None = None,
) -> str:
    req = urllib.request.Request(url=url, method="GET", headers=headers or {})
    with urllib.request.urlopen(req) as resp:
        data = resp.read()
        response_headers = {k: v for k, v in resp.headers.items()}

    ext = guess_extension(url, response_headers, default_ext, allowed_suffixes)
    output_path = f"/tmp/{prefix}-{uuid.uuid4().hex}{ext}"
    with open(output_path, "wb") as f:
        f.write(data)
    return output_path
