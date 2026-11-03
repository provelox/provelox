const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Re-frames the API's log events ({ts, stream, text}) as the console's ({line, stream}). SSE events are separated by
 * a blank line and can be split anywhere between network chunks, so incomplete ones are kept until they finish.
 * Comments (":ping") and the "end" event pass through unchanged.
 */
export function reframe(): TransformStream<Uint8Array, Uint8Array> {
  let buffer = '';
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const ev of events) {
        const data = ev.startsWith('data: ') ? ev.slice(6) : null;
        if (data === null) {
          controller.enqueue(encoder.encode(`${ev}\n\n`));
          continue;
        }
        try {
          const d = JSON.parse(data) as {
            text: string;
            stream: 'stdout' | 'stderr';
          };
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ line: d.text, stream: d.stream })}\n\n`,
            ),
          );
        } catch {
          // a malformed event is dropped rather than breaking the stream
        }
      }
    },
  });
}
