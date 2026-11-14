# The CPU vision adapter

One encoder, one operation, one device. The adapter decodes an image,
preprocesses it with the canonical spec, embeds it on the CPU and
writes the vectors into a content-addressed artifact. The TypeScript
side validates the manifest and commits the derived artifact; the
Python side writes no domain row.

The record of the verification of this adapter is
`docs/architecture/vision-adapter-verification.md`: every gate, with the
exact command, the environment, the git SHA, the exit code and the
output, and the list of what the ticket did NOT prove.

## The pipeline

```text
asset path
  -> resolve inside the approved root        (io/decode.py)
  -> magic bytes vs the name of the file     (io/decode.py)
  -> the type the platform accepts           (io/decode.py)
  -> the file is complete                    (io/decode.py)
  -> the declared size is inside the caps    (io/decode.py)
  -> the pixels                             (io/decode.py)
  -> the pixels in the layout of the model   (io/preprocess.py)
  -> the batch                               (inference/batching.py)
  -> the model                               (encoders/siglip2.py)
  -> the vectors on disk                     (inference/artifact.py)
  -> the manifest                            (inference/artifact.py)
```

Every step that produces a value has a fingerprint, and two runs with
different preprocessing cannot be compared as equivalent
(`docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:23`). The
preprocessing fingerprint of the run is the one the registry record
carries: the adapter refuses a preprocessing that is not the record's
one.

## The refusals, in the order they happen

The order is the property. A refusal that arrives after the pixels were
allocated has already cost the memory it was trying to take, and a
refusal that arrives after the bytes were fetched is not a refusal.

| step | what it refuses |
|---|---|
| the root | a path that resolves outside the approved root, and a symlink that escapes it |
| the magic bytes | a file whose bytes are not the type its name claims |
| the allowlist | a type the platform does not accept (the list of `packages/core/src/utils/mime.ts:9`) |
| the completeness | a truncated JPEG and a truncated PNG, before a decoder spends its budget |
| the caps | a declared size over 20000 pixels a side or over 100 million pixels, read from the header before the pixels exist |
| the bytes | a file that is not an image, a file too short to carry the header its type needs, and a metadata that cannot be read |
| the memory | a batch that does not fit, retried with fewer images a bounded number of times |

The caps are the ones the dataset inspector already had
(`python/visionlens/src/visionlens/data/inspect.py`), and so is the
parser of the headers: one implementation reads the dimensions of every
format.

The values that reach the model are channels first: the whole red plane,
then the whole green plane, then the whole blue plane. The layout is
part of the contract of the model, and a run that lays the pixels out
the other way embeds a scrambled image and still returns a vector. The
preprocessing test compares the values with the ones the reference
processor of the model produces, and the recorded difference is 2.57e-08.

## The artifact

The vectors of a run are a binary file beside a manifest, under
`artifacts/<kind>/<run-id>/`
(`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:35`). The vectors never
travel inside a JSON line and the manifest never carries a base64
payload (`docs/vnext/specs/VLN-005-python-cpu-vision-adapter.md:14`).

The manifest carries every field of FR-011, and a value that does not
exist is `unknown` and never `0`
(`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:24`). The artifact digest
is the address of the CONTENT of the artifact: the model, the revision,
the preprocessing, the snapshot, the assets, the shape and the digest of
the vectors. The run id, the timestamp, the latency, the peak memory,
the runtime versions and the device describe the run and not the
content, so two runs of the same content share the address. The vectors
file digest is the digest of the bytes that were written, and the reader
of an artifact refuses a manifest whose vectors do not hash to the digest
it names.

The manifest schema is generated from the Zod schema the TypeScript
side validates with
(`packages/core/src/adapter/embedding-manifest.ts`), and the generated
file is committed, so the Python side and the TypeScript side validate
against the same contract.

## The network and the text of an image

The pack puts two conditions on the worker of an isolated inference: the
network is DISABLED unless provider access is explicitly required, and the
text of an image is DATA and never an instruction
(`docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:31`).

The network is a property of the PROCESS, not of a function. The guard
patches the socket layer while it is installed and restores it when it is
removed, so it covers the threads that serve the requests too
(`python/visionlens/src/visionlens/runtime/netguard.py:98`). It refuses
every connection, every outbound datagram and the resolution of any name
that is not local, on the Python socket class and on the raw socket of the
C module, and every refusal is the typed error `NETWORK_ACCESS_REFUSED`.
Two gates stand between the worker and the network:

- the MODE of the worker: provider access has to be explicitly required
  for this worker, and the default says it was not
  (`python/visionlens/src/visionlens/worker.py:43`). The mode is read
  from `VISIONLENS_WORKER_NETWORK`, and an unrecognised value is read as
  the refusal, because an unknown request for the network is not a request
  for the network;
- the SCOPE: even a worker that requires provider access reaches the
  network only inside an explicit allowance, and only for as long as the
  scope lasts
  (`python/visionlens/src/visionlens/runtime/netguard.py:363`). The
  allowance belongs to the THREAD that opened it, so a scope never opens
  the door for the other threads of the worker, and the reason of the open
  scope is logged and named in the message of a refusal.

