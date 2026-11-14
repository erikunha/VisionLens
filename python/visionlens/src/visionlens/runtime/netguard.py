"""The network guard of the inference worker.

The pack asks the worker of an isolated inference to run with the
network DISABLED, unless provider access is explicitly required
(`docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:31`). A worker that
can reach the network can be turned into a client of anything that
answers, so the default is the refusal and the exception is explicit.

The guard is a property of the PROCESS, not of a function: it patches the
socket layer while it is installed and restores it when it is removed.
Every connection attempt is refused with a typed error, and an
allowance opens the door for the duration of one explicit scope, which
is how the loader of the weights reaches the repository it was
explicitly permitted to reach.

Two gates stand between a worker and the network, and both are closed
by default:

  - the mode of the worker: provider access has to be EXPLICITLY
    required for this worker, and the default says it was not;
  - the scope: even a worker that requires provider access reaches the
    network only inside an explicit allowance, and only for as long as
    the scope lasts.

Nothing here decides WHAT may be fetched. That decision belongs to the
gates of the loader: the license, the permission, the allowlist, the
pinned revision and the digest. The guard only makes sure that the
process reaches the network through one of those gates and not around
them.
"""

from __future__ import annotations

import socket
import threading
from contextlib import contextmanager
from typing import Any, Iterator, Optional

from ..errors import NetworkAccessRefusedError


class NetworkGuard:
    """Refuses every outbound connection while it is installed.

    The guard counts its allowances: an allowance is an explicit,
    scoped permission, and the connection is refused while there is
    none. An allowance opens the door only when provider access was
    explicitly required for this worker.
    """

    def __init__(self, provider_access: bool = False) -> None:
        self._provider_access = provider_access
        self._allowances = 0
        self._lock = threading.Lock()
        self._installed = False

    @property
    def installed(self) -> bool:
        """Whether the guard is currently refusing the network."""
        return self._installed

    @property
    def provider_access(self) -> bool:
        """Whether provider access was explicitly required for this worker."""
        return self._provider_access

    def allows_network(self) -> bool:
        """Whether a connection is allowed right now."""
        with self._lock:
            return self._provider_access and self._allowances > 0

    @contextmanager
    def allowance(self, reason: str) -> Iterator[None]:
        """Open the network for the duration of one explicit scope.

        The reason travels with the allowance, so a log that names the
        scope says WHY the network was open. The scope does not open the
        door by itself: a worker that did not require provider access
        refuses the connection inside the scope too.
        """
        with self._lock:
            self._allowances += 1
        try:
            yield
        finally:
            with self._lock:
                self._allowances -= 1

    def _check(self, what: str) -> None:
        if not self._provider_access:
            raise NetworkAccessRefusedError(
                "the worker has no network access because provider access was "
                "not explicitly required for it, and " + what + " was refused"
            )
        if not self.allows_network():
            raise NetworkAccessRefusedError(
                "the worker has no network access, and " + what + " was refused"
            )

    @contextmanager
    def install(self) -> Iterator[None]:
        """Refuse the network for the duration of the scope."""
        original_connect = socket.socket.connect
        original_connect_ex = socket.socket.connect_ex
        original_create_connection = socket.create_connection
        guard = self

        def guarded_connect(sock: Any, address: Any) -> Any:
            guard._check("an outbound connection")
            return original_connect(sock, address)

        def guarded_connect_ex(sock: Any, address: Any) -> Any:
            guard._check("an outbound connection")
            return original_connect_ex(sock, address)

        def guarded_create_connection(*args: Any, **kwargs: Any) -> Any:
            guard._check("an outbound connection")
            return original_create_connection(*args, **kwargs)

        socket.socket.connect = guarded_connect  # type: ignore[method-assign]
        socket.socket.connect_ex = guarded_connect_ex  # type: ignore[method-assign]
        socket.create_connection = guarded_create_connection
        self._installed = True
        try:
            yield
        finally:
            socket.socket.connect = original_connect  # type: ignore[method-assign]
            socket.socket.connect_ex = original_connect_ex  # type: ignore[method-assign]
            socket.create_connection = original_create_connection
            self._installed = False


#: The guard of the process, when one is installed.
_ACTIVE: Optional[NetworkGuard] = None


def active_guard() -> Optional[NetworkGuard]:
    """The guard that is installed right now, if any."""
    return _ACTIVE


@contextmanager
def network_access(reason: str) -> Iterator[None]:
    """Open the network for one explicit scope, when a guard is installed.

    Outside a worker the network is not guarded, so the scope is a
    no-op: the library used as a library reaches the network the way the
    caller asked it to. Inside a worker the scope is a request, not a
    permission: the door opens only when provider access was explicitly
    required for this worker.
    """
    guard = _ACTIVE
    if guard is None:
        yield
        return
    with guard.allowance(reason):
        yield


@contextmanager
def network_disabled(provider_access: bool = False) -> Iterator[NetworkGuard]:
    """Run a scope with the network disabled.

    The guard is the one of the process for the duration of the scope,
    so the loader of the weights opens its allowance inside it. Provider
    access is not required by default: the guard refuses every
    connection, allowances included, until the worker says it requires
    provider access.
    """
    global _ACTIVE
    guard = NetworkGuard(provider_access=provider_access)
    previous = _ACTIVE
    _ACTIVE = guard
    try:
        with guard.install():
            yield guard
    finally:
        _ACTIVE = previous
