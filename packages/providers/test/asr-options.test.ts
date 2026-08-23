import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidecarAsrProvider } from '../src/asr/sidecar.js';

/**
 * Stage 2b exit criterion 8 (ADR 0019 §5) — the wire format between P80 and the sidecar.
 *
 * The one place camelCase settings become the sidecar's snake_case fields. A setting that
 * is added on one side and not the other produces a value that silently never arrives, so
 * the field names are asserted here rather than trusted to a transformation.
 */
describe('the ASR sidecar request body', () => {
  const body = () => {
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
  };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          words: [],
          detected_language: 'de',
          language_probability: 0.99,
          duration_ms: 0,
          warnings: [],
          model_id: 'medium',
          alignment_model_id: null,
        }),
      ),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends every option in the sidecar’s own field names', async () => {
    const provider = new SidecarAsrProvider('http://127.0.0.1:5181');
    await provider.transcribe({
      mediaPath: '/library/a.mp4',
      language: 'de',
      options: {
        model: 'medium',
        device: 'cpu',
        computeType: 'int8',
        requireGpu: false,
        align: false,
        languageMinProbability: 0.75,
        conditionOnPreviousText: false,
      },
    });

    expect(body()).toEqual({
      media_path: '/library/a.mp4',
      language: 'de',
      options: {
        model: 'medium',
        device: 'cpu',
        compute_type: 'int8',
        require_gpu: false,
        align: false,
        language_min_probability: 0.75,
        condition_on_previous_text: false,
      },
    });
  });

  it('omits the key entirely when no options are given', async () => {
    // Absent means "use your own default" on the sidecar side. Sending nulls would make
    // the same meaning arrive through a second code path, and the two would drift.
    const provider = new SidecarAsrProvider('http://127.0.0.1:5181');
    await provider.transcribe({ mediaPath: '/library/a.mp4', language: 'de' });

    expect(body()).toEqual({ media_path: '/library/a.mp4', language: 'de' });
    expect('options' in body()).toBe(false);
  });

  it('does not send `false` as if it were absent', async () => {
    // The setting whose entire purpose is being turned off. A truthiness check anywhere in
    // this path would drop it and leave the GPU refusal in force.
    const provider = new SidecarAsrProvider('http://127.0.0.1:5181');
    await provider.transcribe({
      mediaPath: '/library/a.mp4',
      language: 'de',
      options: {
        model: 'large-v3',
        device: 'cuda',
        computeType: 'float16',
        requireGpu: false,
        align: false,
        languageMinProbability: 0,
        conditionOnPreviousText: false,
      },
    });

    const options = body().options as Record<string, unknown>;
    expect(options.require_gpu).toBe(false);
    expect(options.align).toBe(false);
    expect(options.language_min_probability).toBe(0);
    expect(options.condition_on_previous_text).toBe(false);
  });
});
