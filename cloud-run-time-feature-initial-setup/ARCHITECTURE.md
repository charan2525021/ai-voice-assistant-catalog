# Architecture and change map

## Before

The original spoken demo used a browser page for the microphone, a Python Sarvam server for transcription, a Node reasoning server, and `LiveBox` plus Playwright to control a second Chromium browser. That second browser was streamed back to the user. Speech output was returned as base64 and played by the demo page.

The newer Web SDK already changed the action side: it loaded a signed catalog, observed the real product page with privacy filtering, accepted only high-level journey IDs, and executed locally. It did not yet own the standard microphone or audio player.

## Now

The Web SDK owns microphone capture, 16 kHz conversion, silence detection, transcript display, ordered audio playback, interruption, and action progress. This repository owns identity, runtime catalog access, evidence retrieval, configurable reasoning through native Anthropic or an OpenAI-compatible gateway, Sarvam STT/TTS, and correlated results.

The security boundary is simple: the cloud chooses _which approved journey_; the signed catalog and SDK determine _how the page is operated_. A cloud response cannot introduce a new selector or browser primitive.

## Unchanged

Core training code—including mapper, explorer, onboarding, journey planning, Playwright mapping, verification, selector editing, training UI, and training database behavior—is not imported or changed by this runtime. The only shared artifact is the versioned SDK contract package, consumed as a packed dependency.