The limits of the guard are declared and not glossed over: it is a
defense IN PROCESS. It does not reach a SUBPROCESS that EXECS, because an
exec replaces the patched process with a new one, and a new one answers
for itself. A FORK is another matter: it inherits the patched socket
layer, so the child refuses the network too, and it starts with no
allowance of its own, because the allowance of the thread that forked is
not the allowance of the child. The guard also does not reach a RAW
socket of the C module that was created before it was installed; a socket
of the Python class that was created before is refused, because the patch
lives on the class and the class is looked up at the moment of the call.
The isolation of a worker that must not reach the network is the sandbox
that runs it, and the guard is the defense inside that sandbox.

The loader of the weights opens that scope around its fetch
(`python/visionlens/src/visionlens/encoders/weights.py:735`), and the
scope is a request and not a permission: in a worker that did not require
provider access, the fetch is refused by the guard even though the loader
asked for it. The gates of the loader (the permission, the license, the
source, the pinned revision and the digest) stand above the scope, and
they are what decides WHAT may be fetched.

The text of an image is data because the model never reads text. The
input of the model is a tensor of numbers, and the boundary refuses
anything that is not a number with the typed error `NON_NUMERIC_PIXEL`
(`python/visionlens/src/visionlens/io/preprocess.py:51`). The decoder
reads one tag of the EXIF, the orientation, and extracts no text at all:
the pixels of a file that carries an instruction in its metadata are the
same pixels as the pixels of a file that carries none, and the digest of
the preprocessed values is the same for both
(`python/visionlens/tests/test_image_text_is_data.py`). The decoder also
DROPS the metadata of the picture it returns, so the text of the file
does not travel with the pixels at all. This ticket does no OCR, so no
text is extracted, and what is not extracted cannot be obeyed.

## The bridge and the typed result of the operation

The wire contract freezes the FRAMES and the operation codes, and it leaves
the payload of a result to the operation: the result is free-form JSON but
it must be stable per operation
(`packages/contracts/src/worker/event.ts`). The bridge is where that
stability is written down
(`packages/core/src/worker/operations.ts:534`): for every operation it
names the code, the params it sends, the typed success it accepts and the
typed error it reports.

The repository carries TWO shapes of the result of `vision.embed`, and both
are tracked:

| shape | who answers | what it carries |
|---|---|---|
| the recorded one | the adapter of this ticket | the run id, the count, the dimension, the dtype, the digest of the artifact and the error samples; the vectors are on disk |
| the simulated one | the deterministic runtime of the frozen protocol | the model, the dimension, the dtype, the count, the vectors, the digest, the preprocessing fingerprint and the device |

The pack's own example carries the recorded shape
(`docs/vnext/contracts/proposed/examples/worker-result.example.json` and
`packages/contracts/tests/fixtures/worker/result.golden.json`), and the
golden transcript of the Python package pins the simulated one byte for
byte. The bridge accepts both and NAMES which one answered, so a caller
can never mistake a simulated vector for a recorded run, and a payload that
is neither is a refusal and not a guess.

The typed error carries the frozen code, the message and the retryable
flag: the frozen flag of the code, read from the frozen table and never
guessed, for a failure the worker reported, and the flag the HOST itself
uses for a failure of the CHANNEL, because the host is the one that
decides whether to retry (`packages/core/src/worker/operations.ts:456`). A
failure of the channel is reported with the code that names it, because the
frozen vocabulary has no other code for it and the bridge never invents
one.

The validators of the bridge are written by hand instead of with Zod,
because the owner boundary of `packages/core/src/worker/` allows the Node
stdlib, the contracts package, that directory and `packages/core/src/utils/`,
and nothing else. A boundary that is widened for a convenience is a
boundary that is not enforced.

## The failure matrix

Every failure of the adapter is ONE typed refusal, the process stays
alive, and no failure publishes a partial artifact as a success
(`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:26`). The matrix below is
that promise, one row at a time, and every row has a test
(`python/visionlens/tests/test_failure_modes.py`).

| what fails | what is refused | the code |
|---|---|---|
| the path | a traversal and a symlink that escapes the approved root | `PATH_OUTSIDE_ROOT` |
| the magic bytes | a file whose bytes contradict the name of the file | `MIME_MISMATCH` |
| the completeness | a truncated JPEG and a truncated PNG | `IMAGE_METADATA_UNREADABLE` |
| the caps | a declared size over the caps, read before the pixels exist | `IMAGE_DIMENSIONS_EXCEEDED` |
| the weights | a download that nobody permitted | `PERMISSION_MISSING` |
| the digest | bytes that carry another digest, and the refusal names both | `DIGEST_MISMATCH` |
| the format | a `.pt` or a pickled checkpoint | `UNSAFE_FORMAT` |
| the device | an accelerator this build does not run | `UNSUPPORTED_DEVICE` |
| the memory | a batch that never fits, after a bounded back off | `RESOURCE_EXHAUSTED` |
| the run | a run in which EVERY image was refused | `EMBEDDING_RUN_EMPTY` |

