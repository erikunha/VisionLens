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
    the scope lasts. An allowance belongs to the THREAD that opened it,
    so a scope never opens the door for the other threads of the worker.

WHAT THE GUARD COVERS, AND WHAT IT DOES NOT

It refuses, inside this process:

  - every connection of the Python socket class (`connect`, `connect_ex`)
    and every datagram it sends (`sendto`, `sendmsg`);
  - every connection of the RAW socket of the C module, which is a
    different type and does not inherit the patch of the Python one;
  - the creation of a connection through `socket.create_connection`;
  - the RESOLUTION of a name that is not a local address, because a
    lookup is a query to a resolver and a resolver is a network.

It does NOT reach:

  - a CHILD PROCESS. A fork or a subprocess leaves the patched process
    and answers for itself. The isolation of a worker that must not
    reach the network is the sandbox that runs it, and the guard is the
    in-process defense inside that sandbox;
  - a socket object that was created BEFORE the guard was installed.

Nothing here decides WHAT may be fetched. That decision belongs to the
gates of the loader: the license, the permission, the allowlist, the
pinned revision and the digest. The guard only makes sure that the
process reaches the network through one of those gates and not around
them.
"""

from __future__ import annotations

import _socket
import logging
import os
import socket
import threading
from contextlib import contextmanager
from typing import Any, Iterator, Optional

from ..errors import NetworkAccessRefusedError

LOG = logging.getLogger("visionlens.netguard")

#: The hosts whose resolution is local and is therefore allowed.
LOCAL_HOSTS = frozenset({"localhost", "localhost.localdomain", "", "0.0.0.0", "::", "::1"})


def _is_local_host(host: Any) -> bool:
    """Whether a host names the machine itself.

    A literal address is local by definition, and the loopback names are
    local too. Everything else is a name a resolver has to look up, and a
    lookup is a network operation.
    """
    if not isinstance(host, str):
        return False
    if host.lower() in LOCAL_HOSTS:
        return True
    try:
        import ipaddress

        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


class NetworkGuard:
    """Refuses every outbound connection while it is installed.

    The guard counts its allowances PER THREAD: an allowance is an
    explicit, scoped permission of the thread that asked for it, and the
    connection is refused while there is none. An allowance opens the
    door only when provider access was explicitly required for this
    worker.
    """

    def __init__(self, provider_access: bool = False) -> None:
        self._provider_access = provider_access
        self._state = threading.local()
        self._lock = threading.Lock()
        self._installed = False
        self._reasons: list[str] = []

    @property
    def installed(self) -> bool:
        """Whether the guard is currently refusing the network."""
        return self._installed

    @property
    def provider_access(self) -> bool:
        """Whether provider access was explicitly required for this worker."""
        return self._provider_access

    def allows_network(self) -> bool:
        """Whether a connection is allowed right now, for this thread."""
        return self._provider_access and self._allowances() > 0

    def _allowances(self) -> int:
        """The number of allowances the calling thread holds."""
        return int(getattr(self._state, "allowances", 0))

    def open_reasons(self) -> tuple[str, ...]:
        """The reasons of the scopes that are open, in the whole process."""
        with self._lock:
            return tuple(self._reasons)

    @contextmanager
    def allowance(self, reason: str) -> Iterator[None]:
        """Open the network for the duration of one explicit scope.

        The reason travels with the allowance, and it is logged when the
        scope opens, so a log that names the scope says WHY the network
        was open. The scope does not open the door by itself: a worker
        that did not require provider access refuses the connection
        inside the scope too.
        """
        depth = self._allowances()
        self._state.allowances = depth + 1
        with self._lock:
            self._reasons.append(reason)
        LOG.info("the network is open for one scope: %s", reason)
        try:
            yield
        finally:
            self._state.allowances = depth
            with self._lock:
                for index in range(len(self._reasons) - 1, -1, -1):
                    if self._reasons[index] == reason:
                        del self._reasons[index]
                        break

    def _check(self, what: str) -> None:
        """Refuse an outbound operation, with the reason of the refusal."""
        if not self._provider_access:
            raise NetworkAccessRefusedError(
                "the worker has no network access because provider access was "
                "not explicitly required for it, and " + what + " was refused"
            )
        if not self.allows_network():
            raise NetworkAccessRefusedError(
                "the worker has no network access, and " + what + " was refused"
                + self._open_reason_suffix()
            )

    def _open_reason_suffix(self) -> str:
        """The open scopes, named in the message of a refusal."""
        reasons = self.open_reasons()
        if not reasons:
            return ""
        return " (the open scope: " + "; ".join(reasons) + ")"

    @contextmanager
    def install(self) -> Iterator[None]:
        """Refuse the network for the duration of the scope."""
        undo = self._apply_patch()
        self._installed = True
        try:
            yield
        finally:
            undo()
            self._installed = False

    def _apply_patch(self) -> Any:
        """Patch the socket layer, and return the undo of the patch.

        The patch is applied INSIDE the scope that restores it, so a
        failure in the middle of it leaves the process with a guard that
        is not installed and not half installed.
        """
        guard = self

        def guarded_connect(sock: Any, address: Any) -> Any:
            guard._check("an outbound connection")
            return original_connect(sock, address)

        def guarded_connect_ex(sock: Any, address: Any) -> Any:
            guard._check("an outbound connection")
            return original_connect_ex(sock, address)

        def guarded_sendto(sock: Any, *args: Any, **kwargs: Any) -> Any:
            guard._check("an outbound datagram")
            return original_sendto(sock, *args, **kwargs)

        def guarded_sendmsg(sock: Any, *args: Any, **kwargs: Any) -> Any:
            guard._check("an outbound datagram")
            return original_sendmsg(sock, *args, **kwargs)

        def guarded_create_connection(*args: Any, **kwargs: Any) -> Any:
            guard._check("an outbound connection")
            return original_create_connection(*args, **kwargs)

        def guarded_getaddrinfo(host: Any, port: Any, *args: Any, **kwargs: Any) -> Any:
            if not _is_local_host(host):
                guard._check("the resolution of the name " + repr(host))
            return original_getaddrinfo(host, port, *args, **kwargs)

        def guarded_gethostbyname(host: Any, *args: Any, **kwargs: Any) -> Any:
            guard._check("the resolution of the name " + repr(host))
            return original_gethostbyname(host, *args, **kwargs)

        def guarded_gethostbyname_ex(host: Any, *args: Any, **kwargs: Any) -> Any:
            guard._check("the resolution of the name " + repr(host))
            return original_gethostbyname_ex(host, *args, **kwargs)

        def guarded_getnameinfo(sock: Any, *args: Any, **kwargs: Any) -> Any:
            guard._check("the resolution of a name")
            return original_getnameinfo(sock, *args, **kwargs)

        original_connect = socket.socket.connect
        original_connect_ex = socket.socket.connect_ex
        original_sendto = socket.socket.sendto
        original_sendmsg = socket.socket.sendmsg
        original_create_connection = socket.create_connection
        original_getaddrinfo = socket.getaddrinfo
        original_gethostbyname = socket.gethostbyname
        original_gethostbyname_ex = socket.gethostbyname_ex
        original_getnameinfo = socket.getnameinfo
        original_raw_socket = _socket.socket

        socket.socket.connect = guarded_connect  # type: ignore[method-assign]
        socket.socket.connect_ex = guarded_connect_ex  # type: ignore[method-assign]
        socket.socket.sendto = guarded_sendto  # type: ignore[method-assign]
        socket.socket.sendmsg = guarded_sendmsg  # type: ignore[method-assign]
        socket.create_connection = guarded_create_connection
        socket.getaddrinfo = guarded_getaddrinfo
        socket.gethostbyname = guarded_gethostbyname
        socket.gethostbyname_ex = guarded_gethostbyname_ex
        socket.getnameinfo = guarded_getnameinfo
        # The raw socket of the C module is a DIFFERENT type, and it does
        # not inherit the patch of the Python class. It is replaced by a
        # subclass that refuses the same four operations.
        _socket.socket = _RefusingSocket  # type: ignore[misc]

        def undo() -> None:
            socket.socket.connect = original_connect  # type: ignore[method-assign]
            socket.socket.connect_ex = original_connect_ex  # type: ignore[method-assign]
            socket.socket.sendto = original_sendto  # type: ignore[method-assign]
            socket.socket.sendmsg = original_sendmsg  # type: ignore[method-assign]
            socket.create_connection = original_create_connection
            socket.getaddrinfo = original_getaddrinfo
            socket.gethostbyname = original_gethostbyname
            socket.gethostbyname_ex = original_gethostbyname_ex
            socket.getnameinfo = original_getnameinfo
            _socket.socket = original_raw_socket  # type: ignore[misc]

        return undo

    def after_fork_in_child(self) -> None:
        """Reset the state of the guard in the child of a fork.

        The patch is inherited by the child, so the child refuses the
        network too, but the allowance of the thread that forked is not
        the allowance of the child: the child starts with none. The lock
        is replaced too, because a lock held by another thread at the
        moment of the fork stays held in the child forever.
        """
        self._state = threading.local()
        self._lock = threading.Lock()
        self._reasons = []


class _RefusingSocket(_socket.socket):
    """The raw socket of the C module, with its outbound calls refused.

    The C type cannot be patched, so it is REPLACED by this subclass while
    the guard is installed. The subclass refuses the same four operations
    the Python class refuses, and it is the type the C module hands out
    from then on.
    """

    def connect(self, *args: Any, **kwargs: Any) -> Any:
        raise NetworkAccessRefusedError(
            "the worker has no network access, and an outbound connection was refused"
        )

    def connect_ex(self, *args: Any, **kwargs: Any) -> Any:
        raise NetworkAccessRefusedError(
            "the worker has no network access, and an outbound connection was refused"
        )

    def sendto(self, *args: Any, **kwargs: Any) -> Any:
        raise NetworkAccessRefusedError(
            "the worker has no network access, and an outbound datagram was refused"
        )

    def sendmsg(self, *args: Any, **kwargs: Any) -> Any:
        raise NetworkAccessRefusedError(
            "the worker has no network access, and an outbound datagram was refused"
        )


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
    required for this worker, and only for the thread that asked.
    """
    guard = _ACTIVE
    if guard is None:
        yield
        return
    with guard.allowance(reason):
        yield


@contextmanager
def network_disabled(
    provider_access: bool = False, restore: bool = True
) -> Iterator[NetworkGuard]:
    """Run a scope with the network disabled.

    The guard is the one of the process for the duration of the scope,
    so the loader of the weights opens its allowance inside it. Provider
    access is not required by default: the guard refuses every
    connection, allowances included, until the worker says it requires
    provider access.

    `restore` is False for the worker of a process that is about to end:
    the guard then stays installed until the process is gone, so a thread
    that outlived the shutdown cannot reach the network afterwards.
    """
    global _ACTIVE
    guard = NetworkGuard(provider_access=provider_access)
    previous = _ACTIVE
    _ACTIVE = guard
    # A fork inherits the patch and nothing else: the child of a fork
    # starts with no allowance and with a lock of its own.
    os.register_at_fork(after_in_child=guard.after_fork_in_child)
    try:
        with guard.install():
            yield guard
    finally:
        if restore:
            _ACTIVE = previous
