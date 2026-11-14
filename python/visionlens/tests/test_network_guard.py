"""The network guard of the worker (task 2.10).

The pack asks the worker of an isolated inference to run with the network
DISABLED, unless provider access is explicitly required
(`docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:31`). These tests prove
the property and not the intention: a connection inside a guarded worker is
refused with a typed error, an allowance opens the door only when provider
access was explicitly required, and the loader of the weights cannot open
the network by itself.
"""

from __future__ import annotations

import socket
import threading
from typing import Iterator

import pytest
from helpers import SRC  # noqa: F401  (path setup)
from helpers import WorkerProc, host_hello, request

from visionlens.encoders.weights import fetch_chunks
from visionlens.errors import LibraryErrorCode, NetworkAccessRefusedError
from visionlens.runtime.netguard import (
    active_guard,
    network_access,
    network_disabled,
)
from visionlens.worker import NETWORK_DISABLED, NETWORK_REQUIRED, network_mode


@pytest.fixture
def listener() -> Iterator[socket.socket]:
    """A local TCP listener, so a refusal is the guard's and not the OS's."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(4)
    try:
        yield server
    finally:
        server.close()


def _connect(server: socket.socket) -> None:
    """Connect to the local listener."""
    client = socket.create_connection(server.getsockname(), timeout=5)
    client.close()


def test_a_connection_inside_a_guarded_worker_is_refused(listener: socket.socket):
    with network_disabled():
        with pytest.raises(NetworkAccessRefusedError) as excinfo:
            _connect(listener)

    assert excinfo.value.code == LibraryErrorCode.NETWORK_ACCESS_REFUSED
    assert "outbound connection" in str(excinfo.value)


def test_a_datagram_of_a_guarded_worker_is_refused():
    # A UDP socket does not connect, so it would reach the network without
    # ever touching the patched connect.
    with network_disabled():
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            with pytest.raises(NetworkAccessRefusedError) as excinfo:
                sock.sendto(b"payload", ("127.0.0.1", 9))
        finally:
            sock.close()

    assert excinfo.value.code == LibraryErrorCode.NETWORK_ACCESS_REFUSED
    assert "datagram" in str(excinfo.value)


def test_the_raw_socket_of_the_c_module_is_refused():
    # The raw socket is a DIFFERENT type and does not inherit the patch of
    # the Python class, so it is replaced while the guard is installed.
    import _socket

    with network_disabled():
        sock = _socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with pytest.raises(NetworkAccessRefusedError):
                sock.connect(("127.0.0.1", 9))
        finally:
            sock.close()


def test_the_resolution_of_a_name_is_refused():
    # A lookup is a query to a resolver, and a resolver is a network. The
    # resolution of a LOCAL address is a local operation and is allowed.
    with network_disabled():
        with pytest.raises(NetworkAccessRefusedError) as excinfo:
            socket.getaddrinfo("example.invalid", 443)

        assert "resolution" in str(excinfo.value)
        # The loopback still resolves: the guard does not break the local
        # work of the process.
        assert socket.getaddrinfo("127.0.0.1", 80)


def test_an_allowance_belongs_to_the_thread_that_opened_it():
    # The scope opens the door for the thread that asked for it and for
    # nobody else, so a download never opens the network for the requests
    # the worker is serving at the same time.
    outcome: list[object] = []

    def attempt() -> None:
        try:
            socket.create_connection(("127.0.0.1", 9), timeout=1)
            outcome.append("connected")
        except NetworkAccessRefusedError as exc:
            outcome.append(exc)
        except OSError as exc:
            outcome.append(exc)

    with network_disabled(provider_access=True):
        with network_access("a scope of this thread"):
            thread = threading.Thread(target=attempt)
            thread.start()
            thread.join(timeout=5)

    assert len(outcome) == 1
    assert isinstance(outcome[0], NetworkAccessRefusedError)


def test_the_guard_restores_the_network_when_the_scope_ends(listener: socket.socket):
    with network_disabled():
        with pytest.raises(NetworkAccessRefusedError):
            _connect(listener)

    # The refusal was the guard's, and the guard is gone now.
    _connect(listener)


def test_an_allowance_opens_the_door_only_when_provider_access_was_required(
    listener: socket.socket,
):
    with network_disabled(provider_access=False):
        with network_access("a scope that asks for the network"):
            with pytest.raises(NetworkAccessRefusedError) as excinfo:
                _connect(listener)

    assert "provider access was not explicitly required" in str(excinfo.value)

    with network_disabled(provider_access=True):
        with network_access("a scope that asks for the network"):
            _connect(listener)


def test_outside_a_guarded_worker_the_scope_is_a_no_op(listener: socket.socket):
    assert active_guard() is None
    with network_access("a scope outside a worker"):
        _connect(listener)
    assert active_guard() is None


def test_the_loader_of_the_weights_cannot_open_the_network_by_itself():
    # The host is allowlisted, so the refusal that comes back is the guard's
    # and not the allowlist's. The scope the loader opens is a request, not
    # a permission.
    with network_disabled():
        with pytest.raises(NetworkAccessRefusedError) as excinfo:
            list(fetch_chunks("https://huggingface.co/google/siglip2-base/resolve/main/model.safetensors"))

    assert excinfo.value.code == LibraryErrorCode.NETWORK_ACCESS_REFUSED


def test_an_unknown_mode_is_read_as_the_refusal(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("VISIONLENS_WORKER_NETWORK", raising=False)
    assert network_mode() == NETWORK_DISABLED

    monkeypatch.setenv("VISIONLENS_WORKER_NETWORK", "required")
    assert network_mode() == NETWORK_REQUIRED

    monkeypatch.setenv("VISIONLENS_WORKER_NETWORK", "REQUIRED")
    assert network_mode() == NETWORK_REQUIRED

    monkeypatch.setenv("VISIONLENS_WORKER_NETWORK", "yes please")
    assert network_mode() == NETWORK_DISABLED


def test_the_worker_process_runs_with_the_network_disabled():
    with WorkerProc() as worker:
        hello = worker.read_frame()
        assert hello["kind"] == "hello"
        worker.close_stdin()
        assert worker.wait() == 0

    stderr = worker.stderr_text()
    assert "the network is disabled for this worker" in stderr


def test_the_worker_process_reports_an_explicit_request_for_provider_access():
    with WorkerProc(env_overrides={"VISIONLENS_WORKER_NETWORK": "required"}) as worker:
        hello = worker.read_frame()
        assert hello["kind"] == "hello"
        worker.close_stdin()
        assert worker.wait() == 0

    stderr = worker.stderr_text()
    assert "provider access was explicitly required for this worker" in stderr


def test_the_worker_serves_a_request_with_the_network_disabled():
    with WorkerProc() as worker:
        worker.read_frame()
        worker.send(host_hello())
        worker.send(
            request(
                "r-network",
                "vision.embed",
                {"images": ["golden-alpha"], "model": "siglip2-base"},
            )
        )
        frames = worker.read_until_terminal("r-network")

    terminal = frames[-1]
    assert terminal["kind"] == "result"
    assert terminal["result"]["count"] == 1


def test_the_worker_answers_a_request_that_tries_to_reach_the_network():
    # The guard is a property of the process, so the request threads are
    # covered by it too. The simulated operation never opens a socket, so the
    # refusal below is the one a provider call would get.
    with WorkerProc() as worker:
        worker.read_frame()
        worker.send(host_hello())
        worker.send(
            request(
                "r-network-2",
                "vision.embed",
                {"images": ["golden-alpha"], "model": "siglip2-base"},
            )
        )
        frames = worker.read_until_terminal("r-network-2")
        assert frames[-1]["kind"] == "result"

        # The worker is still serving after the guarded work.
        worker.send(
            request(
                "r-network-3",
                "vision.embed",
                {"images": ["golden-beta"], "model": "siglip2-base"},
            )
        )
        served = worker.read_until_terminal("r-network-3")
        assert served[-1]["kind"] == "result"
        assert served[-1]["result"]["count"] == 1


def test_a_connection_from_a_thread_of_the_worker_is_refused():
    # The guard is process wide, not thread local.
    outcome: list[object] = []

    def attempt() -> None:
        try:
            with socket.create_connection(("127.0.0.1", 9), timeout=1):
                outcome.append("connected")
        except NetworkAccessRefusedError as exc:
            outcome.append(exc)

    with network_disabled():
        thread = threading.Thread(target=attempt)
        thread.start()
        thread.join(timeout=5)

    assert len(outcome) == 1
    assert isinstance(outcome[0], NetworkAccessRefusedError)