The last row is the one that changed the behavior of the adapter on
2026-11-14. A run in which every image was refused used to write an empty
artifact and answer with a success that carried no vector. A run that
embedded nothing is not a run: it fails with ONE typed error, which
carries the samples of the refusals, and it writes nothing. The mixed case
is unchanged and is the one the pack asks for: an image that cannot be
decoded is an error sample, the other images still embed, and the error
names the file
(`docs/vnext/specs/VLN-005-python-cpu-vision-adapter.md:14`).

The codes of the matrix are the LIBRARY vocabulary and never the frozen
wire one. The ten wire codes stay exactly the ten they were, and a
library code never crosses the wire.

The rows that go through the library assert a typed error of that
vocabulary. The rows that go through the loader (the permission, the
digest and the format) assert the REASON of the refusal, which is the
code of the gate that refused: `DownloadRefusedError` carries a code of
its own and a reason, and the reason is the gate that said no.

## The golden parity gate

One golden file, read by both languages, and a gate that compares three
tiers and exits non-zero when any of them diverges:

```bash
pnpm exec tsx scripts/benchmarks/vision-parity.ts
```

| tier | what it compares |
|---|---|
| the config fingerprint | the live TypeScript `fingerprintV2` and the one the golden file names |
| the manifest | the manifest of the committed artifact against the ratified schema, and its IDENTITY against the golden set: the model, the revision, the source, the digest of the weights, the preprocessing and its fingerprint, the snapshot, the count, the dimension and the digests of the assets, in order |
| the vectors | every golden vector against the artifact, inside the documented tolerance |

The golden file is committed, and so is the artifact of the run that
produced it, so the gate runs on a machine that cannot run the model.
The gate never writes the golden file.

Two digests guard the golden file, and they guard different things. The
digest of the set covers the name, the file digest and the float32 bytes
of every vector, and the bytes of a float32 are the same in both
languages. The digest of the CONTENT covers everything the file asserts,
the tolerance included, and it is PINNED IN THE CODE: a digest that
travels with the file it protects proves nothing, because whoever edits
the file edits the digest too. A change to the golden set is therefore a
change to the pin, and that change is a visible diff in the code.

The tolerance is measured, not guessed. The same images embedded in one
batch and one image at a time differ by at most 1.383e-05 with a cosine
similarity of 1.000000000, and the golden file carries that measurement
and the reason. It is inside the digest of the content, so widening it is
a visible diff and not an edit nobody sees.

The two validators refuse the same payloads: the schema is strict on both
sides, a pattern is matched against the whole value, an integer is a
number with no fractional part, and a source is a URL with a scheme and a
host. The parity tests on both sides prove it field by field.

The fingerprint of the configuration is byte-identical on both sides:
the TypeScript side sorts the object keys by their UTF-16 code units
and writes the numbers the way JavaScript writes them, and the Python
side does the same in one implementation
(`python/visionlens/src/visionlens/runtime/fingerprint.py`).

## The recorded run

The real model, the real weights, the committed fixtures, on the CPU of
a Mac M2 (macOS Darwin 25.6.0 arm64, Python 3.14.6, Pillow 13.0.0,
torch 2.15.0, transformers 4.57.6):

```text
count 6, dimension 768, dtype float32, device cpu, no errors, no fallbacks
p50 543 ms per image, 3.3 s for the six
peak resident memory 822 MiB
vectors file 18432 bytes
vectors file digest 0859460709829bae5db526776df2dbfcc96492055b3134a2da4f2793aa8445a8
artifact digest 4f706336517e10f7194963241c623af1d5039f4fc74fb3bc9c7479bfeaaf586a
config fingerprint fp2:a81b8074dbee1eb8
```

The vectors file digest is the same in every run: the vectors are
reproducible. The artifact digest is the same too, and that is the point
of a content address: two runs of the same images carry a different run
id, a different timestamp, a different latency and a different peak
memory, and they still share the address of their content. The command
that produced it is `python/visionlens/scripts/generate_golden.py`, and
the tolerance of the golden file comes from the difference between the
batched run and the one-image-at-a-time run of the same images.

## What this does NOT prove

- The platform has run the model on a **GPU**: this ticket is the CPU
  reference path, the device planner admits the CPU only and refuses an
  accelerator this build does not run, and the run above is the CPU.
- The embeddings are **calibrated**: the record says `uncalibrated`,
  and no calibrator was fitted. The similarities of the model are not
  probabilities.
- The golden vectors are a **golden comparison of the manifest and the
  fingerprint**, not a two-language encoder comparison: the TypeScript
  side of this platform embeds TEXT, not images. The encoder of this
  ticket is the Python one, and the golden file pins what it produced.
- The `latencyCostProfile` of the record is still `unknown`: the run
  above measured a latency, and the record was not rewritten with it.
