# `@sable/sdk-contracts`

Data-only, versioned contracts exchanged by Sable's training plane, cloud
services, and Web SDK. This package intentionally contains no DOM, Node,
Playwright, networking, cryptography, or client-specific implementation.

All externally exchanged roots have an explicit `kind` and `schemaVersion`.
Callers must validate untrusted JSON with the exported runtime validators
before using it. Cryptographic signature verification is deliberately left to
the caller: structural validation does not establish authenticity.

`SignedCatalogEnvelope.signature.value` contains unpadded base64url raw
signature bytes. The signed bytes are the UTF-8 encoding of the catalog payload
serialized with RFC 8785 JSON Canonicalization Scheme. The digest covers those
same bytes.
