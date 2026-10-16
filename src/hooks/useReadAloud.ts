import { useCallback, useEffect, useRef, useState } from "react";
import {
  isSpeechSupported,
  speak,
  stopSpeaking,
  toSpeakableText,
} from "../lib/speech";

export interface ReadAloud {
  supported: boolean;
  speakingMessageId: string | null;
  /** Starts reading `content` for `messageId`, or stops it if it is the one speaking. */
  toggle: (messageId: string, content: string) => void;
}

/** Read-aloud state for a list of messages: at most one message speaks at a time. */
export function useReadAloud(): ReadAloud {
  const [supported] = useState(isSpeechSupported);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  // Refs are written synchronously so rapid clicks never see a stale value.
  const speakingRef = useRef<string | null>(null);
  const utteranceTokenRef = useRef(0);

  const setSpeaking = useCallback((messageId: string | null) => {
    speakingRef.current = messageId;
    setSpeakingMessageId(messageId);
  }, []);

  const toggle = useCallback(
    (messageId: string, content: string) => {
      utteranceTokenRef.current += 1;
      if (speakingRef.current === messageId) {
        stopSpeaking();
        setSpeaking(null);
        return;
      }
      // Browsers fire a cancelled utterance's end event after the next one starts,
      // so only the latest utterance may clear the speaking state.
      const token = utteranceTokenRef.current;
      const onEnd = () => {
        if (utteranceTokenRef.current === token) setSpeaking(null);
      };
      speak(toSpeakableText(content), { onEnd });
      setSpeaking(messageId);
    },
    [setSpeaking],
  );

  useEffect(
    () => () => {
      if (speakingRef.current !== null) stopSpeaking();
    },
    [],
  );

  return { supported, speakingMessageId, toggle };
}
