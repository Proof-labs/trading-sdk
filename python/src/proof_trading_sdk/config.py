from __future__ import annotations

import os
import tomllib as toml
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class SdkConfig:
    """Layered SDK configuration.

    Sources (higher priority overrides lower):
    1. Built-in defaults
    2. Environment variables (``PROOF_*``)
    3. Config file (``~/.proof/config.toml``)
    4. Programmatic overrides
    """

    gateway_url: str = "http://localhost:1317"
    api_key: str = ""
    timeout_secs: int = 30
    log_level: str = "WARNING"
    ws_url: str = ""

    _programmatic_overrides: dict[str, object] = field(default_factory=dict, repr=False)

    @classmethod
    def from_env(cls) -> SdkConfig:
        """Load config from built-in defaults + env vars."""
        return cls(
            gateway_url=os.environ.get("PROOF_GATEWAY_URL", "http://localhost:1317"),
            api_key=os.environ.get("PROOF_API_KEY", ""),
            timeout_secs=int(os.environ.get("PROOF_TIMEOUT_SECS", "30")),
            log_level=os.environ.get("PROOF_LOG_LEVEL", "WARNING"),
            ws_url=os.environ.get("PROOF_WS_URL", ""),
        )

    @classmethod
    def from_file(cls, path: Optional[Path] = None) -> SdkConfig:
        """Load config from a TOML file, falling back to env config."""
        cfg = cls.from_env()
        search = path or Path.home() / ".proof" / "config.toml"
        if not search.exists():
            return cfg
        with open(search, "rb") as f:
            data = toml.load(f)
        section = data.get("sdk", data)
        cfg.gateway_url = str(section.get("gateway_url", cfg.gateway_url))
        cfg.api_key = str(section.get("api_key", cfg.api_key))
        cfg.timeout_secs = int(section.get("timeout_secs", cfg.timeout_secs))
        cfg.log_level = str(section.get("log_level", cfg.log_level))
        cfg.ws_url = str(section.get("ws_url", cfg.ws_url))
        return cfg

    def with_overrides(self, **kwargs: object) -> SdkConfig:
        """Return a new config with programmatic overrides applied."""
        cfg = SdkConfig(
            gateway_url=kwargs.get("gateway_url", self.gateway_url),  # type: ignore[arg-type]
            api_key=kwargs.get("api_key", self.api_key),  # type: ignore[arg-type]
            timeout_secs=int(kwargs.get("timeout_secs", self.timeout_secs)),  # type: ignore[arg-type]
            log_level=str(kwargs.get("log_level", self.log_level)),  # type: ignore[arg-type]
            ws_url=str(kwargs.get("ws_url", self.ws_url)),  # type: ignore[arg-type]
        )
        return cfg


def load_config(
    config_path: Optional[Path] = None,
    **overrides: object,
) -> SdkConfig:
    """Load SDK config using the layered convention.

    Priority (highest last):
    1. Built-in defaults
    2. Environment variables (``PROOF_*``)
    3. TOML config file
    4. Programmatic ``**overrides``

    Args:
        config_path: Path to a TOML config file (defaults to
            ``~/.proof/config.toml``).
        **overrides: Key-value pairs that override any source.

    Returns:
        Resolved :class:`SdkConfig`.
    """
    cfg = SdkConfig.from_file(config_path)
    return cfg.with_overrides(**overrides)
