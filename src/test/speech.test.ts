import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isSpeechSupported, speak, stopSpeaking } from "../lib/speech";
import {
  installSpeechMock,
  uninstallSpeechMock,
  type SpeechMock,
} from "./helpers/speech-mock";

describe("isSpeechSupported", () => {
  afterEach(() => {
    uninstallSpeechMock();
  });

  it("reports true when both speechSynthesis and SpeechSynthesisUtterance exist", () => {
    installSpeechMock();

    expect(isSpeechSupported()).toBe(true);
  });

  it("reports false when neither global exists", () => {
    uninstallSpeechMock();

    expect(isSpeechSupported()).toBe(false);
  });

  it("reports false when speechSynthesis exists but the utterance class does not", () => {
    installSpeechMock({ withoutUtterance: true });

    expect(isSpeechSupported()).toBe(false);
  });

  it("reports false when the utterance class exists but speechSynthesis does not", () => {
    Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
      value: class {},
      configurable: true,
      writable: true,
    });

    expect(isSpeechSupported()).toBe(false);
  });

  it("re-reads the globals on every call so a late-installed engine is picked up", () => {
    expect(isSpeechSupported()).toBe(false);

    installSpeechMock();

    expect(isSpeechSupported()).toBe(true);
  });
});

describe("speak", () => {
  let speech: SpeechMock;

  beforeEach(() => {
    speech = installSpeechMock();
  });

  afterEach(() => {
    uninstallSpeechMock();
  });

  it("cancels any in-flight utterance before speaking", () => {
    speak("hello");

    expect(speech.cancel).toHaveBeenCalledTimes(1);
    expect(speech.speak).toHaveBeenCalledTimes(1);
    expect(speech.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      speech.speak.mock.invocationCallOrder[0],
    );
  });

  it("passes the requested text to the utterance it speaks", () => {
    speak("Here is the plan");

    expect(speech.utterances).toHaveLength(1);
    expect(speech.utterances[0].text).toBe("Here is the plan");
    expect(speech.speak.mock.calls[0][0]).toBe(speech.utterances[0]);
  });

  it("calls onEnd when the utterance ends", () => {
    const onEnd = vi.fn();

    speak("hello", { onEnd });
    speech.lastUtterance()?.onend?.();

    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("calls onEnd when the utterance errors, so the button never sticks", () => {
    const onEnd = vi.fn();

    speak("hello", { onEnd });
    speech.lastUtterance()?.onerror?.({ error: "interrupted" });

    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("tolerates the browser firing both onend and onerror for one utterance", () => {
    const onEnd = vi.fn();

    speak("hello", { onEnd });
    const utterance = speech.lastUtterance();
    utterance?.onerror?.({ error: "canceled" });
    utterance?.onend?.();

    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it("fires end callbacks safely when no onEnd option was given", () => {
    speak("hello");
    const utterance = speech.lastUtterance();

    expect(() => {
      utterance?.onend?.();
      utterance?.onerror?.({ error: "canceled" });
    }).not.toThrow();
  });

  it("cancels the previous utterance when asked to speak again", () => {
    speak("first");
    speak("second");

    expect(speech.cancel).toHaveBeenCalledTimes(2);
    expect(speech.utterances.map((u) => u.text)).toEqual(["first", "second"]);
  });

  it("is a no-op that does not throw when speech is unsupported", () => {
    uninstallSpeechMock();
    const onEnd = vi.fn();

    expect(() => speak("hello", { onEnd })).not.toThrow();
    expect(onEnd).not.toHaveBeenCalled();
  });
});

describe("stopSpeaking", () => {
  afterEach(() => {
    uninstallSpeechMock();
  });

  it("cancels the speech engine when supported", () => {
    const speech = installSpeechMock();

    stopSpeaking();

    expect(speech.cancel).toHaveBeenCalledTimes(1);
    expect(speech.speak).not.toHaveBeenCalled();
  });

  it("is a no-op that does not throw when unsupported", () => {
    uninstallSpeechMock();

    expect(() => stopSpeaking()).not.toThrow();
  });
});
