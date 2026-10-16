/**
 * Test double for the Web Speech API.
 *
 * jsdom ships neither `speechSynthesis` nor `SpeechSynthesisUtterance`, so
 * tests that exercise read-aloud behaviour install this mock and drive the
 * utterance callbacks by hand. Both globals are defined as configurable and
 * writable so `uninstallSpeechMock` can delete them again and a later test can
 * observe the "speech unsupported" code path.
 */
import { vi, type Mock } from "vitest";

/** Shape of the utterance objects handed to `speechSynthesis.speak`. */
export interface MockUtterance {
  text: string;
  lang: string;
  rate: number;
  pitch: number;
  volume: number;
  onstart: ((event?: unknown) => void) | null;
  onend: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

export interface SpeechMock {
  speak: Mock<(utterance: MockUtterance) => void>;
  cancel: Mock<() => void>;
  pause: Mock<() => void>;
  resume: Mock<() => void>;
  pending: Mock<() => boolean>;
  /** Every utterance passed to `speak`, in call order. */
  utterances: MockUtterance[];
  /** The most recently spoken utterance, or undefined when nothing was spoken. */
  lastUtterance(): MockUtterance | undefined;
}

export interface SpeechMockOptions {
  /** Install `speechSynthesis` only, leaving the utterance class undefined. */
  withoutUtterance?: boolean;
}

/** Stand-in for `SpeechSynthesisUtterance` that records its callbacks. */
class MockSpeechSynthesisUtterance implements MockUtterance {
  text: string;

  lang = "";

  rate = 1;

  pitch = 1;

  volume = 1;

  onstart: ((event?: unknown) => void) | null = null;

  onend: ((event?: unknown) => void) | null = null;

  onerror: ((event?: unknown) => void) | null = null;

  constructor(text = "") {
    this.text = text;
  }
}

let installed: SpeechMock | null = null;

/**
 * Define `window.speechSynthesis` and the global `SpeechSynthesisUtterance`,
 * returning the spies plus the recorded utterances.
 */
export function installSpeechMock(options: SpeechMockOptions = {}): SpeechMock {
  uninstallSpeechMock();

  const utterances: MockUtterance[] = [];
  const speak = vi.fn<(utterance: MockUtterance) => void>((utterance) => {
    utterances.push(utterance);
  });
  const pending = vi.fn<() => boolean>(() => utterances.length > 0);
  const mock: SpeechMock = {
    speak,
    cancel: vi.fn<() => void>(),
    pause: vi.fn<() => void>(),
    resume: vi.fn<() => void>(),
    pending,
    utterances,
    lastUtterance: () => utterances[utterances.length - 1],
  };

  Object.defineProperty(window, "speechSynthesis", {
    value: mock,
    configurable: true,
    writable: true,
  });

  if (!options.withoutUtterance) {
    Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
      value: MockSpeechSynthesisUtterance,
      configurable: true,
      writable: true,
    });
  }

  installed = mock;
  return mock;
}

/** Remove both globals so `isSpeechSupported()` reports false again. */
export function uninstallSpeechMock(): void {
  delete (window as { speechSynthesis?: unknown }).speechSynthesis;
  delete (globalThis as { SpeechSynthesisUtterance?: unknown })
    .SpeechSynthesisUtterance;
  installed = null;
}

/** The mock installed by the last `installSpeechMock()` call, if any. */
export function installedSpeechMock(): SpeechMock | null {
  return installed;
}
