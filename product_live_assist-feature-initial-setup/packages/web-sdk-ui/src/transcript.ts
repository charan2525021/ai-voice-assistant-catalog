export interface TranscriptMessageUpdate {
  key: string;
  role: "assistant" | "user";
  text: string;
  partial: boolean;
}

/**
 * Gives every live transcript a stable message key. Partial speech therefore
 * updates one visible bubble instead of adding a new bubble for every fragment.
 */
export class ConversationTranscript {
  private voiceUtteranceKey?: string;
  private voiceUtteranceNumber = 0;

  userVoice(text: string, final: boolean): TranscriptMessageUpdate {
    this.voiceUtteranceKey ??= `user:voice:${++this.voiceUtteranceNumber}`;
    const key = this.voiceUtteranceKey;
    if (final) this.voiceUtteranceKey = undefined;
    return { key, role: "user", text, partial: !final };
  }

  assistant(turnId: string, text: string, partial: boolean): TranscriptMessageUpdate {
    return { key: `assistant:${turnId}`, role: "assistant", text, partial };
  }

  journeyNarration(turnId: string, journeyId: string, stepId: string, text: string): TranscriptMessageUpdate {
    return { key: `assistant:${turnId}:journey:${journeyId}:${stepId}`, role: "assistant", text, partial: false };
  }
}
