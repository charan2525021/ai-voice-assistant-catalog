# @sable/web-sdk-ui

Optional Shadow DOM interface for `@sable/web-sdk`. It provides chat, status,
confirmation, Stop, and voice lifecycle hooks while keeping product CSS and
assistant CSS isolated.

The standard injected UI is an overlay, so it does not resize or mutate the
client page. Set `layout: "docked"` only when a client explicitly approves a
desktop sidebar. A caller-provided `host` never changes the surrounding page
layout. Final transcript messages and open/minimized state are restored from
the SDK's same-tab continuity record after an approved page change.

Voice input and output stay client-owned so deployments can use their approved
speech provider. The SDK marks voice turns and emits signed-server `speak`
events; the UI forwards those events to `speak` and calls `cancelSpeech` when
the user presses Stop, starts listening, destroys the UI, or the SDK fails:

```ts
mountSableUi(agent, {
  voice: {
    enabled: true,
    start: () => speechRecognizer.start(),
    stop: () => speechRecognizer.stop(),
    speak: (text, { voice }) => tts.speak(text, { voice }),
    cancelSpeech: () => tts.cancel(),
  },
});
```

The speech recognizer should pass each final transcript to
`agent.sendMessage(transcript, "voice")`; this is what asks the server to reply
with both text and a `speak` event. No microphone or audio is accessed unless
the client supplies these hooks and the end user grants the relevant browser
permission.

The UI uses `textContent` for page and model text. It never renders model HTML.
Pass `styleNonce` when the client CSP permits nonce-scoped inline styles, or
`stylesheetUrl` when styles must be loaded as a separately approved asset.
